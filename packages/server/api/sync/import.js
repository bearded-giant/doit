import { getPool } from "../../lib/db.js";
import { body, logError, methodIs, requireMachine } from "../../lib/http.js";
import { importDocs } from "../../lib/runner.js";

export default async function handler(req, res) {
    if (!methodIs(req, res, "POST")) return;
    try {
        const machine = await requireMachine(req, res);
        if (!machine) return;
        const { lists, notes } = body(req);
        if ((lists && typeof lists !== "object") || (notes && typeof notes !== "object")) {
            return res.status(400).json({ error: "lists: {name: doc}, notes: {scope: doc}" });
        }
        const out = await importDocs(await getPool(), { lists: lists || {}, notes: notes || {} });
        if (out.error) return res.status(409).json(out);
        res.status(200).json(out);
    } catch (err) {
        logError("sync/import", err);
        res.status(500).json({ error: "internal" });
    }
}
