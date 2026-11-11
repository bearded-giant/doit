import { memStore } from "@doit/core/store.js";

// The handlers' store is synchronous, so one op loads every live list and notes doc up front
// (single user, small docs) and flush() writes back what changed, each row with a fresh change_seq.
export async function loadPgStore(client) {
    const lists = await client.query("select id, name, doc, version from lists where deleted_at is null");
    const notes = await client.query("select scope, doc from notes");
    const base = memStore(Object.fromEntries(lists.rows.map(r => [r.name, r.doc])));
    for (const r of notes.rows) base.notes.set(r.scope, r.doc);
    const rows = new Map(lists.rows.map(r => [r.name, { id: r.id }]));
    const before = new Map(lists.rows.map(r => [r.name, itemsOf(r.doc)]));
    const renames = [];
    const archives = [];

    const store = {
        ...base,
        pathOf: name => `lists/${name}`,
        renameList(from, to) {
            renames.push([from, to]);
            base.renameList(from, to);
        },
        archiveList(name, stamp) {
            archives.push(name);
            return base.archiveList(name, stamp);
        },
        async flush(client) {
            let last = null;
            const seq = async () => {
                const r = await client.query("select nextval('change_seq') as s");
                last = Number(r.rows[0].s);
                return last;
            };
            for (const [from, to] of renames) {
                const row = rows.get(from);
                if (!row) continue;
                rows.delete(from);
                rows.set(to, row);
                before.set(to, before.get(from) || new Map());
                await client.query("update lists set name = $1, version = version + 1, change_seq = $2 where id = $3", [to, await seq(), row.id]);
            }
            for (const name of archives) {
                const row = rows.get(name);
                if (!row) continue;
                rows.delete(name);
                await client.query("update lists set deleted_at = now(), version = version + 1, change_seq = $1 where id = $2", [await seq(), row.id]);
            }
            for (const key of base.dirty()) {
                if (key.startsWith("notes/")) {
                    const scope = key.slice("notes/".length);
                    const doc = base.notes.get(scope);
                    if (doc === undefined) continue;
                    await client.query(
                        `insert into notes (scope, doc, version, change_seq) values ($1, $2, 1, $3)
                         on conflict (scope) do update set doc = excluded.doc, version = notes.version + 1, change_seq = excluded.change_seq`,
                        [scope, JSON.stringify(doc), await seq()],
                    );
                    continue;
                }
                if (!base.docs.has(key)) continue;
                const doc = JSON.stringify(base.docs.get(key));
                const row = rows.get(key);
                if (row) {
                    await client.query("update lists set doc = $1, version = version + 1, change_seq = $2 where id = $3", [doc, await seq(), row.id]);
                } else {
                    const r = await client.query(
                        "insert into lists (id, name, doc, version, change_seq) values (gen_random_uuid(), $1, $2, 1, $3) returning id",
                        [key, doc, await seq()],
                    );
                    rows.set(key, { id: r.rows[0].id });
                }
            }
            return last;
        },
        // one row per item whose JSON changed, appeared or vanished in a list the op touched
        itemEvents() {
            const out = [];
            for (const key of base.dirty()) {
                if (key.startsWith("notes/") || !base.docs.has(key)) continue;
                const was = before.get(key) || new Map();
                const now = itemsOf(base.docs.get(key));
                for (const [id, json] of now) {
                    if (!was.has(id)) out.push({ list: key, todo_id: id, kind: "added", item: JSON.parse(json) });
                    else if (was.get(id) !== json) {
                        const item = JSON.parse(json);
                        out.push({ list: key, todo_id: id, kind: "changed", change: changeOf(JSON.parse(was.get(id)), item), item });
                    }
                }
                for (const [id, json] of was) if (!now.has(id)) out.push({ list: key, todo_id: id, kind: "removed", item: JSON.parse(json) });
            }
            return out;
        },
    };
    return store;
}

const ORDER_KEYS = new Set(["order_index", "sequence", "updated_at"]);

export function changeOf(was, now) {
    if (Boolean(was.done) !== Boolean(now.done)) return now.done ? "done" : "reopened";
    if (Boolean(was.in_progress) !== Boolean(now.in_progress)) return now.in_progress ? "started" : "stopped";
    const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
    const edited = [...keys].some(k => !ORDER_KEYS.has(k) && JSON.stringify(was[k]) !== JSON.stringify(now[k]));
    return edited ? "edited" : "reordered";
}

function itemsOf(doc) {
    return new Map((doc?.todos || []).filter(t => t && t.id).map(t => [t.id, JSON.stringify(t)]));
}
