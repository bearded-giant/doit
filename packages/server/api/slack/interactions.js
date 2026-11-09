import { waitUntil } from "@vercel/functions";
import { getPool } from "../../lib/db.js";
import { logError } from "../../lib/http.js";
import { PRIVATE, applySlackOp, env, json, ok, uuidv5, verifySlack } from "../../lib/slack.js";

// buttons the command replies offer: each carries the op it stands for; action_ts keys the op id
export async function POST(request) {
    const raw = await request.text();
    if (!verifySlack(request.headers, raw, env().secret)) return new Response("bad signature", { status: 401 });
    let payload;
    try {
        payload = JSON.parse(new URLSearchParams(raw).get("payload") || "{}");
    } catch {
        return new Response("bad payload", { status: 400 });
    }
    if (payload.user?.id !== env().owner) return json({ response_type: "ephemeral", replace_original: true, text: PRIVATE });
    if (payload.type !== "block_actions") return ok();
    const ops = (payload.actions || []).filter(a => a.action_id?.startsWith("doit:") && a.value);
    if (ops.length) waitUntil(applyButtons(ops, payload.response_url));
    return ok();
}

async function applyButtons(actions, responseUrl) {
    try {
        const pool = await getPool();
        const lines = [];
        for (const a of actions) {
            const { tool, args } = JSON.parse(a.value);
            const r = await applySlackOp(pool, uuidv5(`action:${a.action_ts}`), tool, args);
            lines.push(r.status === "failed" ? r.error : r.text || "Done.");
        }
        if (responseUrl) {
            await fetch(responseUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ response_type: "ephemeral", replace_original: true, text: lines.join("\n") }),
            });
        }
    } catch (err) {
        logError("slack/interactions", err);
    }
}
