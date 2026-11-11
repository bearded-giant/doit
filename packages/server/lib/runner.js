import { createCtx } from "@doit/core/ctx.js";
import { remapOps } from "@doit/core/ops.js";
import { runTool } from "@doit/core/tools.js";
import { noView } from "@doit/core/view.js";
import { loadPgStore } from "./pgStore.js";

// every writer serializes here; single user, so one global lock and no deadlocks
const LOCK = "select pg_advisory_xact_lock(4242)";

// a remapped rank rewrites the rest of the batch here, the same way doitd rewrites its outbox
export async function applyOps(pool, ops, { host }) {
    const results = [];
    let rest = ops;
    while (rest.length) {
        const [op, ...tail] = rest;
        const r = await applyOne(pool, op, host);
        results.push(r);
        rest = r.rank_remap ? remapOps(tail, r.rank_remap) : tail;
    }
    return results;
}

async function applyOne(pool, op, host) {
    const client = await pool.connect();
    try {
        await client.query("begin");
        await client.query(LOCK);
        const seen = await client.query("select result from applied_ops where op_id = $1", [op.op_id]);
        if (seen.rowCount) {
            await client.query("rollback");
            return { op_id: op.op_id, status: "duplicate", text: seen.rows[0].result?.text };
        }
        const store = await loadPgStore(client);
        const ctx = createCtx({
            store, view: noView, ts: op.ts, tz: op.tz, opId: op.op_id, source: op.source || "user", host,
            activeList: op.args?.list || op.args?.from_list || "daily",
        });
        let result;
        try {
            result = await runTool(ctx, op.tool, op.args || {});
        } catch (err) {
            // a rejected op changed nothing; the client records it as a conflict
            await client.query("rollback");
            return { op_id: op.op_id, status: "failed", error: err.message };
        }
        const changeSeq = await store.flush(client);
        const text = (result.content || []).map(c => c.text).join("\n");
        await client.query(
            "insert into applied_ops (op_id, host, source, tool, ok, result) values ($1, $2, $3, $4, true, $5)",
            [op.op_id, host, op.source || "user", op.tool, { text, resolved: ctx.resolved }],
        );
        for (const ev of store.itemEvents()) {
            await client.query(
                "insert into events (host, source, tool, list, todo_id, payload) values ($1, $2, $3, $4, $5, $6)",
                [host, op.source || "user", op.tool, ev.list, ev.todo_id, { kind: ev.kind, change: ev.change, text: ev.item.text, done: ev.item.done, in_progress: ev.item.in_progress, priorities: ev.item.priorities, twin: ev.item.twin }],
            );
        }
        await client.query("commit");
        const out = { op_id: op.op_id, status: "applied", change_seq: changeSeq, text };
        if (ctx.resolved.rank_remap) out.rank_remap = ctx.resolved.rank_remap;
        return out;
    } catch (err) {
        await client.query("rollback").catch(() => {});
        return { op_id: op.op_id, status: "failed", error: err.message };
    } finally {
        client.release();
    }
}

export async function changesSince(client, cursor) {
    const lists = await client.query(
        "select id, name, deleted_at, doc, change_seq from lists where change_seq > $1 order by change_seq",
        [cursor],
    );
    const notes = await client.query("select scope, doc, change_seq from notes where change_seq > $1 order by change_seq", [cursor]);
    const seq = await client.query("select last_value, is_called from change_seq");
    const current = seq.rows[0].is_called ? Number(seq.rows[0].last_value) : 0;
    return {
        cursor: Math.max(cursor, current),
        lists: lists.rows.map(r => ({ ...r, change_seq: Number(r.change_seq) })),
        notes: notes.rows.map(r => ({ ...r, change_seq: Number(r.change_seq) })),
    };
}

// first upload of a machine's docs; refused once anything is in the tables
export async function importDocs(pool, { lists = {}, notes = {} }) {
    const client = await pool.connect();
    try {
        await client.query("begin");
        await client.query(LOCK);
        const have = await client.query("select (select count(*) from lists) + (select count(*) from notes) as n");
        if (Number(have.rows[0].n) > 0) {
            await client.query("rollback");
            return { error: "server is not empty; import only seeds an empty server" };
        }
        let cursor = 0;
        for (const [name, doc] of Object.entries(lists)) {
            const r = await client.query("select nextval('change_seq') as s");
            cursor = Number(r.rows[0].s);
            await client.query("insert into lists (id, name, doc, version, change_seq) values (gen_random_uuid(), $1, $2, 1, $3)", [name, JSON.stringify(doc), cursor]);
        }
        for (const [scope, doc] of Object.entries(notes)) {
            const r = await client.query("select nextval('change_seq') as s");
            cursor = Number(r.rows[0].s);
            await client.query("insert into notes (scope, doc, version, change_seq) values ($1, $2, 1, $3)", [scope, JSON.stringify(doc), cursor]);
        }
        await client.query("commit");
        return { cursor, lists: Object.keys(lists).length, notes: Object.keys(notes).length };
    } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}
