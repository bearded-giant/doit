// Signature, parser and op ids run everywhere; the route scenarios from specs/slack-app/spec.md
// need the test Postgres (see server.test.mjs) and skip, loudly, without one.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import pg from "pg";
import { parseMarkers, uuidv5, verifySlack } from "./lib/slack.js";

const SECRET = "shhh";
const sign = (body, ts = Math.floor(Date.now() / 1000)) => new Headers({
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`,
    "content-type": "application/x-www-form-urlencoded",
});

// signature: right secret, fresh timestamp, exact body
{
    const body = "token=x&text=add+milk";
    assert.equal(verifySlack(sign(body), body, SECRET), true);
    assert.equal(verifySlack(sign(body), body, "other"), false);
    assert.equal(verifySlack(sign(body), `${body}&more=1`, SECRET), false);
    assert.equal(verifySlack(sign(body, Math.floor(Date.now() / 1000) - 600), body, SECRET), false, "older than five minutes");
    assert.equal(verifySlack(new Headers(), body, SECRET), false);
    assert.equal(verifySlack(sign(body), body, undefined), false, "no secret configured");
}

// markers: priority bangs, @list, due:, anywhere in the text
{
    assert.deepEqual(parseMarkers("renew cert !! @auth due:2026-12-01"), { text: "renew cert", priority: "urgent", list: "auth", due: "2026-12-01" });
    assert.deepEqual(parseMarkers("!!! fix prod"), { text: "fix prod", priority: "critical" });
    assert.deepEqual(parseMarkers("  plain   words "), { text: "plain words" });
    assert.deepEqual(parseMarkers("ping me@example.com !"), { text: "ping me@example.com", priority: "important" });
}

// op ids: stable per delivery key, valid v5 uuids, distinct per key
{
    assert.equal(uuidv5("event:Ev1"), uuidv5("event:Ev1"));
    assert.notEqual(uuidv5("event:Ev1"), uuidv5("event:Ev2"));
    assert.match(uuidv5("x"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}

const URL_ = process.env.TEST_DATABASE_URL || "postgres://postgres:doit@127.0.0.1:54329/doit";
const pool = new pg.Pool({ connectionString: URL_ });
try {
    await pool.query("select 1");
} catch (err) {
    console.log(`slack: unit ok; routes skipped (no Postgres at ${URL_}: ${err.message})`);
    await pool.end();
    process.exit(0);
}
const { migrate } = await import("./lib/db.js");
const { createServer } = await import("./dev.js");
{
    const c = await pool.connect();
    await c.query("drop schema public cascade; create schema public");
    await migrate(c);
    c.release();
}

// a fake Slack API that records every call
const calls = [];
const fakeSlack = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, body: JSON.parse(raw || "{}") });
    res.setHeader("content-type", "application/json");
    const extra = req.url === "/chat.postMessage" ? { channel: "CFEED", ts: `${Date.now() / 1000}` } : req.url === "/chat.getPermalink" ? { permalink: "https://slack.example/p1" } : {};
    res.end(JSON.stringify({ ok: true, ...extra }));
});
await new Promise(r => fakeSlack.listen(0, r));
const slackBase = `http://127.0.0.1:${fakeSlack.address().port}`;
const waitFor = async (pred, ms = 3000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (pred()) return true;
        await new Promise(r => setTimeout(r, 20));
    }
    return false;
};
// background work (settle after an interaction) may still be calling Slack; let it finish before the next step clears the log
const quiet = async () => {
    let len;
    do {
        len = calls.length;
        await new Promise(r => setTimeout(r, 200));
    } while (calls.length !== len);
};

Object.assign(process.env, { DATABASE_URL: URL_, SLACK_SIGNING_SECRET: SECRET, SLACK_OWNER_ID: "UOWNER", SLACK_BOT_TOKEN: "xoxb-test", SLACK_API_URL: slackBase, DOIT_TZ: "UTC" });
const server = createServer();
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (route, body, headers = sign(body)) => {
    const res = await fetch(`${base}${route}`, { method: "POST", headers, body });
    const text = await res.text();
    return { status: res.status, text, json: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
};
const form = o => new URLSearchParams(o).toString();
let trigger = 0;
const command = (text, user = "UOWNER") => post("/api/slack/commands", form({ user_id: user, text, trigger_id: `T${++trigger}` }));
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

// Coworker runs /doit
{
    const r = await command("add buy milk", "UOTHER");
    assert.equal(r.json.text, "This app is private.");
    assert.equal((await one("select count(*) as n from applied_ops")).n, "0", "no op ran");
    assert.equal((await post("/api/slack/commands", form({ user_id: "UOWNER", text: "ls" }), sign("tampered"))).status, 401);
}

// Add with markers: priority, due, the owner's list, no rank, source slack
{
    assert.match((await command("list add daily")).json.text, /daily/);
    assert.match((await command("list add auth")).json.text, /auth/);
    assert.match((await command("add nowhere @missing")).json.text, /not found/, "lists are made on purpose, not by a typo");
    const r = await command("add renew cert !! @auth due:2026-12-01");
    assert.equal(r.status, 200);
    assert.equal(r.json.response_type, "ephemeral");
    assert.match(r.json.text, /\[id:/);
    const auth = await one("select doc from lists where name = 'auth'");
    const [todo] = auth.doc.todos;
    assert.equal(todo.text, "renew cert");
    assert.equal(todo.priorities, "urgent");
    assert.equal(todo.due_date, "2026-12-01");
    assert.equal(todo.source, "slack");
    const applied = await one("select host, source from applied_ops order by applied_at desc limit 1");
    assert.deepEqual(applied, { host: "slack", source: "slack" });
}

// ls, lists, find come back as code blocks; done by words; several matches become buttons
{
    await command("add first thing");
    await command("add second thing");
    const ls = await command("ls");
    assert.match(ls.json.text, /^```\n[\s\S]*first thing[\s\S]*```$/);
    assert.match((await command("lists")).json.text, /auth/);
    assert.match((await command("find renew")).json.text, /renew cert/);
    const pick = await command("done thing");
    assert.equal(pick.json.blocks[1].type, "actions");
    assert.equal(pick.json.blocks[1].elements.length, 2);
    const value = JSON.parse(pick.json.blocks[1].elements[0].value);
    assert.equal(value.tool, "complete_todo");
    assert.equal(value.args.list, "daily");
    const done = await command("done first");
    assert.match(done.json.text, /Completed/);
    assert.equal((await one("select doc from lists where name = 'daily'")).doc.todos.find(t => t.text === "first thing").done, true);
    assert.match((await command("done nothing-like-this")).json.text, /No open item/);
    assert.match((await command("frobnicate")).json.text, /^\/doit/);
}

// rm asks first; the button carries the op and applies once per click
{
    const ask = await command("rm second");
    const [button] = ask.json.blocks[1].elements;
    assert.equal(button.style, "danger");
    assert.equal((await one("select doc from lists where name = 'daily'")).doc.todos.some(t => t.text === "second thing"), true, "nothing deleted yet");
    const payload = JSON.stringify({
        type: "block_actions", user: { id: "UOWNER" }, response_url: `${slackBase}/response_url`,
        actions: [{ action_id: button.action_id, value: button.value, action_ts: "1700000000.000100" }],
    });
    const r = await post("/api/slack/interactions", form({ payload }));
    assert.equal(r.status, 200);
    assert.ok(await waitFor(() => calls.some(c => c.path === "/response_url")));
    assert.match(calls.find(c => c.path === "/response_url").body.text, /Deleted/);
    assert.equal((await one("select doc from lists where name = 'daily'")).doc.todos.some(t => t.text === "second thing"), false);
    const other = JSON.parse(payload);
    other.user.id = "UOTHER";
    assert.equal((await post("/api/slack/interactions", form({ payload: JSON.stringify(other) }))).json.text, "This app is private.");
}

// mv, note, list add|rename|rm
{
    await command("list add proj");
    assert.ok(await one("select 1 from lists where name = 'proj'"));
    assert.match((await command("mv renew @proj")).json.text, /Moved/);
    const [moved] = (await one("select doc from lists where name = 'proj'")).doc.todos;
    assert.equal(moved.text, "renew cert");
    assert.match((await command(`note ${moved.id} context here`)).json.text, /Note added/);
    assert.match((await one("select doc from lists where name = 'proj'")).doc.todos[0].description, /context here/);
    assert.match((await command("list rename proj proj2")).json.text, /proj2/);
    const ask = await command("list rm proj2");
    assert.equal(JSON.parse(ask.json.blocks[1].elements[0].value).tool, "delete_list");
}

// events: URL verification, bot and subtype ignored, DM captured with a reaction, retry applies once
{
    const challenge = JSON.stringify({ type: "url_verification", challenge: "abc" });
    assert.equal((await post("/api/slack/events", challenge, sign(challenge))).json.challenge, "abc");
    const before = (await one("select count(*) as n from applied_ops")).n;
    const bot = JSON.stringify({ type: "event_callback", event_id: "EvBot", event: { type: "message", channel_type: "im", bot_id: "B1", user: "UOWNER", text: "digest", channel: "D1", ts: "1.1" } });
    assert.equal((await post("/api/slack/events", bot, sign(bot))).status, 200);
    const edit = JSON.stringify({ type: "event_callback", event_id: "EvEdit", event: { type: "message", channel_type: "im", subtype: "message_changed", user: "UOWNER", text: "x", channel: "D1", ts: "1.2" } });
    await post("/api/slack/events", edit, sign(edit));
    const stranger = JSON.stringify({ type: "event_callback", event_id: "EvStr", event: { type: "message", channel_type: "im", user: "UOTHER", text: "mine", channel: "D2", ts: "1.3" } });
    await post("/api/slack/events", stranger, sign(stranger));
    await new Promise(r => setTimeout(r, 200));
    assert.equal((await one("select count(*) as n from applied_ops")).n, before, "none of those ran an op");
    const dm = JSON.stringify({ type: "event_callback", event_id: "Ev1", event: { type: "message", channel_type: "im", user: "UOWNER", text: "call the bank !", channel: "D1", ts: "1700000000.000200" } });
    const r = await post("/api/slack/events", dm, sign(dm));
    assert.equal(r.status, 200);
    assert.ok(await waitFor(() => calls.some(c => c.path === "/reactions.add")));
    assert.deepEqual(calls.find(c => c.path === "/reactions.add").body, { channel: "D1", timestamp: "1700000000.000200", name: "white_check_mark" });
    const retry = await post("/api/slack/events", dm, { ...Object.fromEntries(sign(dm)), "x-slack-retry-num": "1" });
    assert.equal(retry.status, 200);
    await new Promise(r => setTimeout(r, 300));
    const daily = (await one("select doc from lists where name = 'daily'")).doc;
    const banks = daily.todos.filter(t => t.text === "call the bank");
    assert.equal(banks.length, 1, "retried event applied once");
    assert.equal(banks[0].priorities, "important");
    assert.equal(banks[0].source, "slack");
}

// Home tab: owner's items before Claude's, in progress first; list switch; overflow and modals
const { applyOps } = await import("./lib/runner.js");
const { mintToken } = await import("./lib/auth.js");
let n = 0;
const mcpOp = (tool, args, host = "devbox", source = "mcp") => applyOps(pool, [{ op_id: uuidv5(`test:${++n}`), ts: Date.now(), tz: "UTC", source, tool, args }], { host });
const interact = payload => post("/api/slack/interactions", form({ payload: JSON.stringify({ user: { id: "UOWNER" }, trigger_id: `TR${++n}`, ...payload }) }));
const sections = view => view.blocks.filter(b => b.type === "section").map(b => b.text.text);
{
    process.env.SLACK_FEED_CHANNEL = "CFEED";
    calls.length = 0;
    await mcpOp("add_todo", { list: "daily", text: "claude task", type: "chore" });
    await mcpOp("add_todo", { list: "daily", text: "walk the dog" }, "laptop", "user");
    await mcpOp("add_todo", { list: "daily", text: "water plants" }, "laptop", "user");
    await mcpOp("start_todo", { list: "daily", id: (await one("select doc from lists where name = 'daily'")).doc.todos.find(t => t.text === "walk the dog").id }, "laptop", "user");
    calls.length = 0;
    const home = JSON.stringify({ type: "event_callback", event_id: "EvHome", event: { type: "app_home_opened", user: "UOWNER" } });
    await post("/api/slack/events", home, sign(home));
    assert.ok(await waitFor(() => calls.some(c => c.path === "/views.publish")));
    const view = calls.find(c => c.path === "/views.publish").body.view;
    assert.equal(view.type, "home");
    assert.equal(calls.find(c => c.path === "/views.publish").body.user_id, "UOWNER");
    const texts = sections(view);
    assert.match(texts[0], /▶ .*walk the dog/, "in progress first");
    assert.ok(texts.findIndex(t => /call the bank/.test(t)) < texts.findIndex(t => /claude task/.test(t)), "mine before claude");
    assert.ok(texts.findIndex(t => /water plants/.test(t)) > texts.findIndex(t => /call the bank/.test(t)) && texts.some(t => /water plants/.test(t)), "priority before none");
    assert.ok(view.blocks.length <= 100);
    for (const b of view.blocks) if (b.accessory?.type === "overflow") assert.ok(b.accessory.options.length <= 5, "slack caps overflow menus at 5 options");
    assert.equal(view.blocks[0].elements[0].initial_option.value, "daily");

    calls.length = 0;
    await interact({ type: "block_actions", actions: [{ action_id: "home:list", selected_option: { value: "auth" }, action_ts: `${++n}.1` }] });
    assert.ok(await waitFor(() => calls.some(c => c.path === "/views.publish")));
    assert.match(calls.find(c => c.path === "/views.publish").body.view.blocks[1].elements[0].text, /· auth$/);
    assert.equal((await one("select value from settings where key = 'home_list'")).value, "auth");

    await quiet();
    calls.length = 0;
    await mcpOp("add_todo", { list: "auth", text: "renew cert", priority: "urgent" }, "laptop", "user");
    const authItem = (await one("select doc from lists where name = 'auth'")).doc.todos[0];
    await interact({ type: "block_actions", actions: [{ action_id: "home:item", selected_option: { value: JSON.stringify({ a: "start", list: "auth", id: authItem.id }) }, action_ts: `${++n}.2` }] });
    assert.ok(await waitFor(() => calls.some(c => c.path === "/views.publish")));
    assert.equal((await one("select doc from lists where name = 'auth'")).doc.todos[0].in_progress, true);
    assert.match(sections(calls.find(c => c.path === "/views.publish").body.view)[0], /^▶ /);

    await quiet();
    calls.length = 0;
    await interact({ type: "block_actions", actions: [{ action_id: "home:item", selected_option: { value: JSON.stringify({ a: "edit", list: "auth", id: authItem.id }) }, action_ts: `${++n}.3` }] });
    assert.ok(await waitFor(() => calls.some(c => c.path === "/views.open")));
    const modal = calls.find(c => c.path === "/views.open").body.view;
    assert.equal(modal.callback_id, "item_modal");
    assert.deepEqual(JSON.parse(modal.private_metadata), { mode: "edit", list: "auth", id: authItem.id });
    assert.equal(modal.blocks[0].element.initial_value, "renew cert");
    const saved = await interact({
        type: "view_submission",
        view: { id: "V1", hash: "h1", callback_id: "item_modal", private_metadata: modal.private_metadata, state: { values: {
            title: { v: { value: "renew the cert" } }, list: { v: { selected_option: { value: "auth" } } }, priority: { v: { selected_option: { value: "critical" } } },
            due: { v: { selected_date: "2026-12-24" } }, notes: { v: { value: "ask ops" } },
        } } },
    });
    assert.deepEqual(saved.json, { response_action: "clear" });
    const edited = (await one("select doc from lists where name = 'auth'")).doc.todos[0];
    assert.equal(edited.text, "renew the cert");
    assert.equal(edited.priorities, "critical");
    assert.equal(edited.due_date, "2026-12-24");
    assert.match(edited.description, /ask ops/);
    const bad = await interact({ type: "view_submission", view: { id: "V2", hash: "h2", callback_id: "item_modal", private_metadata: JSON.stringify({ mode: "add", list: "auth" }), state: { values: { title: { v: { value: "  " } } } } } });
    assert.equal(bad.json.response_action, "errors");

    await quiet();
    calls.length = 0;
    await interact({ type: "block_actions", actions: [{ action_id: "home:item", selected_option: { value: JSON.stringify({ a: "delete", list: "auth", id: authItem.id }) }, action_ts: `${++n}.4` }] });
    assert.ok(await waitFor(() => calls.some(c => c.path === "/views.open")));
    const del = calls.find(c => c.path === "/views.open").body.view;
    assert.equal(del.callback_id, "delete_modal");
    assert.equal((await one("select doc from lists where name = 'auth'")).doc.todos.length, 1, "nothing deleted until the modal is submitted");
    assert.deepEqual((await interact({ type: "view_submission", view: { id: "V3", hash: "h3", callback_id: "delete_modal", private_metadata: del.private_metadata } })).json, { response_action: "clear" });
    assert.equal((await one("select doc from lists where name = 'auth'")).doc.todos.length, 0);
}

// Save to doit: the shortcut opens the item modal prefilled; submitting adds to daily
{
    await quiet();
    calls.length = 0;
    await interact({ type: "message_action", callback_id: "save_to_doit", channel: { id: "C1" }, message: { ts: "1.5", text: "please rotate the key\nby friday" } });
    assert.ok(await waitFor(() => calls.some(c => c.path === "/views.open")));
    assert.equal(calls.find(c => c.path === "/chat.getPermalink").body.message_ts, "1.5");
    const modal = calls.find(c => c.path === "/views.open").body.view;
    assert.equal(modal.blocks[0].element.initial_value, "please rotate the key");
    assert.match(modal.blocks[4].element.initial_value, /by friday\n\nhttps:\/\/slack\.example\/p1$/);
    const r = await interact({ type: "view_submission", view: { id: "V4", hash: "h4", callback_id: "item_modal", private_metadata: modal.private_metadata, state: { values: { title: { v: { value: "rotate the key" } }, list: { v: { selected_option: { value: "daily" } } }, priority: { v: { selected_option: { value: "none" } } }, notes: { v: { value: "please rotate the key\nby friday" } } } } } });
    assert.deepEqual(r.json, { response_action: "clear" });
    const added = (await one("select doc from lists where name = 'daily'")).doc.todos.find(t => t.text === "rotate the key");
    assert.equal(added.source, "slack");
    assert.match(added.description, /by friday/);
}

// Feed: Claude's changes post per host and list, extend within a minute, claude: items collapse;
// an owed twin gets its own message with buttons and is edited when a user completes it
{
    const c = await pool.connect();
    const token = await mintToken(c, "devbox");
    c.release();
    const ops = ops => fetch(`${base}/api/ops`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ ops }) }).then(r => r.json());
    const op = (tool, args, source = "mcp") => ({ op_id: uuidv5(`feed:${++n}`), ts: Date.now(), tz: "UTC", source, tool, args });
    await quiet();
    calls.length = 0;
    await ops([op("add_todo", { list: "auth", text: "from claude", type: "chore" })]);
    assert.ok(await waitFor(() => calls.some(c => c.path === "/chat.postMessage")));
    const first = calls.find(c => c.path === "/chat.postMessage").body;
    assert.equal(first.channel, "CFEED");
    assert.match(first.text, /^\*devbox\* · auth\n\+ \[chore\] \d+\. from claude$/);
    calls.length = 0;
    await ops([op("add_todo", { list: "auth", text: "claude: follow up", type: "chore" })]);
    assert.ok(await waitFor(() => calls.some(c => c.path === "/chat.update")));
    assert.equal(calls.filter(c => c.path === "/chat.postMessage").length, 0, "same host and list within a minute edits the message");
    assert.match(calls.find(c => c.path === "/chat.update").body.text, /from claude\n1 claude: item$/);

    calls.length = 0;
    const owe = await ops([op("add_todo", { list: "auth", text: "rotate vault creds", type: "gate", owe: true })]);
    assert.equal(owe.results[0].status, "applied");
    assert.ok(await waitFor(() => calls.filter(c => c.path === "/chat.postMessage").length >= 1));
    const owed = calls.find(c => c.path === "/chat.postMessage" && /owed/.test(c.body.text)).body;
    assert.match(owed.text, /^\*owed\* · daily\n.*auth: rotate vault creds/);
    assert.deepEqual(owed.blocks[1].elements.map(e => e.action_id), ["feed:done", "feed:start", "feed:notes"]);
    const twinId = JSON.parse(owed.blocks[1].elements[0].value).id;
    assert.equal((await one("select doc from lists where name = 'daily'")).doc.todos.some(t => t.id === twinId), true);

    calls.length = 0;
    await ops([op("complete_todo", { list: "daily", id: twinId }, "user")]);
    assert.ok(await waitFor(() => calls.some(c => c.path === "/chat.update" && /done/.test(c.body.text))));
    assert.equal(calls.filter(c => c.path === "/chat.postMessage").length, 0, "a user's change posts nothing new");
    const updated = calls.find(c => c.path === "/chat.update" && /done/.test(c.body.text)).body;
    assert.deepEqual(updated.blocks, []);

    calls.length = 0;
    await ops([op("add_todo", { list: "auth", text: "typed by me", type: "chore" }, "user")]);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(calls.filter(c => c.path === "/chat.postMessage").length, 0);
    assert.ok(Number((await one("select value from settings where key = 'feed_cursor'")).value) > 0);
}

