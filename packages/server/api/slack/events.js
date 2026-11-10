import { waitUntil } from "@vercel/functions";
import { getPool } from "../../lib/db.js";
import { settle } from "../../lib/feed.js";
import { publishHome } from "../../lib/home.js";
import { logError } from "../../lib/http.js";
import { env, json, ok, runCommand, slackApi, uuidv5, verifySlack } from "../../lib/slack.js";

// Slack retries an event it did not see acked within 3 s, so the ack goes out first and the work
// runs after it; the first delivery still finishes, so a retry is acked and dropped (no second reply).
export async function POST(request) {
    const raw = await request.text();
    let body;
    try {
        body = JSON.parse(raw);
    } catch {
        return new Response("bad json", { status: 400 });
    }
    if (!verifySlack(request.headers, raw, env().secret)) return new Response("bad signature", { status: 401 });
    if (body.type === "url_verification") return json({ challenge: body.challenge });
    if (body.type !== "event_callback" || request.headers.get("x-slack-retry-num")) return ok();
    const ev = body.event || {};
    if (ev.bot_id || ev.subtype || ev.user !== env().owner) return ok();
    if (ev.type === "message" && ev.channel_type === "im" && ev.text) waitUntil(runDm(body.event_id, ev));
    if (ev.type === "app_home_opened") waitUntil(getPool().then(pool => publishHome(pool)).catch(err => logError("slack/home", err)));
    return ok();
}

async function runDm(eventId, ev) {
    try {
        const pool = await getPool();
        const { lists = [], ...out } = await runCommand(pool, ev.text, { opId: uuidv5(`event:${eventId}`), tz: env().tz, prefix: "" });
        await slackApi("chat.postMessage", { channel: ev.channel, ...out });
        await settle(pool, lists);
    } catch (err) {
        logError("slack/events", err, { event_id: eventId });
    }
}
