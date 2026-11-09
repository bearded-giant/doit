import { getPool } from "./db.js";
import { authenticate } from "./auth.js";

// the catch-all logs tool, op ids and the error class only: tool text carries item text
export function logError(where, err, extra = {}) {
    console.error(JSON.stringify({ where, error: err?.constructor?.name || "Error", message: String(err?.message || err).slice(0, 200), ...extra }));
}

export function methodIs(req, res, method) {
    if (req.method === method) return true;
    res.status(405).json({ error: `use ${method}` });
    return false;
}

// bearer token -> machine name, or a 401 already sent
export async function requireMachine(req, res) {
    const pool = await getPool();
    const client = await pool.connect();
    try {
        const machine = await authenticate(client, req.headers.authorization);
        if (!machine) res.status(401).json({ error: "bad or revoked token" });
        return machine;
    } finally {
        client.release();
    }
}

export function body(req) {
    if (req.body && typeof req.body === "object") return req.body;
    if (typeof req.body === "string" && req.body) return JSON.parse(req.body);
    return {};
}