// Feed buttons: Done completes the twin and the message is edited; Notes answers ephemerally
{
    const c = await pool.connect();
    const token = await mintToken(c, "laptop");
    c.release();
    calls.length = 0;
    const r = await fetch(`${base}/api/ops`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ ops: [{ op_id: uuidv5(`feed:${++n}`), ts: Date.now(), tz: "UTC", source: "mcp", tool: "add_todo", args: { list: "auth", text: "approve the app", type: "gate", owe: true, description: "why: needs admin\n\ndo: click approve" } }] }) }).then(r => r.json());
    assert.equal(r.results[0].status, "applied");
    assert.ok(await waitFor(() => calls.some(c => c.path === "/chat.postMessage" && /owed/.test(c.body.text))));
    const msg = calls.find(c => c.path === "/chat.postMessage" && /owed/.test(c.body.text)).body;
    assert.doesNotMatch(msg.text, /needs admin/, "notes stay out of the feed");
    const value = msg.blocks[1].elements[0].value;
    calls.length = 0;
    await interact({ type: "block_actions", channel: { id: "CFEED" }, actions: [{ action_id: "feed:notes", value, action_ts: `${++n}.5` }] });
    assert.ok(await waitFor(() => calls.some(c => c.path === "/chat.postEphemeral")));
    assert.match(calls.find(c => c.path === "/chat.postEphemeral").body.text, /needs admin/);
    calls.length = 0;
    await interact({ type: "block_actions", channel: { id: "CFEED" }, actions: [{ action_id: "feed:done", value, action_ts: `${++n}.6` }] });
    assert.ok(await waitFor(() => calls.some(c => c.path === "/chat.update" && /done/.test(c.body.text))));
    const { id } = JSON.parse(value);
    assert.equal((await one("select doc from lists where name = 'daily'")).doc.todos.find(t => t.id === id).done, true);
    assert.equal((await one("select doc from lists where name = 'auth'")).doc.todos.find(t => /approve the app/.test(t.text)).done, true, "the project twin followed");
}

// Digest DMs the owner's pending daily items
{
    process.env.CRON_SECRET = "s3cret";
    calls.length = 0;
    const res = await fetch(`${base}/api/cron/digest`, { headers: { authorization: "Bearer s3cret" } });
    const body = await res.json();
    assert.equal(body.sent, true);
    const dm = calls.find(c => c.path === "/chat.postMessage").body;
    assert.equal(dm.channel, "UOWNER");
    assert.match(dm.text, /^\*daily\*: \d+ pending\n/);
    assert.match(dm.text, /call the bank/);
    assert.doesNotMatch(dm.text, /rotate vault creds/, "done items stay out");
    assert.equal((await fetch(`${base}/api/cron/digest`)).status, 401);
}

server.close();
fakeSlack.close();
await pool.end();
console.log("slack: ok");
