import { OWED_LIST, PRIORITY_LABELS } from "@doit/core/tools.js";
import { esc, publishHome, title } from "./home.js";
import { logError } from "./http.js";
import { getSetting, setSetting } from "./settings.js";
import { env, slackApi } from "./slack.js";

const WINDOW_MS = 60000;
const LOCK = "select pg_advisory_xact_lock(4243)";
const feedChannel = () => process.env.SLACK_FEED_CHANNEL;
const pri = p => (p && PRIORITY_LABELS[p] ? ` ${PRIORITY_LABELS[p]}` : "");
const isClaude = text => /^\s*claude:/.test(text || "");
const KIND = { added: "+", changed: "~", removed: "−" };

function batchText(body) {
    const lines = body.lines.map(l => `${KIND[l.kind] || "~"} ${esc(title({ text: l.text }))}${pri(l.priorities)}`);
    if (body.claude) lines.push(`${body.claude} claude: item${body.claude === 1 ? "" : "s"}`);
    return { text: `*${esc(body.host)}* · ${esc(body.list)}\n${lines.join("\n")}`, blocks: [] };
}

function owedMessage(body) {
    const head = `*owed* · ${esc(body.list)}`;
    if (body.removed) return { text: `${head}\n~${esc(title(body))}~ deleted`, blocks: [] };
    if (body.done) return { text: `${head}\n~${esc(title(body))}~ done`, blocks: [] };
    const text = `${head}\n${body.in_progress ? "▶ " : ""}${esc(title(body))}${pri(body.priorities)}`;
    const value = JSON.stringify({ list: body.list, id: body.id });
    return {
        text,
        blocks: [
            { type: "section", text: { type: "mrkdwn", text } },
            {
                type: "actions",
                elements: [
                    { type: "button", action_id: "feed:done", text: { type: "plain_text", text: "Done" }, value, style: "primary" },
                    { type: "button", action_id: "feed:start", text: { type: "plain_text", text: body.in_progress ? "Stop" : "Start" }, value },
                    { type: "button", action_id: "feed:notes", text: { type: "plain_text", text: "Notes" }, value },
                ],
            },
        ],
    };
}

async function upsertMessage(client, key, body, render, existing) {
    const channel = feedChannel();
    const msg = render(body);
    if (existing) {
        await slackApi("chat.update", { channel: existing.channel, ts: existing.ts, text: msg.text, blocks: msg.blocks || [] });
        await client.query("update feed_messages set body = $2, updated_at = now() where key = $1", [key, JSON.stringify(body)]);
        return;
    }
    const posted = await slackApi("chat.postMessage", { channel, text: msg.text, blocks: msg.blocks || [] });
    if (!posted.ok || !posted.ts) return;
    await client.query(
        "insert into feed_messages (key, channel, ts, body) values ($1, $2, $3, $4) on conflict (key) do update set channel = excluded.channel, ts = excluded.ts, body = excluded.body, updated_at = now()",
        [key, posted.channel || channel, posted.ts, JSON.stringify(body)],
    );
}

// Walks events past the feed cursor once, under its own lock: Claude's changes (source mcp) post or
// extend one message per host and list per minute, owed twins get their own message with buttons,
// and any source's change to an item that has a message edits that message.
export async function runFeed(pool) {
    if (!feedChannel() || !env().token) return { posted: 0 };
    const client = await pool.connect();
    let touchedLists = new Set();
    try {
        await client.query("begin");
        await client.query(LOCK);
        const cursor = Number(await getSetting(client, "feed_cursor", 0));
        const muted = new Set(await getSetting(client, "feed_mute", []));
        // a backlog older than ten minutes (the channel was just configured, the feed was down) never floods the channel
        const { rows } = await client.query(
            "select id, at, host, source, list, todo_id, payload from events where id > $1 and at > now() - interval '10 minutes' order by id",
            [cursor],
        );
        const top = Number((await client.query("select coalesce(max(id), 0) as id from events")).rows[0].id);
        let posted = 0;
        for (const ev of rows) {
            touchedLists.add(ev.list);
            const p = ev.payload || {};
            const itemKey = `item:${ev.todo_id}`;
            const item = (await client.query("select channel, ts, body from feed_messages where key = $1", [itemKey])).rows[0];
            if (item) {
                const body = { ...item.body, text: p.text ?? item.body.text, done: Boolean(p.done), in_progress: Boolean(p.in_progress), priorities: p.priorities ?? null, removed: p.kind === "removed" };
                await upsertMessage(client, itemKey, body, owedMessage, item);
                continue;
            }
            if (ev.source !== "mcp" || muted.has(ev.list)) continue;
            if (ev.list === OWED_LIST && p.twin && p.kind === "added") {
                await upsertMessage(client, itemKey, { list: ev.list, id: ev.todo_id, text: p.text, priorities: p.priorities ?? null, done: Boolean(p.done), in_progress: Boolean(p.in_progress) }, owedMessage, null);
                posted++;
                continue;
            }
            const batchKey = `batch:${ev.host}:${ev.list}`;
            const batch = (await client.query("select channel, ts, body, updated_at from feed_messages where key = $1 and updated_at > now() - ($2 || ' milliseconds')::interval", [batchKey, String(WINDOW_MS)])).rows[0];
            const body = batch ? batch.body : { host: ev.host, list: ev.list, lines: [], claude: 0 };
            if (isClaude(p.text)) body.claude = (body.claude || 0) + 1;
            else body.lines = [...(body.lines || []), { kind: p.kind, text: p.text, priorities: p.priorities ?? null }].slice(-20);
            await upsertMessage(client, batchKey, body, batchText, batch || null);
            if (!batch) posted++;
        }
        if (top > cursor) await setSetting(client, "feed_cursor", top);
        const homeList = await getSetting(client, "home_list", "daily");
        await client.query("commit");
        return { posted, events: rows.length, home: touchedLists.has(homeList) };
    } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

// after any applied op: the feed, then the home tab when its list changed
export async function settle(pool, lists = []) {
    try {
        const r = await runFeed(pool);
        let home = r.home;
        if (!home && lists.length) {
            const client = await pool.connect();
            try {
                home = lists.includes(await getSetting(client, "home_list", "daily"));
            } finally {
                client.release();
            }
        }
        if (home && env().token) await publishHome(pool);
    } catch (err) {
        logError("feed", err);
    }
}
