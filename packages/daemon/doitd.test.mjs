// doitd: /call applies before it answers, reads queue nothing, the outbox exists only with a server,
// the lock keeps one writer, the CLI falls back only when the lock is free, the bridge forwards as mcp
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { socketRequest } from "../cli/client.js";
import { paths, procStart } from "./local.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(here, "doitd.js");
const CLI = path.join(here, "..", "cli", "cli.js");
const BRIDGE = path.join(here, "..", "cli", "doit-mcp.js");

const data = fs.mkdtempSync(path.join(os.tmpdir(), "doit-d-"));
const state = fs.mkdtempSync(path.join(os.tmpdir(), "doit-s-"));
fs.mkdirSync(path.join(data, "lists"));
const listFile = name => path.join(data, "lists", `${name}.json`);
const readList = name => JSON.parse(fs.readFileSync(listFile(name), "utf-8"));
fs.writeFileSync(listFile("daily"), JSON.stringify({ todos: [{ id: "a", text: "thing", done: false, in_progress: false, order_index: 1 }], _metadata: {} }));
const p = paths(state);
const env = { ...process.env, DOIT_DATA_DIR: data, DOIT_STATE_DIR: state, DOIT_SERVER_URL: "", DOIT_ACTIVE_LIST: "", TMUX: "", TMUX_PANE: "", DOIT_LOCK_WAIT_MS: "50", DOIT_HOST: "testbox" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startDaemon(extra = {}) {
    const child = spawn("node", [DAEMON], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    child.err = "";
    child.stderr.on("data", c => { child.err += c; });
    child.exited = new Promise(r => child.on("exit", code => r(code)));
    return child;
}
async function waitUp(ms = 5000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        try {
            return (await socketRequest(p.socket, "GET", "/state")).json;
        } catch {
            await sleep(50);
        }
    }
    throw new Error("doitd did not come up");
}
const call = body => socketRequest(p.socket, "POST", "/call", body).then(r => r.json);
const cli = (args, extra = {}) => spawnSync("node", [CLI, ...args], { env: { ...env, ...extra }, encoding: "utf-8" });

// local-only daemon: apply before return, reads are not ops, no outbox without a server
let daemon = startDaemon();
let st = await waitUp();
assert.equal(st.mode, "local");
assert.equal(st.data_dir, data);
assert.equal(st.server, null);
assert.ok((fs.statSync(p.socket).mode & 0o777) === 0o600, "socket is 0600");
assert.ok((fs.statSync(state).mode & 0o777) === 0o700, "state dir is 0700");

let r = await call({ tool: "start_todo", args: { id: "a" }, source: "user", active_list: "daily" });
assert.equal(r.ok, true);
assert.match(r.text, /^Started in "daily": thing/);
assert.deepEqual(r.lists, ["daily"]);
assert.match(r.op_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "op ids are UUIDv7");
assert.equal(readList("daily").todos[0].in_progress, true, "the replica holds the change when /call returns");
assert.equal(r.resolved, undefined, "the wire result carries no internals");

r = await call({ tool: "list_todos", args: {}, active_list: "daily" });
assert.equal(r.ok, true);
assert.deepEqual(r.lists, []);
assert.ok(!fs.existsSync(p.outbox), "local-only mode writes no outbox");

r = await call({ tool: "nope", args: {} });
assert.equal(r.ok, false);
assert.match(r.error, /Unknown tool/);
r = await call({ tool: "complete_todo", args: { id: "zzz", list: "daily" } });
assert.equal(r.ok, false);
assert.match(r.error, /not found/);

const tools = (await socketRequest(p.socket, "GET", "/tools")).json;
assert.ok(tools.some(t => t.name === "add_todo" && !t.internal) && tools.some(t => t.name === "restore_todo" && t.internal));

// a second daemon on the same state dir refuses to start
const second = startDaemon();
assert.equal(await second.exited, 1);
assert.match(second.err, /holds .*doitd\.lock/);
assert.ok(fs.existsSync(p.socket), "the running daemon kept its socket");

// /watch streams a change event after a write
{
    const chunks = [];
    const req = (await import("node:http")).request({ socketPath: p.socket, path: "/watch", method: "GET" }, res => res.on("data", c => chunks.push(String(c))));
    req.end();
    await sleep(100);
    await call({ tool: "add_todo", args: { text: "watched", type: "chore" }, source: "mcp", active_list: "daily" });
    await sleep(100);
    req.destroy();
    assert.match(chunks.join(""), /event: change\ndata: {"lists":\["daily"\]}/);
}
assert.match((await socketRequest(p.socket, "POST", "/sync/push", {})).json.error, /no server/, "sync verbs need a server");

daemon.kill("SIGTERM");
await daemon.exited;
assert.ok(!fs.existsSync(p.socket) && !fs.existsSync(p.lock), "a clean stop removes socket and lock");

// with a server configured the outbox records each changing op, fully pinned
daemon = startDaemon({ DOIT_SERVER_URL: "http://127.0.0.1:1" });
st = await waitUp();
assert.equal(st.mode, "sync");
assert.equal(st.server, "http://127.0.0.1:1");
// the settings line is the daemon's, whatever the CLI's own env says
assert.ok(cli(["daemon", "status"]).stdout.includes(`server: http://127.0.0.1:1 (pull every 10 s); data: ${data}; state: ${state}`));
r = await call({ tool: "complete_todo", args: { query: "thing" }, source: "user", active_list: "daily", tz: "America/New_York" });
assert.equal(r.ok, true);
let ops = fs.readFileSync(p.outbox, "utf-8").trim().split("\n").map(l => JSON.parse(l));
assert.equal(ops.length, 1);
assert.deepEqual(ops[0].args, { list: "daily", id: "a" }, "query and omitted list are pinned");
assert.equal(ops[0].source, "user");
assert.equal(ops[0].host, "testbox");
assert.equal(ops[0].tz, "America/New_York");
assert.deepEqual(ops[0].lists, ["daily"]);
await call({ tool: "list_todos", args: {}, active_list: "daily" });
await call({ tool: "dedupe_todos", args: {}, active_list: "daily" });
assert.equal(fs.readFileSync(p.outbox, "utf-8").trim().split("\n").length, 1, "reads and dry runs queue nothing");
assert.equal((await socketRequest(p.socket, "GET", "/state")).json.queue, 1);
assert.match((await socketRequest(p.socket, "POST", "/sync/import", {})).json.error, /syncing already/, "a syncing daemon refuses import");
daemon.kill("SIGTERM");
await daemon.exited;

// CLI fallback: daemon down, lock free -> in-process under the lock, same outbox
let out = cli(["call", "revert_todo", JSON.stringify({ list: "daily", id: "a" })], { DOIT_SERVER_URL: "http://127.0.0.1:1" });
assert.equal(out.status, 0, out.stderr);
assert.match(out.stdout, /Reverted to pending in "daily": thing/);
assert.equal(readList("daily").todos[0].done, false);
assert.equal(fs.readFileSync(p.outbox, "utf-8").trim().split("\n").length, 2, "the fallback appended its op");
assert.ok(!fs.existsSync(p.lock), "the fallback released the lock");
out = cli(["call", "start_todo", JSON.stringify({ list: "daily", id: "a" })]);
assert.equal(out.status, 0, out.stderr);
assert.equal(fs.readFileSync(p.outbox, "utf-8").trim().split("\n").length, 2, "no server url, no outbox append");

// held lock + dead socket: refuse, write nothing
fs.writeFileSync(p.lock, JSON.stringify({ pid: process.pid, start: procStart(process.pid) }));
const before = fs.readFileSync(listFile("daily"), "utf-8");
out = cli(["call", "complete_todo", JSON.stringify({ list: "daily", id: "a" })]);
assert.equal(out.status, 1);
assert.match(out.stderr, /doitd \(pid \d+\) holds .*doitd\.lock but .*doitd\.sock did not answer/);
assert.equal(fs.readFileSync(listFile("daily"), "utf-8"), before, "the replica is unchanged");
fs.rmSync(p.lock);

// a client pointed at another data dir never writes through this daemon
daemon = startDaemon();
await waitUp();
out = cli(["call", "list_todos", "{}"], { DOIT_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "doit-other-")) });
assert.equal(out.status, 1);
assert.match(out.stderr, /doitd serves .*, not /);

