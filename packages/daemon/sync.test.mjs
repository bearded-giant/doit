// Every scenario in specs/sync/spec.md against the real server (packages/server/dev.js) on the
// same Postgres server.test.mjs uses; skips, loudly, without one. Two machines share a server:
// each is a data dir, a state dir and a token, driven through applyOp (what /call runs) and the
// sync functions doitd runs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { noView } from "@doit/core/view.js";
import { mintToken, revokeToken } from "../server/lib/auth.js";
import { migrate } from "../server/lib/db.js";
import { createServer } from "../server/dev.js";
import { appendLine, applyOp, paths, readJson, readLines, readState } from "./local.js";
import { clone, createSyncer, importDocs, pull, push, rebase, syncConfig } from "./sync.js";

const URL_ = process.env.TEST_DATABASE_URL || "postgres://postgres:doit@127.0.0.1:54329/doit";
const pool = new pg.Pool({ connectionString: URL_ });
try {
    await pool.query("select 1");
} catch (err) {
    console.log(`sync: skip (no Postgres at ${URL_}: ${err.message})`);
    await pool.end();
    process.exit(0);
}
{
    const c = await pool.connect();
    await c.query("drop schema public cascade; create schema public");
    await migrate(c);
    c.release();
}
process.env.DATABASE_URL = URL_;
const server = createServer();
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
// state.json reports sync mode only with a server configured, as in a syncing daemon
process.env.DOIT_SERVER_URL = base;
const todosOf = doc => (doc?.todos || []);
const find = (doc, re) => todosOf(doc).find(t => re.test(t.text));

async function machine(name) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "doit-sd-"));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "doit-ss-"));
    fs.mkdirSync(path.join(data, "lists"));
    const p = paths(state);
    const c = await pool.connect();
    fs.writeFileSync(p.token, await mintToken(c, name), { mode: 0o600 });
    c.release();
    const cfg = syncConfig({ data, state, server: base, host: name, view: noView });
    return {
        name, data, state, p, cfg,
        op: (tool, args, extra = {}) => applyOp({ data, state, server: base, host: name }, { tool, args, source: "user", ...extra }),
        list: n => readJson(path.join(data, "lists", `${n}.json`)),
        outbox: () => readLines(p.outbox),
        acked: () => readLines(p.acked),
        conflicts: () => readLines(p.conflicts),
    };
}

const laptop = await machine("laptop");
const devbox = await machine("devbox");
const seed = (m, name, todos) => fs.writeFileSync(path.join(m.data, "lists", `${name}.json`), JSON.stringify({ todos, _metadata: {} }, null, 2));
seed(laptop, "daily", [{ id: "a1", text: "owed thing", done: false, in_progress: false, order_index: 1 }]);
seed(laptop, "proj", [{ id: "p1", text: "first", done: false, in_progress: false, order_index: 1 }]);

// Import leaves no pending ops
{
    const r = await importDocs(laptop.cfg);
    assert.deepEqual([r.lists, r.notes], [2, 0]);
    assert.equal(laptop.outbox().length, 0);
    assert.equal(readJson(laptop.p.cursor).cursor, r.cursor);
    assert.equal(readJson(laptop.p.cursor).server, base);
    assert.equal(fs.readdirSync(laptop.p.serverDir).length, 2, "server copies stored by list id");
    assert.equal((await push(laptop.cfg)).sent, 0, "the first push sends nothing");
    assert.match((await importDocs(laptop.cfg).catch(e => e.message)), /not empty/);
}

// Fresh machine: clone
{
    const r = await clone(devbox.cfg);
    assert.equal(r.lists, 2);
    assert.deepEqual(todosOf(devbox.list("proj")).map(t => t.id), ["p1"]);
    assert.equal(todosOf(devbox.list("daily"))[0].text, "owed thing");
    assert.match((await clone(devbox.cfg).catch(e => e.message)), /not empty/);
}

