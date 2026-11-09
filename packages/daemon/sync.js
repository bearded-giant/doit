import fs from "fs";
import path from "path";
import { createCtx } from "@doit/core/ctx.js";
import { remapOps } from "@doit/core/ops.js";
import { fileStore, memStore } from "@doit/core/store.js";
import { runTool } from "@doit/core/tools.js";
import { applyViewEffect, noView } from "@doit/core/view.js";
import { appendLine, hostName, paths, readJson, readLines, writeJsonAtomic, writeLines, writeState } from "./local.js";

const BATCH = 50;
const REQUEST_TIMEOUT_MS = Number(process.env.DOIT_SYNC_TIMEOUT_MS) || 15000;

export class AuthError extends Error {}

export function readToken(p) {
    if (process.env.DOIT_TOKEN) return process.env.DOIT_TOKEN;
    try {
        return fs.readFileSync(p.token, "utf-8").trim();
    } catch {
        throw new AuthError(`no token at ${p.token}; mint one with doit-server-token add <machine> and store it there (mode 0600)`);
    }
}

async function api(cfg, method, route, body) {
    const p = paths(cfg.state);
    const res = await fetch(`${cfg.server.replace(/\/$/, "")}${route}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${readToken(p)}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) throw new AuthError(json.error || "token rejected");
    if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${json.error || ""}`.trim());
    return json;
}

const readCursor = p => ({ cursor: 0, server: null, last_pull_at: null, last_push_at: null, ...(readJson(p.cursor) || {}) });
const writeCursor = (p, extra) => writeJsonAtomic(p.cursor, { ...readCursor(p), ...extra });

// the cursor belongs to one server; a URL change means clone or import, never a partial pull
function checkServer(p, cfg) {
    const cur = readCursor(p);
    if (cur.server && cur.server !== cfg.server) {
        throw new Error(`sync/cursor.json belongs to ${cur.server}, not ${cfg.server}; run doit sync clone (empty data dir) or doit sync import`);
    }
}

function serverCopies(p) {
    const read = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".json")).map(f => readJson(path.join(dir, f))).filter(Boolean) : []);
    return { lists: read(p.serverDir), notes: read(p.serverNotesDir) };
}

const bytesOf = doc => JSON.stringify(doc, null, 2);
const sameBytes = (file, doc) => {
    try {
        return fs.readFileSync(file, "utf-8") === bytesOf(doc);
    } catch {
        return false;
    }
};

// Rebuilds the replica from the stored server copies with acked-unpulled ops and pending ops
// replayed in order. A pending op that fails here stays queued; the server decides its fate.
export async function rebase(cfg, scope = []) {
    const p = paths(cfg.state);
    const copies = serverCopies(p);
    const store = memStore(Object.fromEntries(copies.lists.map(c => [c.name, c.doc])));
    for (const n of copies.notes) store.notes.set(n.scope, structuredClone(n.doc));
    const touched = new Set(scope);
    for (const op of [...readLines(p.acked), ...readLines(p.outbox)]) {
        for (const l of op.lists || []) touched.add(l);
        const ctx = createCtx({
            store, view: noView, ts: op.ts, tz: op.tz, opId: op.op_id, source: op.source, host: cfg.host,
            activeList: op.args?.list || op.args?.from_list || "daily",
        });
        try {
            await runTool(ctx, op.tool, op.args || {});
        } catch {
            // the server rejects or applies it; the replica shows the server's view until then
        }
    }
    for (const k of store.dirty()) touched.add(k);
    const replica = fileStore(cfg.data);
    const changed = [];
    for (const key of touched) {
        if (key.startsWith("notes/")) {
            const scopeName = key.slice("notes/".length);
            const doc = store.notes.get(scopeName);
            if (doc === undefined || sameBytes(path.join(cfg.data, "notes", `${scopeName}.json`), doc)) continue;
            replica.putNotes(scopeName, doc);
            changed.push(key);
            continue;
        }
        const doc = store.docs.get(key);
        if (doc === undefined || sameBytes(replica.pathOf(key), doc)) continue;
        replica.putList(key, doc);
        changed.push(key);
    }
    return changed;
}

