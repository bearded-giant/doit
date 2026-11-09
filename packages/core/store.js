import fs from "fs";
import path from "path";

const PRIORITY_WEIGHT = { critical: 3, urgent: 2, important: 1 };

// nvim's load-time migrations (lua/doit/modules/todos/state/storage.lua load_list) live here
// so every surface reads one shape; a doc is written back only when a handler saves it
export function normalizeDoc(doc) {
    // nvim encodes an empty Lua table as [], and properties set on an array are lost on save
    if (!doc._metadata || typeof doc._metadata !== "object" || Array.isArray(doc._metadata)) doc._metadata = {};
    if (!Array.isArray(doc.todos)) doc.todos = [];
    if (doc.notes !== undefined && !Array.isArray(doc.notes)) doc.notes = [];
    const todos = doc.todos;
    const ids = new Set(todos.map(t => t.id).filter(Boolean));
    todos.forEach((t, i) => {
        for (const k of Object.keys(t)) if (k.startsWith("_")) delete t[k];
        if (t.order_index === undefined) t.order_index = i + 1;
        if (t.timestamp !== undefined) {
            if (t.created_at === undefined) t.created_at = t.timestamp;
            delete t.timestamp;
        }
        if (!t.id) {
            t.id = `${t.created_at || 0}_${String(i + 1).padStart(7, "0")}`;
            ids.add(t.id);
        }
        if (t.parent_id && !ids.has(t.parent_id)) {
            delete t.parent_id;
            t.depth = 0;
        }
        if (!t.parent_id && (t.depth || 0) !== 0) t.depth = 0;
        if (Array.isArray(t.priorities)) {
            const best = t.priorities.filter(p => PRIORITY_WEIGHT[p]).sort((a, b) => PRIORITY_WEIGHT[b] - PRIORITY_WEIGHT[a])[0];
            if (best) t.priorities = best;
            else delete t.priorities;
        }
    });
    return doc;
}

const bytesOf = doc => JSON.stringify(doc, null, 2);

function dirtyTracker() {
    const original = new Map();
    const dirty = new Set();
    return {
        snap(key, bytes) {
            if (!original.has(key)) original.set(key, bytes ?? "");
        },
        mark(key, bytes) {
            if (bytes !== original.get(key)) dirty.add(key);
            else dirty.delete(key);
        },
        force: key => dirty.add(key),
        list: () => [...dirty],
    };
}

export function fileStore(dataDir) {
    const listsDir = path.join(dataDir, "lists");
    const notesDir = path.join(dataDir, "notes");
    const docs = new Map();
    const track = dirtyTracker();
    const listPath = name => path.join(listsDir, `${name}.json`);
    const notesPath = scope => path.join(notesDir, `${scope}.json`);
    const readRaw = p => {
        try {
            return fs.readFileSync(p, "utf-8");
        } catch (err) {
            if (err.code === "ENOENT") return null;
            throw err;
        }
    };
    const write = (p, key, doc) => {
        track.snap(key, readRaw(p));
        const bytes = bytesOf(doc);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, p);
        track.mark(key, bytes);
    };
    const store = {
        pathOf: listPath,
        listNames: () => (fs.existsSync(listsDir) ? fs.readdirSync(listsDir).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)).sort() : []),
        getList(name) {
            if (docs.has(name)) return docs.get(name);
            const raw = readRaw(listPath(name));
            if (raw === null) return null;
            track.snap(name, raw);
            const doc = normalizeDoc(JSON.parse(raw));
            docs.set(name, doc);
            return doc;
        },
        putList(name, doc) {
            docs.set(name, doc);
            write(listPath(name), name, doc);
        },
        findListByTodoId(id) {
            if (!id) return null;
            for (const name of store.listNames()) {
                const data = store.getList(name);
                if (data.todos.some(t => t.id === id)) return { name, data };
            }
            return null;
        },
        renameList(from, to) {
            fs.renameSync(listPath(from), listPath(to));
            if (docs.has(from)) docs.set(to, docs.get(from));
            docs.delete(from);
            track.force(from);
            track.force(to);
        },
        archiveList(name, stamp) {
            const archived = path.join(dataDir, "deleted", `${name}-${stamp}.json`);
            fs.mkdirSync(path.dirname(archived), { recursive: true });
            fs.renameSync(listPath(name), archived);
            docs.delete(name);
            track.force(name);
            return archived;
        },
        getNotes(scope) {
            const raw = readRaw(notesPath(scope));
            track.snap(`notes/${scope}`, raw);
            return raw === null ? null : JSON.parse(raw);
        },
        putNotes(scope, doc) {
            write(notesPath(scope), `notes/${scope}`, doc);
        },
        dirty: track.list,
    };
    return store;
}

// docs: {name: doc}; loader(name) lazily supplies a list the replay opens that was not seeded
export function memStore(initial = {}, loader = null) {
    const docs = new Map(Object.entries(initial).map(([k, v]) => [k, normalizeDoc(structuredClone(v))]));
    const notes = new Map();
    const track = dirtyTracker();
    const store = {
        pathOf: name => `lists/${name}.json`,
        listNames: () => [...docs.keys()].sort(),
        getList(name) {
            if (!docs.has(name) && loader) {
                const loaded = loader(name);
                if (loaded) docs.set(name, normalizeDoc(structuredClone(loaded)));
            }
            const doc = docs.get(name) ?? null;
            track.snap(name, doc === null ? null : bytesOf(doc));
            return doc;
        },
        putList(name, doc) {
            track.snap(name, docs.has(name) ? bytesOf(docs.get(name)) : null);
            docs.set(name, doc);
            track.mark(name, bytesOf(doc));
        },
        findListByTodoId(id) {
            if (!id) return null;
            for (const name of store.listNames()) {
                const data = store.getList(name);
                if (data.todos.some(t => t.id === id)) return { name, data };
            }
            return null;
        },
        renameList(from, to) {
            docs.set(to, docs.get(from));
            docs.delete(from);
            track.force(from);
            track.force(to);
        },
        archiveList(name, stamp) {
            docs.delete(name);
            track.force(name);
            return `deleted/${name}-${stamp}.json`;
        },
        getNotes(scope) {
            const doc = notes.get(scope) ?? null;
            track.snap(`notes/${scope}`, doc === null ? null : bytesOf(doc));
            return doc;
        },
        putNotes(scope, doc) {
            track.snap(`notes/${scope}`, notes.has(scope) ? bytesOf(notes.get(scope)) : null);
            notes.set(scope, doc);
            track.mark(`notes/${scope}`, bytesOf(doc));
        },
        docs,
        notes,
        dirty: track.list,
    };
    return store;
}
