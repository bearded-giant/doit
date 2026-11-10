import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// a data dir and state dir of their own, no daemon: doitCall applies in process under the lock
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doit-vault-"));
const data = path.join(tmp, "data");
const state = path.join(tmp, "state");
const out = path.join(tmp, "doit-todos");
fs.mkdirSync(path.join(data, "lists"), { recursive: true });
fs.mkdirSync(state, { mode: 0o700 });
Object.assign(process.env, { DOIT_DATA_DIR: data, DOIT_STATE_DIR: state, TZ: "UTC" });
delete process.env.DOIT_SERVER_URL;
delete process.env.DOIT_ACTIVE_LIST;

const { exportOnce, importEdits, noteOps, parseItemNote } = await import("./vault-export.js");

const listFile = path.join(data, "lists", "proj.json");
fs.writeFileSync(listFile, JSON.stringify({
    todos: [
        { id: "a_0001", text: "[chore] 3. write docs (dep on #4)", order_index: 1, description: "old notes\n\n\n----------\nlast modified: 2026-10-15: 20:49" },
        { id: "b_0001", text: "4. ship it", in_progress: true, order_index: 2 },
        { id: "c_0001", text: "5. two\nlines", order_index: 3 },
        { id: "d_0001", text: "6. other", in_progress: true, order_index: 4 },
    ],
    _metadata: {},
}));
const todo = id => JSON.parse(fs.readFileSync(listFile, "utf-8")).todos.find(t => t.id === id);
const relOf = (files, id) => [...files].find(([, content]) => content.includes(`doit_id: "${id}"`))[0];
const edit = (rel, fn) => fs.writeFileSync(path.join(out, rel), fn(fs.readFileSync(path.join(out, rel), "utf-8")));

let base = exportOnce(out);

// the parser reads the exporter's JSON-quoted values and Obsidian's bare ones alike
{
    const note = parseItemNote(base.get(relOf(base, "a_0001")));
    assert.deepEqual(note, { list: "proj", id: "a_0001", status: "pending", priority: "", due: "", title: "write docs (dep on #4)", body: "old notes" });
    assert.equal(parseItemNote("---\ndoit_list: proj\ndoit_id: a_0001\nstatus: done\n---\n\n# 3. t\n").status, "done");
    assert.equal(parseItemNote(base.get("proj/proj.md")), null, "a list index is not an item note");
    assert.equal(parseItemNote("no frontmatter"), null);
}

// an untouched export sends nothing: every note still holds what the exporter wrote
assert.equal(await importEdits(out, base, [...base.keys()]), 0);

// status, priority, due, title and body edited in one save become one update through the tools
{
    const rel = relOf(base, "a_0001");
    edit(rel, s => s
        .replace('status: "pending"', "status: done\npriority: urgent\ndue: 2026-12-01")
        .replace("# 3. write docs (dep on #4)", "# 3. write better docs (dep on #4)")
        .replace("old notes", "new notes\n\nsecond paragraph"));
    assert.equal(await importEdits(out, base, [rel]), 1);
    const a = todo("a_0001");
    assert.equal(a.done, true);
    assert.equal(a.priorities, "urgent");
    assert.equal(a.due_date, "2026-12-01");
    assert.equal(a.text, "[chore] 3. write better docs (dep on #4)");
    assert.match(a.description, /^new notes\n\nsecond paragraph\n\n\n-{10}\nlast modified: /);

    // the export that follows writes the note back in its own shape, and that write is not an edit
    base = exportOnce(out);
    assert.equal(relOf(base, "a_0001").startsWith("proj/done/"), true);
    assert.equal(await importEdits(out, base, [...base.keys(), rel]), 0);
}

// in_progress goes through start_todo, so the item that was active in that slot stops
{
    const rel = relOf(base, "c_0001");
    edit(rel, s => s.replace('status: "pending"', "status: in_progress"));
    assert.equal(await importEdits(out, base, [rel]), 1);
    assert.equal(todo("c_0001").in_progress, true);
    assert.equal(todo("b_0001").in_progress || todo("d_0001").in_progress || false, false);
    base = exportOnce(out);
}

// a field the lists changed since the export stays theirs
{
    const rel = relOf(base, "c_0001");
    edit(rel, s => s.replace('status: "in_progress"', "status: done"));
    const raw = JSON.parse(fs.readFileSync(listFile, "utf-8"));
    raw.todos.find(t => t.id === "c_0001").in_progress = false;
    fs.writeFileSync(listFile, JSON.stringify(raw));
    assert.equal(await importEdits(out, base, [rel]), 0);
    assert.equal(todo("c_0001").done || false, false);
    base = exportOnce(out);
}

// a multi-line item text shares the body with the notes: status still applies, title and body do not
{
    const rel = relOf(base, "c_0001");
    edit(rel, s => s.replace("# 5. two", "# 5. renamed").replace('status: "pending"', "status: done"));
    assert.equal(await importEdits(out, base, [rel]), 1);
    assert.equal(todo("c_0001").done, true);
    assert.equal(todo("c_0001").text, "5. two\nlines");
    base = exportOnce(out);
}

// values the tools would not take are dropped, and a reformat with no change sends nothing
{
    const note = { list: "proj", id: "x", status: "pending", priority: "", due: "", title: "t", body: "" };
    assert.deepEqual(noteOps(note, { ...note, status: "bogus", priority: "huge", due: "tomorrow" }, note, false), []);
    assert.deepEqual(noteOps(note, { ...note }, note, false), []);
    assert.deepEqual(noteOps(note, { ...note, title: "" }, note, false), [], "an emptied heading never blanks the item");
    assert.deepEqual(noteOps(note, { ...note, title: null, body: null }, note, false), [], "a note with no heading keeps text and notes");
    assert.deepEqual(noteOps(undefined, note, note, false), [], "a note the exporter never wrote is not an item edit");
    assert.deepEqual(noteOps({ ...note, status: "done" }, note, { ...note, status: "done" }, false), [{ tool: "update_todo", args: { list: "proj", id: "x", done: false } }]);
    assert.deepEqual(noteOps({ ...note, priority: "urgent", due: "2026-12-01" }, note, { ...note, priority: "urgent", due: "2026-12-01" }, false),
        [{ tool: "update_todo", args: { list: "proj", id: "x", priority: "none", due: "" } }]);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("vault-import.test.mjs ok");
