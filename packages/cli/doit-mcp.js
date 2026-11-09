#!/usr/bin/env node

// stdio MCP for Claude Code: data tools go to doitd over its socket as source "mcp" with this
// process's active list; view tools and the view effects of list ops run here, in the user's tmux.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { localTz } from "@doit/core/ctx.js";
import { DATA_DIR, createMcpServer, guardActiveList, localExecutor } from "@doit/core/server.js";
import { applyViewEffect, localView } from "@doit/core/view.js";
import { doitCall } from "./client.js";

const activeList = process.env.DOIT_ACTIVE_LIST || "daily";
const activeListNote = process.env.DOIT_ACTIVE_LIST ? " (via DOIT_ACTIVE_LIST env override, not the window link)" : "";
const VIEW_TOOLS = new Set(["switch_list", "set_source_filter"]);
const local = localExecutor({ activeList, activeListNote });
const view = localView(DATA_DIR);

async function execute(name, args) {
    if (VIEW_TOOLS.has(name)) return local(name, args);
    guardActiveList(name, args, activeList);
    const res = await doitCall({ tool: name, args, source: "mcp", active_list: activeList, active_list_note: activeListNote, tz: localTz() });
    if (!res.ok) throw new Error(res.error);
    applyViewEffect(view, name, args);
    return { content: [{ type: "text", text: res.text }] };
}

await createMcpServer({ execute }).connect(new StdioServerTransport());
