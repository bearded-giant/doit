import { getPool } from "../lib/db.js";

export default async function handler(_req, res) {
    try {
        const pool = await getPool();
        const r = await pool.query("select (select count(*) from lists where deleted_at is null) as lists, (select case when is_called then last_value else 0 end from change_seq) as cursor");
        res.status(200).json({ ok: true, lists: Number(r.rows[0].lists), cursor: Number(r.rows[0].cursor) });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.constructor.name });
    }
}
