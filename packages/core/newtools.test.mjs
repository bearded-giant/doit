// reorder_todo parity with tmux/scripts/todo-move.sh, restore_todo, put_scope_notes, update_todo.fields, create_list.source
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCtx } from "./ctx.js";
import { createMcpServer } from "./server.js";
import { memStore } from "./store.js";
import { TOOLS, runTool } from "./tools.js";

const doc = todos => ({ todos, _metadata: {} });
const item = (id, text, order_index, extra = {}) => ({ id, text, done: false, in_progress: false, order_index, ...extra });
const ctxFor = store => createCtx({ store, ts: 1794250800000, tz: "UTC", opId: "op-1", activeList: "daily" });
const orderOf = (store, list, id) => store.docs.get(list).todos.find(t => t.id === id).order_index;
const seqOf = (store, list, id) => store.docs.get(list).todos.find(t => t.id === id).sequence;

// tests/tmux/test_nesting.sh: a root swaps with the previous root, not with that root's child
{
    const store = memStore({ l: doc([
        item("A", "root a", 1), item("A1", "child of a", 2, { parent_id: "A", depth: 1 }), item("A2", "second child", 3, { parent_id: "A", depth: 1 }),
        item("B", "root b", 4),
    ]) });
    await runTool(ctxFor(store), "reorder_todo", { list: "l", id: "B", direction: "up" });
    assert.equal(orderOf(store, "l", "B"), 1);
    assert.equal(orderOf(store, "l", "A"), 4);
    assert.equal(orderOf(store, "l", "A1"), 2, "the child kept its own order_index");
}

// tests/tmux/test_origin_blocks.sh: never swaps across the Mine/Claude boundary
{
    const mk = () => memStore({ l: doc([
        item("M5", "3.buy milk", 6, { source: "user" }),
        item("C1", "claude: x", 10),
        item("C2", "claude: y", 12),
    ]) });
    let store = mk();
    await runTool(ctxFor(store), "reorder_todo", { list: "l", id: "C1", direction: "up" });
    assert.equal(orderOf(store, "l", "C1"), 10);
    assert.equal(orderOf(store, "l", "M5"), 6);
    store = mk();
    await runTool(ctxFor(store), "reorder_todo", { list: "l", id: "M5", direction: "down" });
    assert.equal(orderOf(store, "l", "M5"), 6);
    store = mk();
    await runTool(ctxFor(store), "reorder_todo", { list: "l", id: "C1", direction: "down" });
    assert.equal(orderOf(store, "l", "C1"), 12);
    assert.equal(orderOf(store, "l", "C2"), 10);
}

// tests/tmux/test_sequence.sh: Sequence reorder swaps sequence across priority and leaves order_index alone
{
    const store = memStore({ seq: doc([
        item("C", "crit", 1, { priorities: "critical" }),
        item("S2", "second step", 2, { sequence: 2 }),
        item("S1", "first step", 3, { sequence: 1, priorities: "important" }),
        item("R", "running", 4, { sequence: 3, in_progress: true }),
        item("D", "plain default", 5),
    ]) });
    await runTool(ctxFor(store), "reorder_todo", { list: "seq", id: "S1", direction: "down" });
    assert.equal(seqOf(store, "seq", "S1"), 2);
    assert.equal(seqOf(store, "seq", "S2"), 1);
    assert.equal(orderOf(store, "seq", "S1"), 3);
    const r = await runTool(ctxFor(store), "reorder_todo", { list: "seq", id: "D", direction: "up" });
    assert.equal(seqOf(store, "seq", "D"), undefined, "an unsequenced default item does not swap into the Sequence section");
    assert.equal(orderOf(store, "seq", "D"), 5);
    assert.match(r.content[0].text, /Nothing above/);
}

// restore_todo brings a deleted item back by id, twin included
{
    const store = memStore({ proj: doc([]), daily: doc([]) });
    const added = await runTool(ctxFor(store), "add_todo", { list: "proj", text: "renew cert", type: "gate", owe: true });
    const id = /\[id:([^\]]+)\]/.exec(added.content[0].text)[1];
    await runTool(ctxFor(store), "delete_todo", { list: "proj", id });
    assert.equal(store.docs.get("proj").todos.length, 0);
    assert.equal(store.docs.get("daily").todos.length, 0);
    const r = await runTool(ctxFor(store), "restore_todo", { list: "proj", id });
    assert.match(r.content[0].text, /Restored in "proj".*\nTwin in "daily" restored/);
    assert.equal(store.docs.get("proj").todos[0].id, id);
    assert.equal(store.docs.get("daily").todos.length, 1);
    assert.deepEqual(store.docs.get("proj")._metadata.deleted_todos, []);
    await assert.rejects(runTool(ctxFor(store), "restore_todo", { list: "proj", id: "nope" }), /No deleted todo/);
}

// put_scope_notes replaces the whole doc; unchanged bytes leave dirty() empty
{
    const store = memStore({});
    const notes = [{ id: "n1", title: "t", body: "b" }];
    await runTool(ctxFor(store), "put_scope_notes", { scope: "global", notes });
    assert.deepEqual(store.dirty(), ["notes/global"]);
    const again = memStore({});
    again.notes.set("global", structuredClone(notes));
    await runTool(ctxFor(again), "put_scope_notes", { scope: "global", notes });
    assert.deepEqual(again.dirty(), [], "same bytes, no change recorded");
    await assert.rejects(runTool(ctxFor(store), "put_scope_notes", { scope: "../x", notes }), /Scope names/);
}

// update_todo.fields writes allowlisted surface fields only
{
    const store = memStore({ l: doc([item("a", "a", 1), item("b", "b", 2)]) });
    await runTool(ctxFor(store), "update_todo", { list: "l", id: "b", fields: { estimated_hours: 2.5, obsidian_ref: "notes/x.md", parent_id: "a" } });
    const b = store.docs.get("l").todos[1];
    assert.equal(b.estimated_hours, 2.5);
    assert.equal(b.obsidian_ref, "notes/x.md");
    assert.equal(b.parent_id, "a");
    assert.equal(b.depth, 1);
    await runTool(ctxFor(store), "update_todo", { list: "l", id: "b", fields: { obsidian_ref: null, parent_id: "" } });
    assert.equal(b.obsidian_ref, undefined);
    assert.equal(b.parent_id, undefined);
    assert.equal(b.depth, 0);
    await assert.rejects(runTool(ctxFor(store), "update_todo", { list: "l", id: "b", fields: { done: true } }), /not writable/);
}

// create_list.source marks the list as the user's in one op
{
    const store = memStore({});
    await runTool(ctxFor(store), "create_list", { name: "mine", source: "user" });
    assert.equal(store.docs.get("mine")._metadata.source, "user");
    await runTool(ctxFor(store), "create_list", { name: "theirs" });
    assert.equal(store.docs.get("theirs")._metadata.source, undefined);
}

// internal tools stay out of Claude's tools/list; reorder_todo is public
{
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createMcpServer({ execute: () => ({ content: [] }), version: "0" }).connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.ok(names.includes("reorder_todo"));
    assert.ok(!names.includes("restore_todo") && !names.includes("put_scope_notes"));
    assert.equal(names.length, TOOLS.filter(t => !t.internal).length);
    const schema = (await client.listTools()).tools.find(t => t.name === "update_todo").inputSchema;
    assert.equal(schema.properties.fields, undefined, "internal args are not advertised");
    await client.close();
}

console.log("new tools: ok");
