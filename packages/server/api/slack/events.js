import { waitUntil } from "@vercel/functions";
import { getPool } from "../../lib/db.js";
import { settle } from "../../lib/feed.js";
import { publishHome } from "../../lib/home.js";
import { logError } from "../../lib/http.js";
import { applySlackOp, env, json, ok, parseMarkers, slackApi, uuidv5, verifySlack } from "../../lib/slack.js";

// Slack retries an event it did not see acked within 3 s, so the ack goes out first and the op
// runs after it; the op id comes from event_id, so the retry finds it applied already.
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
    if (body.type !== "event_callback") return ok();
    const ev = body.event || {};
    if (ev.bot_id || ev.subtype || ev.user !== env().owner) return ok();
    if (ev.type === "message" && ev.channel_type === "im" && ev.text) waitUntil(captureDm(body.event_id, ev));
    if (ev.type === "app_home_opened") waitUntil(getPool().then(pool => publishHome(pool)).catch(err => logError("slack/home", err)));
    return ok();
}

async function captureDm(eventId, ev) {
    try {
        const m = parseMarkers(ev.text);
        if (!m.text) return;
        const pool = await getPool();
        const list = m.list || "daily";
        const r = await applySlackOp(pool, uuidv5(`event:${eventId}`), "add_todo", { list, text: m.text, priority: m.priority, due: m.due });
        if (r.status === "applied") await slackApi("reactions.add", { channel: ev.channel, timestamp: ev.ts, name: "white_check_mark" });
        else if (r.status === "failed") await slackApi("chat.postMessage", { channel: ev.channel, text: r.error });
        if (r.status === "applied") await settle(pool, [list]);
    } catch (err) {
        logError("slack/events", err, { event_id: eventId });
    }
}
