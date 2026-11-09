#!/usr/bin/env node

// Runs the api/ handlers on plain node:http with Vercel's req.body / req.query / res.status().json()
// shape, for local runs and the sync tests. DATABASE_URL names the Postgres to use.

import http from "http";
import ops from "./api/ops.js";
import changes from "./api/sync/changes.js";
import importDocs from "./api/sync/import.js";
import health from "./api/health.js";
import prune from "./api/cron/prune.js";
import digest from "./api/cron/digest.js";
import * as slackCommands from "./api/slack/commands.js";
import * as slackEvents from "./api/slack/events.js";
import * as slackInteractions from "./api/slack/interactions.js";

// a function is a (req, res) handler; a module is a web handler with method exports
const ROUTES = {
    "/api/ops": ops,
    "/api/sync/changes": changes,
    "/api/sync/import": importDocs,
    "/api/health": health,
    "/api/cron/prune": prune,
    "/api/cron/digest": digest,
    "/api/slack/commands": slackCommands,
    "/api/slack/events": slackEvents,
    "/api/slack/interactions": slackInteractions,
};

async function webHandler(mod, req, res, raw) {
    const fn = mod[req.method];
    if (!fn) return res.status(405).json({ error: `use ${Object.keys(mod).join(", ")}` });
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (/^(content-type|authorization|x-slack-)/.test(k)) headers.set(k, String(v));
    const request = new Request(`http://localhost${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : raw });
    const response = await fn(request);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await response.arrayBuffer()));
}

export function createServer(routes = ROUTES) {
    return http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        const handler = routes[url.pathname];
        res.status = code => {
            res.statusCode = code;
            return res;
        };
        res.json = obj => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(obj));
        };
        if (!handler) return res.status(404).json({ error: "not found" });
        req.query = Object.fromEntries(url.searchParams);
        let raw = "";
        for await (const chunk of req) raw += chunk;
        if (typeof handler !== "function") return webHandler(handler, req, res, raw);
        try {
            req.body = raw ? JSON.parse(raw) : {};
        } catch {
            return res.status(400).json({ error: "body is not JSON" });
        }
        await handler(req, res);
    });
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
    const port = Number(process.env.PORT) || 3141;
    createServer().listen(port, () => console.log(`doit server on http://localhost:${port}`));
}