export async function push(cfg) {
    const p = paths(cfg.state);
    checkServer(p, cfg);
    const scope = new Set();
    let failed = 0;
    let sent = 0;
    for (;;) {
        const outbox = readLines(p.outbox);
        if (!outbox.length) break;
        const batch = outbox.slice(0, BATCH);
        const { results = [] } = await api(cfg, "POST", "/api/ops", { ops: batch });
        if (results.length !== batch.length) throw new Error(`server answered ${results.length} results for ${batch.length} ops`);
        // /call kept appending while the request was out; only the sent ops leave
        const sentIds = new Set(batch.map(o => o.op_id));
        let rest = readLines(p.outbox).filter(o => !sentIds.has(o.op_id));
        batch.forEach((op, i) => {
            const r = results[i];
            if (r.status === "applied") {
                if (r.change_seq != null) appendLine(p.acked, { ...op, change_seq: r.change_seq });
                if (r.rank_remap) rest = remapOps(rest, r.rank_remap);
            } else if (r.status !== "duplicate") {
                appendLine(p.conflicts, { ...op, error: r.error || r.status, failed_at: new Date().toISOString() });
                for (const l of op.lists || []) scope.add(l);
                failed++;
            }
        });
        writeLines(p.outbox, rest);
        sent += batch.length;
    }
    const now = new Date().toISOString();
    if (sent) writeCursor(p, { server: cfg.server, last_push_at: now });
    // a rejected op changed nothing on the server, so the replica comes back from the copies at once
    const changed = failed ? await rebase(cfg, [...scope]) : [];
    writeState(p, { online: true, error: null, ...(sent ? { last_push_at: now } : {}) });
    return { sent, failed, changed };
}

export async function pull(cfg) {
    const p = paths(cfg.state);
    checkServer(p, cfg);
    const cur = readCursor(p);
    const res = await api(cfg, "GET", `/api/sync/changes?cursor=${cur.cursor}`);
    const replica = fileStore(cfg.data);
    const view = cfg.view || noView;
    const scope = new Set();
    for (const row of res.lists || []) {
        const copyFile = path.join(p.serverDir, `${row.id}.json`);
        const prev = readJson(copyFile);
        if (row.deleted_at) {
            if (!prev) continue;
            if (fs.existsSync(replica.pathOf(prev.name))) replica.archiveList(prev.name, Date.now());
            applyViewEffect(view, "delete_list", { name: prev.name });
            fs.rmSync(copyFile, { force: true });
            continue;
        }
        if (prev && prev.name !== row.name) {
            if (fs.existsSync(replica.pathOf(prev.name)) && !fs.existsSync(replica.pathOf(row.name))) replica.renameList(prev.name, row.name);
            applyViewEffect(view, "rename_list", { old_name: prev.name, new_name: row.name });
        }
        writeJsonAtomic(copyFile, { id: row.id, name: row.name, change_seq: row.change_seq, doc: row.doc });
        scope.add(row.name);
    }
    for (const n of res.notes || []) {
        writeJsonAtomic(path.join(p.serverNotesDir, `${n.scope}.json`), { scope: n.scope, change_seq: n.change_seq, doc: n.doc });
        scope.add(`notes/${n.scope}`);
    }
    const cursor = Math.max(cur.cursor, Number(res.cursor) || 0);
    writeLines(p.acked, readLines(p.acked).filter(a => a.change_seq > cursor));
    const now = new Date().toISOString();
    writeCursor(p, { cursor, server: cfg.server, last_pull_at: now });
    const changed = scope.size ? await rebase(cfg, [...scope]) : [];
    writeState(p, { online: true, error: null, last_pull_at: now });
    return { cursor, pulled: scope.size, changed };
}

