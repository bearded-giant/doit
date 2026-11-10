import { createHash, createHmac, timingSafeEqual } from "crypto";
import { parseTodoText } from "@doit/core/todo-text.js";
import { loadPgStore } from "./pgStore.js";
import { applyOps } from "./runner.js";
import { logError } from "./http.js";
import { getSetting, setSetting } from "./settings.js";

export const PRIVATE = "This app is private.";
export const usage = cur => [
    `*doit* · current list: *${cur}*`,
    "",
    "*See*",
    "`/doit`  pending items on the current list",
    "`/doit ls <list>`  pending items on another list",
    "`/doit lists`  every list",
    "`/doit find <words>`  search every list",
    "",
    "*Switch*",
    "`/doit use <list>`  make it the current list; the Home tab follows",
    "",
    "*Add*",
    "`/doit add <text>`  add to the current list",
    "`/doit add renew cert !! @auth due:2026-12-01`  `!` important, `!!` urgent, `!!!` critical; `@list` picks another list",
    "",
    "*Change*  (pick an item by words from its text, `#rank`, or id)",
    "`/doit done <item>`  also `start`, `reopen`, and `rm` (rm asks first)",
    "`/doit mv <item> @list`  move it to another list",
    "`/doit note #3 <text>`  append a note (item by `#rank` or id)",
    "",
    "*Lists*",
    "`/doit list add <name>`,  `/doit list rename <old> <new>`,  `/doit list rm <name>`",
    "",
    "A DM to the app adds its text to *daily* as a new item.",
].join("\n");

export const env = () => ({
    token: process.env.SLACK_BOT_TOKEN,
    secret: process.env.SLACK_SIGNING_SECRET,
    owner: process.env.SLACK_OWNER_ID,
    api: process.env.SLACK_API_URL || "https://slack.com/api",
    tz: process.env.DOIT_TZ || "UTC",
});

// v0=HMAC-SHA256(secret, "v0:<timestamp>:<raw body>"), timestamp within five minutes
export function verifySlack(headers, body, secret, now = Date.now()) {
    const ts = Number(headers.get("x-slack-request-timestamp"));
    const given = headers.get("x-slack-signature") || "";
    if (!secret || !ts || Math.abs(now / 1000 - ts) > 300) return false;
    const mine = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
    return mine.length === given.length && timingSafeEqual(Buffer.from(mine), Buffer.from(given));
}

