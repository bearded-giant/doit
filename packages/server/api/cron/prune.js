import { getPool } from "../../lib/db.js";
import { logError } from "../../lib/http.js";

// Vercel cron: events and applied_ops older than 90 days go; a replica never queues an op that long
export default async function handler(req, res) {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "cron only" });
    try {
        const pool = await getPool();
        const events = await pool.query("delete from events where at < now() - interval '90 days'");
        const ops = await pool.query("delete from applied_ops where applied_at < now() - interval '90 days'");
        res.status(200).json({ events: events.rowCount, applied_ops: ops.rowCount });
    } catch (err) {
        logError("cron/prune", err);
        res.status(500).json({ error: "internal" });
    }
}
