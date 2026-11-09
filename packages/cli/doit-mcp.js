#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, localExecutor } from "@doit/core/server.js";

await createMcpServer({ execute: localExecutor() }).connect(new StdioServerTransport());
