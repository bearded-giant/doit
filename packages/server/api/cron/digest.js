import { OWED_LIST } from "@doit/core/tools.js";
import { getPool } from "../../lib/db.js";
import { esc, homeOrder, title } from "../../lib/home.js";
import { logError } from "../../lib/http.js";
import { loadPgStore } from "../../lib/pgStore.js";
import { env, slackApi } from "../../lib/slack.js";

const LABEL = { critical: "!!!", urgent: "!!", important: "!" };

// Vercel cron on weekday mornings: the owner's pending daily items, by priority, as a DM
export default async function handler(req, res) {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "cron only" });
    try {
        const pool = await getPool();
        const client = await pool.connect();
        let rows;
        try {
            const store = await loadPgStore(client);
            rows = homeOrder((store.getList(OWED_LIST)?.todos || []).filter(t => !t.done));
        } finally {
            client.release();
        }
        if (!rows.length) return res.status(200).json({ sent: false, pending: 0 });
        const lines = rows.slice(0, 30).map(({ todo: t, depth }) => `${"    ".repeat(depth)}• ${t.in_progress ? "▶ " : ""}${LABEL[t.priorities] ? `*${LABEL[t.priorities]}* ` : ""}${esc(title(t))}${t.due_date ? ` _(due ${t.due_date})_` : ""}`);
        if (rows.length > 30) lines.push(`… ${rows.length - 30} more`);
        const r = await slackApi("chat.postMessage", { channel: env().owner, text: `*${OWED_LIST}*: ${rows.length} pending\n${lines.join("\n")}` });
        res.status(200).json({ sent: Boolean(r.ok), pending: rows.length });
    } catch (err) {
        logError("cron/digest", err);
        res.status(500).json({ error: "internal" });
    }
}