// the stdio bridge forwards data tools as source mcp with its active list; view tools stay local
{
    const bridge = spawn("node", [BRIDGE], { env: { ...env, DOIT_ACTIVE_LIST: "daily" }, stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";
    const pending = new Map();
    bridge.stdout.on("data", c => {
        buf += c;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const msg = JSON.parse(line);
            if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
        }
    });
    let seq = 0;
    const rpc = (method, params) => new Promise(resolve => {
        const id = ++seq;
        pending.set(id, resolve);
        bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    const callTool = async (name, args) => {
        const res = await rpc("tools/call", { name, arguments: args });
        return { text: res.result.content.map(c => c.text).join("\n"), isError: Boolean(res.result.isError) };
    };
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const added = await callTool("add_todo", { text: "from claude", type: "chore" });
    assert.match(added.text, /^Added to "daily": \[chore\] \d+\. from claude \[id:\d+_\d+\]$/);
    const item = readList("daily").todos.find(t => t.text.includes("from claude"));
    assert.equal(item.source, "mcp");
    assert.match((await callTool("list_lists", {})).text, /^daily \[mine\].*<-- active \(via DOIT_ACTIVE_LIST/m);
    const sw = await callTool("switch_list", { list: "daily", scope: "global" });
    assert.match(sw.text, /set the global pointer/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, "session.json"), "utf-8")).active_list, "daily", "view tools run in the bridge, not doitd");
    const refused = await callTool("delete_list", { name: "daily" });
    assert.ok(refused.isError);
    assert.match(refused.text, /permanent/);
    await callTool("create_list", { name: "scratch" });
    const guard = await callTool("rename_list", { old_name: "daily", new_name: "x" });
    assert.ok(guard.isError);
    bridge.kill();
}

daemon.kill("SIGTERM");
await daemon.exited;
fs.rmSync(data, { recursive: true, force: true });
fs.rmSync(state, { recursive: true, force: true });
console.log("doitd: ok");
