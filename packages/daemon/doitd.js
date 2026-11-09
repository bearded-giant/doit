#!/usr/bin/env node

import fs from "fs";
import http from "http";
import { TOOLS } from "@doit/core/tools.js";
import { acquireLock, applyOp, dataDir, ensureStateDir, paths, readLines, readState, stateDir, writeState } from "./local.js";

const p = paths(stateDir());
ensureStateDir(p.state);

const log = msg => console.log(`${new Date().toISOString()} ${msg}`);

let release;
try {
    // a CLI fallback write may hold the lock for a moment; a live daemon holds it for good
    release = acquireLock(p.lock, { retries: 5, delayMs: Number(process.env.DOIT_LOCK_WAIT_MS) || 1000 });
} catch (err) {
    console.error(err.message);
    process.exit(1);
}

const watchers = new Set();
const notify = lists => {
    for (const res of watchers) res.write(`event: change\ndata: ${JSON.stringify({ lists })}\n\n`);
};

const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
};

const readBody = req => new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf-8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
});

// one writer: ops apply strictly in arrival order
let chain = Promise.resolve();
function enqueue(body, data) {
    const run = chain.then(() => applyOp({ data }, body)).then(
        r => {
            if (r.lists.length) {
                notify(r.lists);
                writeState(p);
            }
            return r;
        },
        err => ({ ok: false, error: err.message }),
    );
    chain = run.then(() => {}, () => {});
    return run;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://doitd");
    try {
        if (req.method === "POST" && url.pathname === "/call") {
            const body = JSON.parse((await readBody(req)) || "{}");
            if (!body.tool) return json(res, 400, { ok: false, error: "tool required" });
            let data;
            if (body.data_dir && body.data_dir !== dataDir()) {
                // one daemon, one replica; DOIT_ANY_DATA_DIR lets a test suite point each case at its own dir
                if (!process.env.DOIT_ANY_DATA_DIR) return json(res, 200, { ok: false, error: `doitd serves ${dataDir()}, not ${body.data_dir}; set DOIT_STATE_DIR to a state dir of its own` });
                data = body.data_dir;
            }
            const { resolved, ...out } = await enqueue(body, data);
            return json(res, 200, out);
        }
        if (req.method === "GET" && url.pathname === "/tools") {
            return json(res, 200, TOOLS.map(t => ({ name: t.name, description: t.description, internal: Boolean(t.internal) })));
        }
        if (req.method === "GET" && url.pathname === "/state") return json(res, 200, readState(p));
        if (req.method === "GET" && url.pathname === "/conflicts") return json(res, 200, readLines(p.conflicts));
        if (req.method === "POST" && url.pathname === "/conflicts/clear") {
            fs.writeFileSync(p.conflicts, "");
            writeState(p);
            return json(res, 200, { ok: true });
        }
        if (req.method === "GET" && url.pathname === "/watch") {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(":ok\n\n");
            watchers.add(res);
            req.on("close", () => watchers.delete(res));
            return;
        }
        json(res, 404, { ok: false, error: `no route ${req.method} ${url.pathname}` });
    } catch (err) {
        json(res, 500, { ok: false, error: err.message });
    }
});

fs.rmSync(p.socket, { force: true });
server.listen(p.socket, () => {
    fs.chmodSync(p.socket, 0o600);
    writeState(p, { data_dir: dataDir() });
    log(`doitd listening on ${p.socket} for ${dataDir()}`);
});

function shutdown(signal) {
    log(`doitd stopping (${signal})`);
    server.close();
    for (const res of watchers) res.end();
    fs.rmSync(p.socket, { force: true });
    release();
    process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
