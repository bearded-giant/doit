#!/usr/bin/env node

// Mirrors every list into an Obsidian vault folder: a dir per list, a note per item, so lists can
// be browsed, linked, and read beside other notes. Under --watch, edits to an item note's status,
// priority, due date, title, and body go back to the lists through doitd.

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { doitCall } from "@doit/cli/client.js";
import { isSequenced } from "@doit/core/sequence.js";
import { normalizeTodoText, parseDeps, parseTags, parseTodoText } from "@doit/core/todo-text.js";

const DATA_DIR = process.env.DOIT_DATA_DIR || path.join(process.env.HOME, ".local/share/nvim/doit");
const LISTS_DIR = path.join(DATA_DIR, "lists");
const AGENT_LABEL = "com.doit.vault-export";
const USAGE = "usage: vault-export.js <out_dir> [--watch | --install]";

const PRIORITY_LABELS = { critical: "!!!", urgent: "!!", important: "!" };
const PRIORITY_RANK = { critical: 0, urgent: 1, important: 2 };
const DUE = /^(\d{4}-\d{2}-\d{2})?$/;
const FOOTER = /\n*-{10}\nlast [a-z]+:\s*([^\n]*)\s*$/;
// only notes carrying this key are pruned, so files the user drops in the folder survive
const GENERATED = /^---\n(?:.*\n)*?doit_list: /;

function slugify(text) {
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug.length > 48 ? slug.slice(0, 48).replace(/-[^-]*$/, "") : slug;
}

function stamp(epoch) {
    const n = Number(epoch);
    if (!n) return undefined;
    const d = new Date(n * 1000);
    const p = v => String(v).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const label = text => text.replace(/[[\]|]/g, " ").replace(/\s+/g, " ").trim();

// JSON strings are valid YAML double-quoted scalars, so values like "2026-10-15: 20:49" stay intact
function frontmatter(fields) {
    const value = v => (Array.isArray(v) ? `[${v.map(x => JSON.stringify(x)).join(", ")}]` : typeof v === "string" ? JSON.stringify(v) : v);
    const lines = Object.entries(fields)
        .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false)
        .map(([k, v]) => `${k}: ${value(v)}`);
    return `---\n${lines.join("\n")}\n---\n`;
}

function status(todo) {
    return todo.done ? "done" : todo.in_progress ? "in_progress" : "pending";
}

function pendingOrder(a, b) {
    const sa = isSequenced(a.todo);
    const sb = isSequenced(b.todo);
    if (sa !== sb) return sa ? -1 : 1;
    if (sa) return a.todo.sequence - b.todo.sequence;
    return (
        (PRIORITY_RANK[a.todo.priorities] ?? 3) - (PRIORITY_RANK[b.todo.priorities] ?? 3) ||
        (a.todo.order_index ?? 0) - (b.todo.order_index ?? 0)
    );
}

function place(name, entries, slugOf, dirOf) {
    const used = new Set([name]);
    return entries.map(entry => {
        const base = slugOf(entry) || "item";
        const file = used.has(base) ? `${base}-${String(entry.id).slice(-4)}` : base;
        used.add(file);
        return { entry, rel: `${name}/${dirOf(entry)}${file}` };
    });
}

function renderItem(list, { todo, parsed }, linkTo, idByRank) {
    const [title, ...rest] = parsed.body.split("\n");
    const description = todo.description || "";
    const footer = FOOTER.exec(description);
    const notes = description.replace(FOOTER, "").trim();
    const deps = parseDeps(todo.text)
        .map(rank => linkTo(idByRank.get(rank)))
        .filter(Boolean)
        .map(target => `[[${target}]]`);
    const twin = todo.twin && linkTo(todo.twin.id);
    const type = parsed.type && parsed.type.toLowerCase().replace(/[^\w\-/]+/g, "-");
    const head = frontmatter({
        id: `doit-${todo.id}`,
        aliases: [],
        tags: [...new Set(["doit", ...(type ? [`doit/${type}`] : []), ...parseTags(todo.text)])],
        area: "doit",
        project: list,
        doit_list: list,
        doit_id: todo.id,
        status: status(todo),
        priority: todo.priorities,
        type: parsed.type,
        rank: parsed.rankLabel,
        claude: parsed.claude,
        sequence: isSequenced(todo) ? todo.sequence : undefined,
        due: todo.due_date,
        created: stamp(todo.created_at),
        completed: todo.done ? stamp(todo.completed_at) : undefined,
        updated: footer ? footer[1].trim().replace(/^(\d{4}-\d{2}-\d{2}):?\s+/, "$1T") : undefined,
        deps: deps.length ? deps : undefined,
        twin: twin ? `[[${twin}]]` : undefined,
    });
    const body = [rest.join("\n").trim(), notes].filter(Boolean).join("\n\n");
    return `${head}\n# ${parsed.rankLabel ? `${parsed.rankLabel}. ` : ""}${title}\n${body ? `\n${body}\n` : ""}`;
}