// Laptop edit reaches the devbox; acked ops drop once the cursor passes them
{
    const r = await laptop.op("add_todo", { list: "proj", text: "from laptop", type: "chore" });
    assert.equal(r.queued, true);
    assert.equal(laptop.outbox().length, 1);
    const pushed = await push(laptop.cfg);
    assert.deepEqual([pushed.sent, pushed.failed], [1, 0]);
    assert.equal(laptop.outbox().length, 0);
    assert.equal(laptop.acked().length, 1, "applied ops wait in acked until pulled");
    await pull(devbox.cfg);
    assert.ok(find(devbox.list("proj"), /from laptop/));
    await pull(laptop.cfg);
    assert.equal(laptop.acked().length, 0);
    assert.equal(readState(laptop.p).last_pull_at !== null, true);
}

// Retry after timeout: the same batch twice adds nothing twice
{
    const r = await laptop.op("add_todo", { list: "proj", text: "sent twice", type: "chore" });
    const [record] = laptop.outbox();
    assert.equal(record.op_id, r.op_id);
    await push(laptop.cfg);
    appendLine(laptop.p.outbox, record);
    const again = await push(laptop.cfg);
    assert.deepEqual([again.sent, again.failed], [1, 0]);
    assert.equal(laptop.outbox().length, 0);
    await pull(devbox.cfg);
    assert.equal(todosOf(devbox.list("proj")).filter(t => /sent twice/.test(t.text)).length, 1);
}

// Rebase on pull: remote add during local edits
{
    await laptop.op("complete_todo", { list: "proj", id: "p1" });
    assert.equal(laptop.outbox().length, 1, "pending, not pushed");
    await devbox.op("add_todo", { list: "proj", text: "from devbox", type: "chore" });
    await push(devbox.cfg);
    await pull(laptop.cfg);
    const proj = laptop.list("proj");
    assert.ok(find(proj, /from devbox/), "B arrived");
    assert.equal(find(proj, /^first$/).done, true, "pending complete_todo replayed on top");
    assert.equal(laptop.outbox().length, 1, "still pending");
    const pushed = await push(laptop.cfg);
    assert.deepEqual([pushed.sent, pushed.failed], [1, 0]);
    await pull(devbox.cfg);
    assert.equal(find(devbox.list("proj"), /^first$/).done, true);
}

// Acked but not yet pulled: a rebase keeps the acked op's effect
{
    const id = find(laptop.list("proj"), /from laptop/).id;
    await laptop.op("start_todo", { list: "proj", id });
    await push(laptop.cfg);
    const [acked] = laptop.acked();
    assert.ok(acked.change_seq > readJson(laptop.p.cursor).cursor, "acked past the pull cursor");
    await rebase(laptop.cfg, ["proj"]);
    assert.equal(find(laptop.list("proj"), /from laptop/).in_progress, true);
    await pull(laptop.cfg);
    assert.equal(find(laptop.list("proj"), /from laptop/).in_progress, true);
    assert.equal(laptop.acked().length, 0);
}

// Taken rank: the server renumbers, the rest of the outbox follows, the pull corrects the replica
{
    await laptop.op("add_todo", { list: "proj", text: "laptop pinned", type: "chore" }, { source: "mcp" });
    const [first] = laptop.outbox();
    const rank = first.args._pin.rank;
    await laptop.op("add_todo", { list: "proj", text: "laptop dep", type: "chore", deps: [rank] }, { source: "mcp" });
    await devbox.op("add_todo", { list: "proj", text: "devbox pinned", type: "chore" }, { source: "mcp" });
    assert.equal(devbox.outbox()[0].args._pin.rank, rank, "both machines picked the same rank offline");
    await push(devbox.cfg);
    const pushed = await push(laptop.cfg);
    assert.deepEqual([pushed.sent, pushed.failed], [2, 0]);
    await pull(laptop.cfg);
    const proj = laptop.list("proj");
    assert.match(find(proj, /devbox pinned/).text, new RegExp(`\\] ${rank}\\. `));
    assert.match(find(proj, /laptop pinned/).text, new RegExp(`\\] ${rank + 1}\\. `));
    assert.match(find(proj, /laptop dep/).text, new RegExp(`\\(dep on #${rank + 1}\\)$`));
    await pull(devbox.cfg);
    assert.equal(JSON.stringify(devbox.list("proj")), JSON.stringify(proj), "both replicas equal the server");
}