function resetSync(p, cfg) {
    writeLines(p.outbox, []);
    writeLines(p.acked, []);
    fs.rmSync(p.serverDir, { recursive: true, force: true });
    fs.rmSync(p.serverNotesDir, { recursive: true, force: true });
    writeJsonAtomic(p.cursor, { cursor: 0, server: cfg.server, last_pull_at: null, last_push_at: null });
}

// one-time upload of this machine's docs onto an empty server; the pull that follows stores the
// server copies, so the outbox starts empty and the first push sends nothing
export async function importDocs(cfg) {
    const p = paths(cfg.state);
    const replica = fileStore(cfg.data);
    const lists = Object.fromEntries(replica.listNames().map(n => [n, replica.getList(n)]));
    const notesDir = path.join(cfg.data, "notes");
    const notes = fs.existsSync(notesDir)
        ? Object.fromEntries(fs.readdirSync(notesDir).filter(f => f.endsWith(".json")).map(f => [f.slice(0, -5), readJson(path.join(notesDir, f))]).filter(([, d]) => d !== null))
        : {};
    const out = await api(cfg, "POST", "/api/sync/import", { lists, notes });
    resetSync(p, cfg);
    const pulled = await pull(cfg);
    return { lists: out.lists, notes: out.notes, cursor: pulled.cursor, changed: pulled.changed };
}

// a fresh machine: every live server list lands as a replica file
export async function clone(cfg) {
    const p = paths(cfg.state);
    const replica = fileStore(cfg.data);
    if (replica.listNames().length) throw new Error(`${path.join(cfg.data, "lists")} is not empty; clone needs an empty data dir`);
    resetSync(p, cfg);
    const pulled = await pull(cfg);
    return { lists: pulled.changed.filter(k => !k.startsWith("notes/")).length, cursor: pulled.cursor, changed: pulled.changed };
}

export const syncConfig = ({ data, state, server, host = hostName(), view = noView } = {}) => ({ data, state, server, host, view });

// The daemon's loop: push whatever is queued, then pull; every 10 s online, backing off 2 s..60 s
// offline, at once after a queued /call, and when the clock jumps (sleep, wake).
export function createSyncer(cfg, { log = () => {}, onChange = () => {} } = {}) {
    const p = paths(cfg.state);
    let nextAt = Date.now();
    let backoff = 2000;
    let inflight = null;
    let lastTick = Date.now();
    let lastPull = 0;

    async function run() {
        try {
            const pushed = await push(cfg);
            const pulled = await pull(cfg);
            lastPull = Date.now();
            backoff = 2000;
            nextAt = lastPull + 10000;
            const changed = [...pushed.changed, ...pulled.changed];
            if (changed.length) onChange(changed);
            if (pushed.sent || pulled.pulled) log(`sync: pushed ${pushed.sent} (${pushed.failed} failed), pulled ${pulled.pulled}, cursor ${pulled.cursor}`);
            return { pushed, pulled };
        } catch (err) {
            writeState(p, { online: false, error: err.message });
            nextAt = Date.now() + backoff;
            backoff = Math.min(backoff * 2, 60000);
            log(`sync: offline (${err.message}); retry in ${Math.round((nextAt - Date.now()) / 1000)} s`);
            throw err;
        }
    }

    // one cycle at a time; a request during one joins it
    function cycle() {
        if (!inflight) inflight = run().finally(() => { inflight = null; });
        return inflight;
    }

    const timer = setInterval(() => {
        const now = Date.now();
        if (now - lastTick > 30000) nextAt = now;
        lastTick = now;
        if (now >= nextAt) {
            nextAt = now + 10000;
            cycle().catch(() => {});
        }
    }, 1000);
    timer.unref();

    return {
        // a queued op goes out right away; a /call with a stale replica pulls after it answered
        kick() {
            nextAt = Date.now();
        },
        afterCall() {
            if (Date.now() - lastPull > 10000) nextAt = Date.now();
        },
        cycle,
        stop: () => clearInterval(timer),
    };
}