// one op id per Slack delivery, so a retried event or a double click applies once
const NS = Buffer.from("8f3c0a3e5d1b4e6f9a2c7d8e1f0b3a4c", "hex");
export function uuidv5(name) {
    const h = createHash("sha1").update(NS).update(name).digest();
    h[6] = (h[6] & 0x0f) | 0x50;
    h[8] = (h[8] & 0x3f) | 0x80;
    const x = h.subarray(0, 16).toString("hex");
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

const PRIORITY = { "!": "important", "!!": "urgent", "!!!": "critical" };
export function parseMarkers(text) {
    const out = { text: [] };
    for (const tok of (text || "").trim().split(/\s+/).filter(Boolean)) {
        if (PRIORITY[tok]) out.priority = PRIORITY[tok];
        else if (/^@[\w.-]+$/.test(tok)) out.list = tok.slice(1);
        else if (/^due:\d{4}-\d{2}-\d{2}$/.test(tok)) out.due = tok.slice(4);
        else out.text.push(tok);
    }
    return { ...out, text: out.text.join(" ") };
}

export async function slackApi(method, body) {
    const { api, token } = env();
    const res = await fetch(`${api}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) logError(`slack:${method}`, new Error(json.error || `http ${res.status}`), json.response_metadata?.messages ? { details: json.response_metadata.messages } : {});
    return json;
}

export async function applySlackOp(pool, opId, tool, args, tz = env().tz) {
    const [r] = await applyOps(pool, [{ op_id: opId, ts: Date.now(), tz, source: "slack", tool, args }], { host: "slack" });
    return r;
}

const codeBlock = s => `\`\`\`\n${s}\n\`\`\``;
const title = t => (t.text || "").split("\n")[0];
const opButton = (label, tool, args, style) => ({
    type: "button", text: { type: "plain_text", text: label.slice(0, 75) }, action_id: `doit:${tool}`, value: JSON.stringify({ tool, args }), ...(style ? { style } : {}),
});
const buttons = (text, elements) => ({
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }, { type: "actions", elements: elements.slice(0, 25) }],
});

// #rank (in the hinted list, else daily), an id anywhere, or words across every pending item
export async function resolveRef(pool, ref, listHint, rankList = "daily") {
    const client = await pool.connect();
    try {
        const store = await loadPgStore(client);
        ref = (ref || "").trim();
        const byId = store.findListByTodoId(ref);
        if (byId) return { hits: [{ list: byId.name, todo: byId.data.todos.find(t => t.id === ref) }] };
        const rank = /^#?(\d+)$/.exec(ref);
        if (rank) {
            const list = listHint || rankList;
            const todo = (store.getList(list)?.todos || []).find(t => parseTodoText(t.text).rank === Number(rank[1]));
            return { hits: todo ? [{ list, todo }] : [] };
        }
        const words = ref.toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return { hits: [] };
        const hits = [];
        for (const list of listHint ? [listHint] : store.listNames()) {
            for (const todo of store.getList(list)?.todos || []) {
                const hay = (todo.text || "").toLowerCase();
                if (!todo.done && words.every(w => hay.includes(w))) hits.push({ list, todo });
            }
        }
        return { hits };
    } finally {
        client.release();
    }
}

const notFound = name => `No list named "${name}". \`/doit lists\` shows them all.`;

const REF_TOOLS = { done: "complete_todo", start: "start_todo", reopen: "revert_todo", rm: "delete_todo" };

const listExists = async (client, name) => (await client.query("select 1 from lists where name = $1 and deleted_at is null", [name])).rowCount > 0;

async function withClient(pool, fn) {
    const client = await pool.connect();
    try {
        return await fn(client);
    } finally {
        client.release();
    }
}

// the Home tab's list is the current list; one renamed or deleted since falls back to daily
const currentList = pool => withClient(pool, async client => {
    const name = await getSetting(client, "home_list", "daily");
    return (await listExists(client, name)) ? name : "daily";
});

// one slash command -> one op (or an ephemeral answer); several matches come back as buttons;
// `lists` names the lists whose Home view the caller should refresh
export async function runCommand(pool, text, { opId, tz }) {
    const [verb = "", ...rest] = (text || "").trim().split(/\s+/).filter(Boolean);
    const tail = rest.join(" ");
    const cur = await currentList(pool);
    const run = async (tool, args, { code = false, limit } = {}) => {
        const r = await applySlackOp(pool, opId, tool, args, tz);
        if (r.status === "failed") return { text: r.error.replace(/^List "([^"]+)" not found at \S+$/, (_, name) => notFound(name)) };
        let out = r.text || "Done.";
        if (limit) {
            const lines = out.split("\n");
            if (lines.length > limit) out = `${lines.slice(0, limit).join("\n")}\n…`;
        }
        return { text: code ? codeBlock(out) : out };
    };
    const withRef = async (ref, listHint, make, { confirm } = {}) => {
        const { hits } = await resolveRef(pool, ref, listHint, cur);
        if (!hits.length) return { text: `No open item matches "${ref}".` };
        const [tool, args] = make(hits[0]);
        if (hits.length === 1 && !confirm) return run(tool, args);
        if (hits.length === 1) return buttons(`${confirm} *${title(hits[0].todo)}* (${hits[0].list})?`, [opButton(confirm.split(" ")[0], tool, args, "danger")]);
        return buttons(`"${ref}" matches ${hits.length} items. Which one?`, hits.map(h => {
            const [t, a] = make(h);
            return opButton(`${h.list}: ${title(h.todo)}`, t, a);
        }));
    };
    switch (verb) {
        case "":
            return run("list_todos", { list: cur, filter: "pending" }, { code: true, limit: 16 });
        case "use": {
            const name = rest[0];
            if (!name) return { text: `Current list: *${cur}*` };
            const found = await withClient(pool, async client => (await listExists(client, name)) && (await setSetting(client, "home_list", name), true));
            if (!found) return { text: notFound(name) };
            return { text: `Current list: *${name}*`, lists: [name] };
        }
        case "ls":
            if (rest[0] !== "lists" || (await withClient(pool, client => listExists(client, "lists")))) {
                return run("list_todos", { list: rest[0] || cur, filter: "pending" }, { code: true });
            }
        // falls through: `ls lists` means `lists` unless a list is named that
        case "lists":
            return { text: `Current list: *${cur}*\n${(await run("list_lists", {}, { code: true })).text}` };
        case "find":
            if (!tail) return { text: usage(cur) };
            return run("search_todos", { query: tail }, { code: true });
        case "add": {
            const m = parseMarkers(tail);
            if (!m.text) return { text: usage(cur) };
            return run("add_todo", { list: m.list || cur, text: m.text, priority: m.priority, due: m.due });
        }
        case "done":
        case "start":
        case "reopen":
        case "rm": {
            const m = parseMarkers(tail);
            if (!m.text) return { text: usage(cur) };
            const tool = REF_TOOLS[verb];
            return withRef(m.text, m.list, h => [tool, { list: h.list, id: h.todo.id }], verb === "rm" ? { confirm: "Delete" } : {});
        }
        case "mv": {
            const m = parseMarkers(tail);
            if (!m.text || !m.list) return { text: usage(cur) };
            return withRef(m.text, undefined, h => ["move_todo", { from_list: h.list, id: h.todo.id, to_list: m.list }]);
        }
        case "note": {
            const [ref, ...note] = rest;
            if (!ref || !note.length) return { text: usage(cur) };
            return withRef(ref, undefined, h => ["add_note", { list: h.list, id: h.todo.id, note: note.join(" ") }]);
        }
        case "list": {
            const [sub, a, b] = rest;
            if (sub === "add" && a) return run("create_list", { name: a, source: "user" });
            if (sub === "rename" && a && b) return run("rename_list", { old_name: a, new_name: b });
            if (sub === "rm" && a) return buttons(`Delete list *${a}* and everything in it?`, [opButton("Delete", "delete_list", { name: a }, "danger")]);
            return { text: usage(cur) };
        }
        case "help":
            return { text: usage(cur) };
        default:
            return { text: `Unknown command \`${verb}\`.\n\n${usage(cur)}` };
    }
}

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const ok = () => new Response("", { status: 200 });
