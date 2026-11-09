import { waitUntil } from "@vercel/functions";
import { getPool } from "../lib/db.js";
import { settle } from "../lib/feed.js";
import { body, logError, methodIs, requireMachine } from "../lib/http.js";
import { applyOps } from "../lib/runner.js";

const MAX_BATCH = 50;

export default async function handler(req, res) {
    if (!methodIs(req, res, "POST")) return;
    try {
        const machine = await requireMachine(req, res);
        if (!machine) return;
        const ops = body(req).ops;
        if (!Array.isArray(ops) || ops.some(o => !o || typeof o.op_id !== "string" || typeof o.tool !== "string")) {
            return res.status(400).json({ error: "ops: [{op_id, ts, tz, source, tool, args}]" });
        }
        if (ops.length > MAX_BATCH) return res.status(413).json({ error: `at most ${MAX_BATCH} ops per batch` });
        const pool = await getPool();
        const results = await applyOps(pool, ops, { host: machine });
        if (results.some(r => r.status === "applied" && r.change_seq)) waitUntil(settle(pool));
        res.status(200).json({ results });
    } catch (err) {
        logError("ops", err);
        res.status(500).json({ error: "internal" });
    }
}