// todo_ids may name deleted todos; only ones still exported become links
function renderNote(list, note, linkTo) {
    const todos = (Array.isArray(note.todo_ids) ? note.todo_ids : [])
        .map(linkTo)
        .filter(Boolean)
        .map(target => `[[${target}]]`);
    const head = frontmatter({
        id: `doit-note-${note.id}`,
        aliases: [],
        tags: ["doit", "doit/note"],
        area: "doit",
        project: list,
        doit_list: list,
        doit_note_id: note.id,
        created: stamp(note.created_at),
        updated: stamp(note.updated_at),
        todos: todos.length ? todos : undefined,
    });
    const body = (note.body || "").trim();
    return `${head}\n# ${note.title || "note"}\n${body ? `\n${body}\n` : ""}`;
}

function renderList(name, data, items, notes, root) {
    const line = ({ todo, parsed, rel }) => {
        const title = `${parsed.rankLabel ? `${parsed.rankLabel}. ` : ""}${label(parsed.body.split("\n")[0])}`;
        const flags = [parsed.type, PRIORITY_LABELS[todo.priorities], todo.due_date && `due ${todo.due_date}`];
        return [`- [[${root}/${rel}|${title}]]`, ...flags.filter(Boolean)].join(" · ");
    };
    const by = s => items.filter(i => status(i.todo) === s);
    const doing = by("in_progress");
    const pending = by("pending").sort(pendingOrder);
    const done = by("done").sort((a, b) => (b.todo.completed_at || 0) - (a.todo.completed_at || 0));
    const sections = [
        ["In progress", doing.map(line)],
        ["Pending", pending.map(line)],
        ["Done", done.map(line)],
        ["Notes", notes.map(({ entry, rel }) => `- [[${root}/${rel}|${label(entry.title || "note")}]]`)],
    ].filter(([, lines]) => lines.length);
    const head = frontmatter({
        id: `doit-list-${name}`,
        aliases: [],
        tags: ["doit", "doit/list"],
        area: "doit",
        project: name,
        doit_list: name,
        in_progress: doing.length,
        pending: pending.length,
        done: done.length,
        updated: stamp(data._metadata && data._metadata.updated_at),
    });
    const body = sections.map(([title, lines]) => `## ${title}\n\n${lines.join("\n")}\n`).join("\n");
    return { counts: [doing.length, pending.length, done.length], text: `${head}\n# ${name}\n${body ? `\n${body}` : ""}` };
}

// files keyed by path relative to the export dir; links are vault paths under `root`
export function buildVault(lists, root) {
    const files = new Map();
    const where = new Map();
    const placed = lists.map(({ name, data }) => {
        const items = place(
            name,
            data.todos || [],
            todo => [parseTodoText(todo.text).rankLabel, slugify(normalizeTodoText(todo.text))].filter(Boolean).join("-"),
            todo => (todo.done ? "done/" : ""),
        ).map(({ entry, rel }) => ({ todo: entry, parsed: parseTodoText(entry.text), rel }));
        for (const item of items) where.set(item.todo.id, `${root}/${item.rel}`);
        const notes = place(name, data.notes || [], note => slugify(note.title || ""), () => "notes/");
        return { name, data, items, notes };
    });
    const rows = [];
    for (const { name, data, items, notes } of placed) {
        const idByRank = new Map(items.filter(i => i.parsed.rankLabel).map(i => [i.parsed.rankLabel, i.todo.id]));
        for (const item of items) files.set(`${item.rel}.md`, renderItem(name, item, id => where.get(id), idByRank));
        for (const { entry, rel } of notes) files.set(`${rel}.md`, renderNote(name, entry, id => where.get(id)));
        const { counts, text } = renderList(name, data, items, notes, root);
        files.set(`${name}/${name}.md`, text);
        rows.push(`| [[${root}/${name}/${name}\\|${name}]] | ${counts.join(" | ")} |`);
    }
    const head = frontmatter({ id: root, aliases: [], tags: ["doit"], area: "doit" });
    const table = ["| list | in progress | pending | done |", "| --- | --- | --- | --- |", ...rows].join("\n");
    files.set(`${root}.md`, `${head}\n# doit todos\n\n${table}\n`);
    return files;
}

