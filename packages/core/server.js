#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createCtx } from "./ctx.js";
import { fileStore } from "./store.js";
import { INSTRUCTIONS, OWED_LIST, TOOLS, runTool } from "./tools.js";
import { localView } from "./view.js";

export { PRIORITY_LABELS, isMineList, parseDue, renderDue, stripFooter, structureAware } from "./tools.js";

// Root VERSION is the single source of truth, read at runtime exactly as the
// nvim (init.lua read_version) and tmux (DOIT_VERSION) surfaces do, so a release
// bump does not have to be repeated here.
export function readVersion() {
    try {
        const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
        return fs.readFileSync(path.join(root, "VERSION"), "utf-8").trim() || "0.0.0";
    } catch {
        return "0.0.0";
    }
}

export const DATA_DIR = process.env.DOIT_DATA_DIR || path.join(process.env.HOME, ".local/share/nvim/doit");
export const LISTS_DIR = path.join(DATA_DIR, "lists");

export function readJSON(filepath) {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
}

// tmux links and the global pointer track what the user is LOOKING at, which is
// rarely the list a model's work belongs to, so they never steer this server.
const envActiveList = () => process.env.DOIT_ACTIVE_LIST || OWED_LIST;

// Reads for the CLI's own rendering; writes go through the tools.
export function loadList(listName) {
    const name = listName || envActiveList();
    const store = fileStore(DATA_DIR);
    let data = store.getList(name);
    if (!data) {
        if (name !== OWED_LIST) throw new Error(`List "${name}" not found at ${store.pathOf(name)}`);
        const now = Math.floor(Date.now() / 1000);
        data = { todos: [], _metadata: { created_at: now, updated_at: now } };
        store.putList(name, data);
    }
    return { name, data };
}

export function findListByTodoId(id) {
    return fileStore(DATA_DIR).findListByTodoId(id);
}

// rename/delete of the caller's active list are refused by the caller, not the handler: the
// handler has no environment, and the server has no active list
export function guardActiveList(name, args, activeList) {
    const target = name === "rename_list" ? args.old_name : name === "delete_list" ? args.name : null;
    if (target && target !== OWED_LIST && target === activeList) {
        throw new Error(`Cannot ${name === "rename_list" ? "rename" : "delete"} the active list "${target}". Switch to another list first.`);
    }
}

// Runs every tool in this process against the data dir: one fresh ctx per call.
export function localExecutor({
    dataDir = DATA_DIR,
    source = "mcp",
    activeList = envActiveList(),
    activeListNote = process.env.DOIT_ACTIVE_LIST ? " (via DOIT_ACTIVE_LIST env override, not the window link)" : "",
} = {}) {
    const view = localView(dataDir);
    return async (name, args) => {
        guardActiveList(name, args, activeList);
        const ctx = createCtx({ store: fileStore(dataDir), view, source, activeList, activeListNote });
        return runTool(ctx, name, args);
    };
}

// Registers the public tools; `execute(name, args)` is a local runner or a forwarder to doitd.
export function createMcpServer({ execute, version = readVersion() }) {
    const server = new McpServer({ name: "doit", version }, { instructions: INSTRUCTIONS });
    for (const tool of TOOLS) {
        if (tool.internal) continue;
        server.tool(tool.name, tool.description, tool.schema, args => execute(tool.name, args));
    }
    return server;
}

// cli.js imports this module for its tools and must not take over stdio
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await createMcpServer({ execute: localExecutor() }).connect(new StdioServerTransport());
}
