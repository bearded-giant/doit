// pinned refs and ranks: local apply decides, the server honors or remaps
import assert from "node:assert/strict";
import { createCtx } from "./ctx.js";
import { pinArgs, remapOps } from "./ops.js";
import { memStore } from "./store.js";
import { runTool } from "./tools.js";

const doc = todos => ({ todos, _metadata: {} });
const item = (id, text, extra = {}) => ({ id, text, done: false, in_progress: false, order_index: 1, ...extra });
const ctxFor = store => createCtx({ store, ts: 1794250800000, tz: "UTC", opId: "op-1", activeList: "daily" });
const textOf = r => r.content[0].text;

// a free pinned rank is used as is
{
    const store = memStore({ proj: doc([item("a", "claude: [chore] 1. first")]) });
    const r = await runTool(ctxFor(store), "add_todo", { list: "proj", text: "later", type: "chore", _pin: { rank: 5 } });
    assert.match(textOf(r), /\[chore\] 5\. later/);
    assert.equal(r._meta.resolved.rank, 5);
    assert.equal(r._meta.resolved.rank_remap, undefined);
}

// a taken pinned rank moves to the next free one and the remap comes back
{
    const store = memStore({ proj: doc([item("a", "claude: [chore] 1. first"), item("b", "claude: [chore] 2. other", { order_index: 2 })]) });
    const r = await runTool(ctxFor(store), "add_todo", { list: "proj", text: "mine too", type: "chore", _pin: { rank: 2 } });
    assert.match(textOf(r), /\[chore\] 3\. mine too/);
    assert.deepEqual(r._meta.resolved.rank_remap, { proj: { 2: 3 } });
}

// the owed twin's rank is pinned the same way
{
    const store = memStore({ proj: doc([]), daily: doc([item("d", "[gate] 4. taken")]) });
    const r = await runTool(ctxFor(store), "add_todo", { list: "proj", text: "rotate", type: "gate", owe: true, _pin: { rank: 1, owed_rank: 4 } });
    assert.match(textOf(r), /owed in daily #5/);
    assert.deepEqual(r._meta.resolved.rank_remap, { daily: { 4: 5 } });
}

// move_todo and merge_list pin the ranks they hand out on the target
{
    const store = memStore({ a: doc([item("x", "claude: [chore] 7. moving")]), b: doc([item("y", "claude: [chore] 3. there")]) });
    const r = await runTool(ctxFor(store), "move_todo", { id: "x", from_list: "a", to_list: "b" });
    assert.equal(r._meta.resolved.rank, 4);
    const store2 = memStore({ a: doc([item("x", "claude: [chore] 7. one"), item("z", "claude: [chore] 9. two (dep on #7)", { order_index: 2 })]), b: doc([item("y", "claude: [chore] 3. there")]) });
    const m = await runTool(ctxFor(store2), "merge_list", { from: "a", to: "b", _pin: { rank_base: 3 } });
    assert.deepEqual(m._meta.resolved.rank_remap, { b: { 3: 4, 4: 5 } });
    assert.ok(store2.docs.get("b").todos.some(t => t.text === "claude: [chore] 5. two (dep on #4)"));
}

// pinArgs stores the op fully resolved
{
    const store = memStore({ proj: doc([item("a", "ship the token fix", { in_progress: true })]) });
    const args = { query: "token" };
    const r = await runTool(ctxFor(store), "complete_todo", { list: "proj", ...args });
    assert.deepEqual(pinArgs({ list: "proj", ...args }, r._meta.resolved), { list: "proj", id: "a" });
    const add = await runTool(ctxFor(store), "add_todo", { list: "proj", text: "new", type: "chore", parent: "a" });
    assert.deepEqual(pinArgs({ list: "proj", text: "new", type: "chore", parent: "a" }, add._meta.resolved), {
        list: "proj", text: "new", type: "chore", parent: "a", _pin: { rank: 1 },
    });
    const bare = await runTool(ctxFor(store), "add_todo", { text: "inbox item", type: "chore" });
    assert.equal(pinArgs({ text: "inbox item", type: "chore" }, bare._meta.resolved).list, "daily", "an omitted list is pinned to the one it landed on");
}

// remapOps rewrites a queued dep, and a queued pin that now collides moves up with its own deps
{
    const ops = [
        { tool: "update_todo", args: { list: "proj", id: "y", deps: [22, "7a"] } },
        { tool: "add_todo", args: { list: "proj", text: "b", _pin: { rank: 23 } } },
        { tool: "update_todo", args: { list: "proj", id: "c", deps: [23] } },
        { tool: "update_todo", args: { list: "other", id: "o", deps: [22] } },
    ];
    const out = remapOps(ops, { proj: { 22: 23 } });
    assert.deepEqual(out[0].args.deps, [23, "7a"]);
    assert.deepEqual(out[1].args._pin, { rank: 24 });
    assert.deepEqual(out[2].args.deps, [24]);
    assert.deepEqual(out[3].args.deps, [22], "another list's ranks are untouched");
    assert.deepEqual(ops[0].args.deps, [22, "7a"], "input ops are not mutated");
}

console.log("pins: ok");