function readOrNull(file) {
    try {
        return fs.readFileSync(file, "utf-8");
    } catch {
        return null;
    }
}

// returns whether anything under `dir` was removed, so only dirs this export emptied get rmdir'd
function prune(outDir, dir, files, keep) {
    let removed = false;
    for (const entry of fs.readdirSync(path.join(outDir, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        const abs = path.join(outDir, rel);
        if (entry.isDirectory()) {
            if (keep.has(rel) || !prune(outDir, rel, files, keep)) continue;
            removed = true;
            if (!fs.readdirSync(abs).length) fs.rmdirSync(abs);
        } else if (rel.endsWith(".md") && !files.has(rel) && GENERATED.test(readOrNull(abs) || "")) {
            fs.unlinkSync(abs);
            removed = true;
        }
    }
    return removed;
}

// `keep` holds list dirs whose JSON failed to parse; their notes stay until a good read
export function syncDir(outDir, files, keep = new Set()) {
    for (const [rel, content] of files) {
        const abs = path.join(outDir, rel);
        if (readOrNull(abs) === content) continue;
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    prune(outDir, "", files, keep);
}

function readLists() {
    const lists = [];
    const broken = new Set();
    for (const file of fs.readdirSync(LISTS_DIR).filter(f => f.endsWith(".json")).sort()) {
        const name = file.slice(0, -".json".length);
        try {
            lists.push({ name, data: JSON.parse(fs.readFileSync(path.join(LISTS_DIR, file), "utf-8")) });
        } catch (err) {
            // deleted between the readdir and the read: gone, not broken
            if (err.code === "ENOENT") continue;
            broken.add(name);
            console.error(`skip ${file}: ${err.message}`);
        }
    }
    return { lists, broken };
}

export function exportOnce(outDir) {
    const { lists, broken } = readLists();
    const files = buildVault(lists, path.basename(outDir));
    syncDir(outDir, files, broken);
    return files;
}

// the editable part of an item note; null for any file that is not one
export function parseItemNote(content) {
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content || "");
    if (!m) return null;
    // Obsidian's property editor rewrites values unquoted, the exporter writes them as JSON strings
    const field = key => {
        const hit = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(m[1]);
        return hit ? hit[1].trim().replace(/^(["'])(.*)\1$/, "$2") : "";
    };
    const note = { list: field("doit_list"), id: field("doit_id"), status: field("status"), priority: field("priority"), due: field("due") };
    if (!note.list || !note.id) return null;
    const text = /^\s*# (?:\d+[a-z]*\. )?([^\n]*)\n?([\s\S]*)$/.exec(m[2]);
    return { ...note, title: text ? text[1].trim() : null, body: text ? text[2].trim() : null };
}

// One note's edits as tool calls. A field counts when it differs from the last export (base) and
// the lists still hold what that export showed (ours); a field the lists changed meanwhile stays theirs.
export function noteOps(base, disk, ours, multiline) {
    if (!base || !disk || !ours) return [];
    const edited = f => disk[f] !== null && disk[f] !== base[f] && ours[f] === base[f];
    const ref = { list: disk.list, id: disk.id };
    const update = {};
    const ops = [];
    if (edited("status")) {
        if (disk.status === "in_progress") ops.push({ tool: "start_todo", args: ref });
        else if (disk.status === "done") update.done = true;
        else if (disk.status === "pending") Object.assign(update, base.status === "done" ? { done: false } : { in_progress: false });
    }
    if (edited("priority") && (!disk.priority || disk.priority === "none" || disk.priority in PRIORITY_RANK)) {
        update.priority = disk.priority || "none";
    }
    if (edited("due") && DUE.test(disk.due)) update.due = disk.due;
    // a multi-line item text shares the note body with the notes, so an edit there cannot be told apart
    if (!multiline) {
        if (edited("title") && disk.title) update.text = disk.title;
        if (edited("body")) update.description = disk.body;
    }
    if (Object.keys(update).length) ops.push({ tool: "update_todo", args: { ...ref, ...update } });
    return ops;
}

// Sends the edits in `rels` (paths under outDir) through doitd, the single writer of the lists.
// `base` is the last export's files; a note still holding its exported content is the exporter's own write.
export async function importEdits(outDir, base, rels) {
    const { lists } = readLists();
    const index = files => {
        const byItem = new Map();
        for (const content of files.values()) {
            const note = parseItemNote(content);
            if (note) byItem.set(`${note.list}/${note.id}`, note);
        }
        return byItem;
    };
    let baseNotes;
    let ours;
    let sent = 0;
    for (const rel of rels) {
        const content = readOrNull(path.join(outDir, rel));
        if (content === null || content === base.get(rel)) continue;
        const disk = parseItemNote(content);
        if (!disk) continue;
        baseNotes ??= index(base);
        ours ??= index(buildVault(lists, path.basename(outDir)));
        const key = `${disk.list}/${disk.id}`;
        const todo = lists.find(l => l.name === disk.list)?.data.todos?.find(t => t.id === disk.id);
        const multiline = Boolean(todo) && parseTodoText(todo.text).body.includes("\n");
        for (const op of noteOps(baseNotes.get(key), disk, ours.get(key), multiline)) {
            const res = await doitCall({ ...op, source: "user", active_list: disk.list });
            if (res.ok) sent++;
            else console.error(`vault edit ${rel}: ${op.tool}: ${res.error}`);
        }
    }
    return sent;
}

// A list change or a vault edit schedules one debounced pass: vault edits go to doitd first, then the
// export rewrites whatever differs, so an edit is never overwritten before it is read. The export's
// own writes come back as vault events and match `base`, which ends the loop.
// shortcut: notes edited while no watcher ran are overwritten by its first export; import them at startup if that bites
function watch(outDir) {
    let base = new Map();
    const edited = new Set();
    let running = false;
    let again = false;
    let timer;
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(pass, 300);
    };
    const pass = async () => {
        if (running) {
            again = true;
            return;
        }
        running = true;
        try {
            const rels = [...edited];
            edited.clear();
            if (rels.length) await importEdits(outDir, base, rels);
            base = exportOnce(outDir);
        } catch (err) {
            console.error(err.stack);
        }
        running = false;
        if (again) {
            again = false;
            schedule();
        }
    };
    fs.mkdirSync(outDir, { recursive: true });
    pass();
    fs.watch(LISTS_DIR, schedule);
    fs.watch(outDir, { recursive: true }, (_, file) => {
        if (!file || !file.endsWith(".md")) return;
        edited.add(file.split(path.sep).join("/"));
        schedule();
    });
}

function install(outDir) {
    const xml = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const plist = path.join(process.env.HOME, "Library/LaunchAgents", `${AGENT_LABEL}.plist`);
    const log = path.join(DATA_DIR, "vault-export.log");
    const args = [process.execPath, fileURLToPath(import.meta.url), outDir, "--watch"];
    fs.writeFileSync(
        plist,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args.map(a => `        <string>${xml(a)}</string>`).join("\n")}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>DOIT_DATA_DIR</key>
        <string>${xml(DATA_DIR)}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(log)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(log)}</string>
</dict>
</plist>
`,
    );
    const domain = `gui/${process.getuid()}`;
    try {
        execFileSync("launchctl", ["bootout", `${domain}/${AGENT_LABEL}`], { stdio: "ignore" });
    } catch {
        // not loaded yet
    }
    for (let attempt = 1; ; attempt++) {
        try {
            execFileSync("launchctl", ["bootstrap", domain, plist], { stdio: "pipe" });
            break;
        } catch (err) {
            // bootout returns before launchd has torn the old job down; bootstrap gets EIO until it is gone
            if (attempt === 5) throw err;
            execFileSync("sleep", ["1"]);
        }
    }
    console.log(`installed ${plist}\nlog: ${log}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [outArg, mode] = process.argv.slice(2);
    if (!outArg || (mode && mode !== "--watch" && mode !== "--install")) {
        console.error(USAGE);
        process.exit(1);
    }
    const outDir = path.resolve(outArg.replace(/^~(?=\/|$)/, process.env.HOME));
    if (mode === "--install") install(outDir);
    else if (mode === "--watch") watch(outDir);
    else exportOnce(outDir);
}
