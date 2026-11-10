import { waitUntil } from "@vercel/functions";
import { getPool } from "../../lib/db.js";
import { settle } from "../../lib/feed.js";
import { logError } from "../../lib/http.js";
import { PRIVATE, env, json, runCommand, uuidv5, verifySlack } from "../../lib/slack.js";

// the slash command's answer rides on the HTTP response; one op is well inside Slack's 3 s
export async function POST(request) {
    const raw = await request.text();
    if (!verifySlack(request.headers, raw, env().secret)) return new Response("bad signature", { status: 401 });
    const form = Object.fromEntries(new URLSearchParams(raw));
    if (form.user_id !== env().owner) return json({ response_type: "ephemeral", text: PRIVATE });
    try {
        const pool = await getPool();
        const { lists = [], ...out } = await runCommand(pool, form.text || "", { opId: uuidv5(`command:${form.trigger_id}`), tz: env().tz });
        waitUntil(settle(pool, lists));
        return json({ response_type: "ephemeral", ...out });
    } catch (err) {
        logError("slack/commands", err);
        return json({ response_type: "ephemeral", text: "doit hit an error; try again." });
    }
}
