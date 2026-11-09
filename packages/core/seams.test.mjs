// store / view / op ctx seams: the same op on the same state yields the same bytes wherever it runs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCtx } from "./ctx.js";
import { fileStore, memStore, normalizeDoc } from "./store.js";
import { runTool } from "./tools.js";

const TS = Date.UTC(2026, 10, 9, 19, 0, 0);
const OP = "0193b2e4-7c1a-7000-8000-000000000001";
const doc = todos => ({ todos, _metadata: {} });
const item = (id, text, extra = {}) => ({ id, text, done: false, in_progress: false, order_index: 1, ...extra });
const ctxFor = (store, extra = {}) => createCtx({ store, ts: TS, tz: "UTC", opId: OP, source: "mcp", activeList: "daily", ...extra });
const textOf = r => r.content[0].text;

// determinism: ids, stamps and twin ids come from the op, not the process
{
    const run = () => {
        const store = memStore({ proj: doc([]), daily: doc([]) });
        return runTool(ctxFor(store), "add_todo", { list: "proj", text: "renew cert", type: "gate", owe: true, description: "why: expires" })
            .then(r => ({ r, bytes: JSON.stringify([store.docs.get("proj"), store.docs.get("daily")]) }));
    };
    const a = await run();
    const b = await run();
    assert.equal(a.bytes, b.bytes, "same op, same state, same bytes");
    assert.match(textOf(a.r), /\[id:1794250800_\d{7}\]/, "ids keep the <unix>_<7 digits> shape, seconds from the op ts");
    assert.match(textOf(a.r), /Twin in "daily".*\[id:1794250800_\d{7}\]/);
    assert.deepEqual(a.r._meta.resolved.list, "proj");
}

// footers render in the op's tz, so laptop and server stamp the same string
{
    const stampIn = async tz => {
        const store = memStore({ daily: doc([]) });
        await runTool(createCtx({ store, ts: TS, tz, opId: OP }), "add_todo", { text: "x", type: "chore" });
        return /last modified: (.*)$/.exec(store.docs.get("daily").todos[0].description)[1];
    };
    assert.equal(await stampIn("UTC"), "2026-11-09: 19:00");
    assert.equal(await stampIn("America/New_York"), "2026-11-09: 14:00");
}

// reads and dry runs leave dirty() empty; writes name every doc they changed
{
    const store = memStore({
        proj: doc([item("a", "buy milk"), item("b", "claude: [chore] 2. buy milk", { order_index: 2 })]),
        daily: doc([]),
    });
    await runTool(ctxFor(store), "list_todos", { list: "proj" });
    assert.deepEqual(store.dirty(), []);
    const dry = await runTool(ctxFor(store), "dedupe_todos", { list: "proj" });
    assert.match(textOf(dry), /DRY RUN/);
    assert.deepEqual(store.dirty(), []);
    await runTool(ctxFor(store), "add_todo", { list: "proj", text: "pay bill", owe: true });
    assert.deepEqual(store.dirty().sort(), ["daily", "proj"]);
}

// update_todo done stamps and clears completed_at like complete_todo/revert_todo do
{
    const store = memStore({ daily: doc([item("a", "thing")]) });
    await runTool(ctxFor(store), "update_todo", { id: "a", done: true });
    assert.equal(store.docs.get("daily").todos[0].completed_at, 1794250800);
    await runTool(ctxFor(store), "update_todo", { id: "a", done: false });
    assert.equal(store.docs.get("daily").todos[0].completed_at, undefined);
}

// resolved targets ride along in _meta so a caller can pin the op
{
    const store = memStore({ proj: doc([item("a", "ship the token fix", { in_progress: true })]) });
    const r = await runTool(ctxFor(store), "complete_todo", { list: "proj", query: "token" });
    assert.deepEqual(r._meta.resolved, { list: "proj", id: "a" });
    const r2 = await runTool(ctxFor(store), "add_todo", { list: "proj", text: "child", parent: "a" });
    assert.equal(r2._meta.resolved.parent, "a");
}

// legacy docs normalize on read (nvim's load-time migrations)
{
    const legacy = normalizeDoc({
        todos: [
            { id: "p", text: "parent", timestamp: 5, priorities: ["important", "critical"], _score: 9 },
            { text: "no id, dangling parent", parent_id: "gone", depth: 2 },
        ],
    });
    assert.deepEqual(legacy.todos[0], { id: "p", text: "parent", created_at: 5, priorities: "critical", order_index: 1 });
    assert.equal(legacy.todos[1].parent_id, undefined);
    assert.equal(legacy.todos[1].depth, 0);
    assert.match(legacy.todos[1].id, /^0_\d{7}$/);
    const fromNvim = normalizeDoc({ todos: [], _metadata: [], notes: [] });
    assert.deepEqual(fromNvim._metadata, {}, "an empty Lua table arrives as [] and must become an object");
}

// fileStore: writes land atomically and dirty() tracks changed files only
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doit-core-"));
    fs.mkdirSync(path.join(dir, "lists"));
    fs.writeFileSync(path.join(dir, "lists", "proj.json"), JSON.stringify(doc([item("a", "x")])));
    const store = fileStore(dir);
    await runTool(ctxFor(store), "list_todos", { list: "proj" });
    assert.deepEqual(store.dirty(), []);
    await runTool(ctxFor(store), "start_todo", { id: "a" });
    assert.deepEqual(store.dirty(), ["proj"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "lists", "proj.json"), "utf-8")).todos[0].in_progress, true);
    assert.ok(!fs.readdirSync(path.join(dir, "lists")).some(f => f.endsWith(".tmp")));
    await runTool(ctxFor(store), "rename_list", { old_name: "proj", new_name: "proj2" });
    assert.ok(fs.existsSync(path.join(dir, "lists", "proj2.json")));
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log("seams: ok");

// memStore seeds lazily from a loader, so a replay only carries the docs an op touched
{
    const loaded = [];
    const store = memStore({ proj: doc([]) }, name => {
        loaded.push(name);
        return name === "daily" ? doc([]) : null;
    });
    await runTool(ctxFor(store), "add_todo", { list: "proj", text: "owed thing", type: "gate", owe: true });
    assert.deepEqual(loaded, ["daily"], "the twin list was pulled in on demand");
    assert.equal(store.docs.get("daily").todos.length, 1);
    assert.equal(store.getList("nope"), null);
    assert.deepEqual(store.dirty().sort(), ["daily", "proj"]);
}

console.log("seams+memStore: ok");
