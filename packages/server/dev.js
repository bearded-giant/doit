#!/usr/bin/env node

// Runs the api/ handlers on plain node:http with Vercel's req.body / req.query / res.status().json()
// shape, for local runs and the sync tests. DATABASE_URL names the Postgres to use.

import http from "http";
import ops from "./api/ops.js";
import changes from "./api/sync/changes.js";
import importDocs from "./api/sync/import.js";
import health from "./api/health.js";
import prune from "./api/cron/prune.js";

const ROUTES = {
    "/api/ops": ops,
    "/api/sync/changes": changes,
    "/api/sync/import": importDocs,
    "/api/health": health,
    "/api/cron/prune": prune,
};

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
