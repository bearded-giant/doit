// Needs a Postgres at TEST_DATABASE_URL (default below; CI starts one as a service). Locally:
//   docker run -d --name doit-pg -p 54329:5432 -e POSTGRES_PASSWORD=doit -e POSTGRES_DB=doit postgres:16-alpine
// Skips, loudly, when it cannot connect. Every block drops and recreates the schema it needs.
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { authenticate, hashToken, mintToken, revokeToken } from "./lib/auth.js";
import { migrate } from "./lib/db.js";
import { applyOps, changesSince, importDocs } from "./lib/runner.js";
import { createServer } from "./dev.js";

const URL_ = process.env.TEST_DATABASE_URL || "postgres://postgres:doit@127.0.0.1:54329/doit";
const pool = new pg.Pool({ connectionString: URL_ });
try {
    await pool.query("select 1");
} catch (err) {
    console.log(`server: skip (no Postgres at ${URL_}: ${err.message})`);
    await pool.end();
    process.exit(0);
}

const reset = async () => {
    const c = await pool.connect();
    try {
        await c.query("drop schema public cascade; create schema public");
        await migrate(c);
    } finally {
        c.release();
    }
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const uuid = n => `0193b2e4-7c1a-7000-8000-${String(n).padStart(12, "0")}`;
const op = (n, tool, args, extra = {}) => ({ op_id: uuid(n), ts: 1794250800000 + n, tz: "UTC", source: "mcp", tool, args, ...extra });

await reset();

// ops apply once, in their own transaction, with a change_seq per touched row
{
    const [r1] = await applyOps(pool, [op(1, "add_todo", { list: "proj", text: "first", type: "chore" })], { host: "laptop" });
    assert.equal(r1.status, "failed", "a list that does not exist on the server is a conflict");
    const [c] = await applyOps(pool, [op(2, "create_list", { name: "proj", source: "user" })], { host: "laptop" });
    assert.equal(c.status, "applied");
    assert.equal(c.change_seq, 1);
    const [r2] = await applyOps(pool, [op(3, "add_todo", { list: "proj", text: "first", type: "chore", _pin: { rank: 1 } })], { host: "laptop" });
    assert.equal(r2.status, "applied");
    assert.equal(r2.change_seq, 2);
    const row = await one("select doc, version, change_seq from lists where name = 'proj'");
    assert.equal(row.version, "2");
    assert.equal(row.doc.todos[0].text, "[chore] 1. first");
    assert.equal(row.doc.todos[0].id, `1794250800_${String(row.doc.todos[0].id).split("_")[1]}`, "ids come from the op ts and id");
    const [again] = await applyOps(pool, [op(3, "add_todo", { list: "proj", text: "first", type: "chore" })], { host: "laptop" });
    assert.equal(again.status, "duplicate");
    assert.equal((await one("select count(*) as n from lists")).n, "1");
    const applied = await one("select host, source, tool, ok, result from applied_ops where op_id = $1", [uuid(3)]);
    assert.equal(applied.host, "laptop");
    assert.equal(applied.ok, true);
    assert.match(applied.result.text, /\[id:/);
    const events = (await pool.query("select list, todo_id, source, payload from events order by id")).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.kind, "added");
    assert.equal(events[0].source, "mcp");
}

// an owe twin commits with its project item or not at all; every source writes events
{
    const [r] = await applyOps(pool, [op(4, "add_todo", { list: "proj", text: "rotate creds", type: "gate", owe: true, _pin: { rank: 2, owed_rank: 1 } }, { source: "user" })], { host: "laptop" });
    assert.equal(r.status, "applied");
    const daily = await one("select doc from lists where name = 'daily'");
    assert.match(daily.doc.todos[0].text, /^\[gate\] 1\. proj: rotate creds$/);
    const proj = await one("select doc from lists where name = 'proj'");
    assert.equal(proj.doc.todos[1].twin.id, daily.doc.todos[0].id);
    const ev = (await pool.query("select list, source from events where tool = 'add_todo' and source = 'user' order by id")).rows;
    assert.deepEqual(ev.map(e => e.list).sort(), ["daily", "proj"]);
}

// a pinned rank that another machine took comes back as rank_remap
{
    const [r] = await applyOps(pool, [op(5, "add_todo", { list: "proj", text: "from the devbox", type: "chore", _pin: { rank: 2 } })], { host: "devbox" });
    assert.equal(r.status, "applied");
    assert.deepEqual(r.rank_remap, { proj: { 2: 3 } });
}

// a read replayed as an op touches nothing
{
    const before = await one("select last_value from change_seq");
    const [r] = await applyOps(pool, [op(6, "list_todos", { list: "proj" })], { host: "laptop" });
    assert.equal(r.status, "applied");
    assert.equal(r.change_seq, null);
    assert.equal((await one("select last_value from change_seq")).last_value, before.last_value);
}

// a failed op leaves no trace
{
    const ops = (await one("select count(*) as n from applied_ops")).n;
    const [r] = await applyOps(pool, [op(7, "complete_todo", { list: "proj", id: "nope" })], { host: "laptop" });
    assert.equal(r.status, "failed");
    assert.match(r.error, /not found/);
    assert.equal((await one("select count(*) as n from applied_ops")).n, ops);
}

// a rename keeps the row id so a pull can rename the replica file; a delete is a tombstone
{
    const idBefore = (await one("select id from lists where name = 'proj'")).id;
    const client = await pool.connect();
    const cursor = (await changesSince(client, 0)).cursor;
    client.release();
    const [r] = await applyOps(pool, [op(8, "rename_list", { old_name: "proj", new_name: "proj2" })], { host: "laptop" });
    assert.equal(r.status, "applied");
    const c2 = await pool.connect();
    const changes = await changesSince(c2, cursor);
    c2.release();
    const renamed = changes.lists.find(l => l.id === idBefore);
    assert.equal(renamed.name, "proj2");
    assert.match(changes.lists.find(l => l.name === "daily").doc.todos[0].text, /proj2: rotate creds/, "the twin relabel rode along");
    const [d] = await applyOps(pool, [op(9, "delete_list", { name: "proj2" })], { host: "laptop" });
    assert.equal(d.status, "applied");
    const c3 = await pool.connect();
    const after = await changesSince(c3, changes.cursor);
    c3.release();
    const gone = after.lists.find(l => l.id === idBefore);
    assert.ok(gone.deleted_at, "deleted lists come back with deleted_at");
    assert.ok(after.cursor > changes.cursor);
}

// import seeds an empty server only
{
    const r = await importDocs(pool, { lists: { x: { todos: [] } } });
    assert.match(r.error, /not empty/);
    await reset();
    const ok = await importDocs(pool, { lists: { daily: { todos: [{ id: "a", text: "a", done: false, order_index: 1 }] }, work: { todos: [] } }, notes: { global: [{ id: "n", title: "t" }] } });
    assert.deepEqual([ok.lists, ok.notes, ok.cursor], [2, 1, 3]);
    const c = await pool.connect();
    const all = await changesSince(c, 0);
    c.release();
    assert.equal(all.lists.length, 2);
    assert.equal(all.notes.length, 1);
    assert.equal(all.cursor, 3);
}

// tokens: only the hash is stored, revoked ones stop working
{
    const c = await pool.connect();
    const token = await mintToken(c, "laptop");
    assert.equal((await one("select hash from tokens where machine = 'laptop'")).hash, hashToken(token));
    assert.equal(await authenticate(c, `Bearer ${token}`), "laptop");
    assert.equal(await authenticate(c, "Bearer nope"), null);
    assert.equal(await authenticate(c, undefined), null);
    assert.equal(await revokeToken(c, "laptop"), true);
    assert.equal(await authenticate(c, `Bearer ${token}`), null);
    c.release();
}

// the HTTP layer: bearer auth, batch results, changes, import
{
    process.env.DATABASE_URL = URL_;
    const c = await pool.connect();
    const token = await mintToken(c, "devbox");
    c.release();
    const server = createServer();
    await new Promise(r => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, path, body, auth = `Bearer ${token}`) =>
        new Promise((resolve, reject) => {
            const req = http.request(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) } }, res => {
                let data = "";
                res.on("data", d => { data += d; });
                res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
            });
            req.on("error", reject);
            req.end(body ? JSON.stringify(body) : undefined);
        });
    assert.equal((await call("POST", "/api/ops", { ops: [] }, "Bearer wrong")).status, 401);
    assert.equal((await call("GET", "/api/ops")).status, 405);
    const bad = await call("POST", "/api/ops", { ops: [{ tool: "x" }] });
    assert.equal(bad.status, 400);
    const r = await call("POST", "/api/ops", { ops: [op(20, "add_todo", { list: "work", text: "over http", type: "chore" })] });
    assert.equal(r.status, 200);
    assert.equal(r.json.results[0].status, "applied");
    assert.equal((await one("select host from applied_ops where op_id = $1", [uuid(20)])).host, "devbox");
    const ch = await call("GET", "/api/sync/changes?cursor=3");
    assert.equal(ch.status, 200);
    assert.equal(ch.json.lists.length, 1);
    assert.equal(ch.json.lists[0].name, "work");
    assert.equal((await call("GET", "/api/sync/changes?cursor=-1")).status, 400);
    assert.equal((await call("POST", "/api/sync/import", { lists: {} })).status, 409);
    assert.equal((await call("GET", "/api/health", undefined, null)).json.ok, true);
    await pool.query("update events set at = now() - interval '91 days'");
    process.env.CRON_SECRET = "s3cret";
    assert.equal((await call("GET", "/api/cron/prune", undefined, null)).status, 401);
    const pruned = await call("GET", "/api/cron/prune", undefined, "Bearer s3cret");
    assert.deepEqual(pruned.json, { events: 1, applied_ops: 0 });
    server.close();
}

await pool.end();
console.log("server: ok");