// List renamed elsewhere: the file follows, the offline add fails as a conflict
{
    await devbox.op("create_list", { name: "a" });
    await push(devbox.cfg);
    await pull(laptop.cfg);
    assert.ok(laptop.list("a"));
    await devbox.op("rename_list", { old_name: "a", new_name: "c" });
    await push(devbox.cfg);
    await laptop.op("add_todo", { list: "a", text: "offline add", type: "chore" });
    await pull(laptop.cfg);
    assert.equal(laptop.list("a"), null, "lists/a.json became lists/c.json");
    assert.ok(laptop.list("c"));
    const pushed = await push(laptop.cfg);
    assert.deepEqual([pushed.sent, pushed.failed], [1, 1]);
    assert.equal(laptop.conflicts().length, 1);
    assert.match(laptop.conflicts()[0].error, /a/);
    assert.equal(laptop.outbox().length, 0);
    assert.equal(readState(laptop.p).conflicts, 1);
}

// Item deleted elsewhere: the push rebuilds from the stored copies at once, the pull removes it
{
    const id = find(laptop.list("proj"), /sent twice/).id;
    await devbox.op("delete_todo", { list: "proj", id });
    await push(devbox.cfg);
    await laptop.op("complete_todo", { list: "proj", id });
    assert.equal(find(laptop.list("proj"), /sent twice/).done, true);
    const pushed = await push(laptop.cfg);
    assert.equal(pushed.failed, 1);
    const afterPush = find(laptop.list("proj"), /sent twice/);
    assert.ok(afterPush && afterPush.done === false, "pending again before any pull");
    await pull(laptop.cfg);
    assert.equal(find(laptop.list("proj"), /sent twice/), undefined);
}

// Plane mode: offline adds land at once, reach the server with the same ids on reconnect
{
    const dead = { ...laptop.cfg, server: "http://127.0.0.1:1" };
    const syncer = createSyncer(dead);
    const ids = [];
    for (const text of ["one", "two", "three"]) ids.push((await laptop.op("add_todo", { list: "daily", text, type: "chore" })).text.match(/\[id:([^\]]+)\]/)[1]);
    assert.deepEqual(todosOf(laptop.list("daily")).filter(t => /one|two|three/.test(t.text)).map(t => t.id), ids);
    await assert.rejects(syncer.cycle());
    syncer.stop();
    const st = readState(laptop.p);
    assert.equal(st.online, false);
    assert.ok(st.error);
    assert.equal(laptop.outbox().length, 3, "still queued");
    const pushed = await push(laptop.cfg);
    assert.deepEqual([pushed.sent, pushed.failed], [3, 0]);
    await pull(devbox.cfg);
    assert.deepEqual(todosOf(devbox.list("daily")).filter(t => /one|two|three/.test(t.text)).map(t => t.id), ids);
    assert.equal(readState(laptop.p).online, true);
}

// Revoked devbox token
{
    const c = await pool.connect();
    await revokeToken(c, "devbox");
    c.release();
    await devbox.op("add_todo", { list: "daily", text: "never lands", type: "chore" });
    const syncer = createSyncer(devbox.cfg);
    await assert.rejects(syncer.cycle(), /token/);
    syncer.stop();
    const st = readState(devbox.p);
    assert.equal(st.online, false);
    assert.match(st.error, /token/);
    assert.equal(devbox.outbox().length, 1);
}

// A cursor from another server is never pulled onto
{
    const other = { ...laptop.cfg, server: "http://other.example" };
    await assert.rejects(pull(other), /belongs to/);
}

server.close();
await pool.end();
fs.rmSync(laptop.data, { recursive: true, force: true });
fs.rmSync(laptop.state, { recursive: true, force: true });
fs.rmSync(devbox.data, { recursive: true, force: true });
fs.rmSync(devbox.state, { recursive: true, force: true });
console.log("sync: ok");
