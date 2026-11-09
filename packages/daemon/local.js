import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { createCtx, localTz } from "@doit/core/ctx.js";
import { pinArgs } from "@doit/core/ops.js";
import { fileStore } from "@doit/core/store.js";
import { runTool } from "@doit/core/tools.js";
import { noView } from "@doit/core/view.js";

export const dataDir = () => process.env.DOIT_DATA_DIR || path.join(os.homedir(), ".local/share/nvim/doit");
// runtime state lives outside the data dir so a file sync of the lists never carries the socket, lock or outbox
export const stateDir = () => process.env.DOIT_STATE_DIR || path.join(os.homedir(), ".local/state/doit");
export const serverUrl = () => process.env.DOIT_SERVER_URL || "";
export const hostName = () => process.env.DOIT_HOST || os.hostname();

export function paths(state = stateDir()) {
    const sync = path.join(state, "sync");
    return {
        state,
        socket: path.join(state, "doitd.sock"),
        lock: path.join(state, "doitd.lock"),
        token: path.join(state, "token"),
        log: path.join(state, "doitd.log"),
        sync,
        outbox: path.join(sync, "outbox.jsonl"),
        acked: path.join(sync, "acked.jsonl"),
        conflicts: path.join(sync, "conflicts.jsonl"),
        cursor: path.join(sync, "cursor.json"),
        stateFile: path.join(sync, "state.json"),
    };
}

export function ensureStateDir(state) {
    fs.mkdirSync(path.join(state, "sync"), { recursive: true, mode: 0o700 });
    fs.chmodSync(state, 0o700);
}

// time-ordered ids, so the outbox and applied_ops sort by mint time
export function uuidv7(ts = Date.now()) {
    const r = randomBytes(10);
    r[0] = (r[0] & 0x0f) | 0x70;
    r[2] = (r[2] & 0x3f) | 0x80;
    const t = ts.toString(16).padStart(12, "0");
    const h = r.toString("hex");
    return `${t.slice(0, 8)}-${t.slice(8, 12)}-${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 20)}`;
}

// a pid alone can be reused after a crash; the start time tells the old holder from a new process
export function procStart(pid) {
    try {
        process.kill(pid, 0);
    } catch {
        return null;
    }
    try {
        return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "alive";
    } catch {
        return "alive";
    }
}

export function readLock(lockPath) {
    try {
        return JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    } catch {
        return null;
    }
}

// the live holder of the lock, or null when it is free or left by a dead process
export function lockHolder(lockPath) {
    const lock = readLock(lockPath);
    if (!lock) return null;
    return procStart(lock.pid) === lock.start ? lock : null;
}

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function acquireLock(lockPath, { retries = 0, delayMs = 1000 } = {}) {
    for (let attempt = 0; ; attempt++) {
        try {
            const fd = fs.openSync(lockPath, "wx", 0o600);
            fs.writeSync(fd, JSON.stringify({ pid: process.pid, start: procStart(process.pid) }));
            fs.closeSync(fd);
            return () => {
                if (readLock(lockPath)?.pid === process.pid) fs.rmSync(lockPath, { force: true });
            };
        } catch (err) {
            if (err.code !== "EEXIST") throw err;
            const holder = lockHolder(lockPath);
            if (!holder) {
                fs.rmSync(lockPath, { force: true });
                continue;
            }
            if (attempt >= retries) {
                const e = new Error(`doitd (pid ${holder.pid}) holds ${lockPath}`);
                e.holder = holder;
                throw e;
            }
            sleepSync(delayMs);
        }
    }
}

export function readLines(file) {
    try {
        return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l));
    } catch {
        return [];
    }
}

export function appendLine(file, record) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "a", 0o600);
    try {
        fs.writeSync(fd, `${JSON.stringify(record)}\n`);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

export function writeJsonAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

export function readState(p) {
    let prev = {};
    try {
        prev = JSON.parse(fs.readFileSync(p.stateFile, "utf-8"));
    } catch {
        // first run
    }
    const sync = Boolean(serverUrl());
    return {
        mode: sync ? "sync" : "local",
        online: sync ? Boolean(prev.online) : null,
        queue: readLines(p.outbox).length,
        conflicts: readLines(p.conflicts).length,
        last_pull_at: prev.last_pull_at ?? null,
        last_push_at: prev.last_push_at ?? null,
        error: prev.error ?? null,
        data_dir: prev.data_dir ?? null,
    };
}

// surfaces read this file for their badge
export function writeState(p, extra = {}) {
    const state = { ...readState(p), ...extra };
    writeJsonAtomic(p.stateFile, state);
    return state;
}

// Applies one tool call to the replica under an op ctx. The op is queued for the server only when
// a doc changed and a server is configured: local-only mode never builds a backlog that an import
// would replay onto docs that already contain it.
export async function applyOp(
    { data = dataDir(), state = stateDir(), server = serverUrl(), host = hostName(), view = noView } = {},
    { tool, args = {}, source = "user", active_list, active_list_note = "", tz = localTz() },
) {
    const opId = uuidv7();
    const ts = Date.now();
    const store = fileStore(data);
    const ctx = createCtx({ store, view, ts, tz, opId, source, host, activeList: active_list || "daily", activeListNote: active_list_note });
    const result = await runTool(ctx, tool, args);
    const lists = store.dirty();
    const text = (result.content || []).map(c => c.text).join("\n");
    let queued = false;
    if (lists.length && server) {
        appendLine(paths(state).outbox, { op_id: opId, ts, tz, host, source, tool, args: pinArgs(args, ctx.resolved), lists });
        queued = true;
    }
    return { ok: true, text, op_id: opId, lists, queued, resolved: ctx.resolved };
}
