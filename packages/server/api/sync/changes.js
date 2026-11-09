import { getPool } from "../../lib/db.js";
import { logError, methodIs, requireMachine } from "../../lib/http.js";
import { changesSince } from "../../lib/runner.js";

export default async function handler(req, res) {
    if (!methodIs(req, res, "GET")) return;
    try {
        const machine = await requireMachine(req, res);
        if (!machine) return;
        const cursor = Number(req.query?.cursor || 0);
        if (!Number.isInteger(cursor) || cursor < 0) return res.status(400).json({ error: "cursor must be a non-negative integer" });
        const pool = await getPool();
        const client = await pool.connect();
        try {
            res.status(200).json(await changesSince(client, cursor));
        } finally {
            client.release();
        }
    } catch (err) {
        logError("sync/changes", err);
        res.status(500).json({ error: "internal" });
    }
}
