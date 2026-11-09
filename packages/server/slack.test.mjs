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
    res.end(JSON.stringify({ ok: true }));
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

server.close();
fakeSlack.close();
await pool.end();
console.log("slack: ok");
