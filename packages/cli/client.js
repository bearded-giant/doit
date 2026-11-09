import http from "http";
import { localTz } from "@doit/core/ctx.js";
import { acquireLock, applyOp, dataDir, lockHolder, paths, stateDir } from "@doit/daemon/local.js";

// a warm daemon answers in milliseconds; the first call after a start can take over a second
export const CALL_TIMEOUT_MS = Number(process.env.DOIT_CALL_TIMEOUT_MS) || 5000;

export function socketRequest(socketPath, method, pathname, body, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath, method, path: pathname, headers: { "content-type": "application/json" }, timeout: timeoutMs }, res => {
            let data = "";
            res.setEncoding("utf-8");
            res.on("data", chunk => { data += chunk; });
            res.on("end", () => {
                try {
                    resolve({ status: res.statusCode, json: JSON.parse(data || "null") });
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on("timeout", () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

// doitd answers: its result. Socket dead and the lock free: apply here under the lock, same code,
// same outbox. Lock held by a live daemon that does not answer within the timeout: an error, never a second writer.
export async function doitCall({ tool, args = {}, source = "user", active_list, active_list_note, tz = localTz() }, { state = stateDir(), timeoutMs = CALL_TIMEOUT_MS } = {}) {
    const p = paths(state);
    // the daemon refuses a data dir other than its own, so a process pointed elsewhere never writes through it
    const body = { tool, args, source, active_list, active_list_note, tz, data_dir: dataDir() };
    try {
        return (await socketRequest(p.socket, "POST", "/call", body, timeoutMs)).json;
    } catch (err) {
        const holder = lockHolder(p.lock);
        if (holder) {
            throw new Error(`doitd (pid ${holder.pid}) holds ${p.lock} but ${p.socket} did not answer (${err.message}). Stop or restart the daemon: doit daemon status.`);
        }
        const release = acquireLock(p.lock);
        try {
            return await applyOp({ state }, body);
        } catch (applyErr) {
            return { ok: false, error: applyErr.message };
        } finally {
            release();
        }
    }
}
