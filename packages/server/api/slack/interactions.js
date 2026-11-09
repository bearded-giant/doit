import { waitUntil } from "@vercel/functions";
import { stripFooter } from "@doit/core/tools.js";
import { getPool } from "../../lib/db.js";
import { settle } from "../../lib/feed.js";
import { deleteModal, itemModal, listOptions, modalValue, pickModal, priorityOptions, publishHome, title } from "../../lib/home.js";
import { logError } from "../../lib/http.js";
import { loadPgStore } from "../../lib/pgStore.js";
import { setSetting } from "../../lib/settings.js";
import { PRIVATE, applySlackOp, env, json, ok, slackApi, uuidv5, verifySlack } from "../../lib/slack.js";

// Buttons and menus carry the op they stand for; action_ts keys the op id so a double click
// applies once. Modals answer on the response (clear or errors), so their op runs inline.
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
    try {
        if (payload.type === "view_submission") return submission(payload);
        if (payload.type === "message_action" && payload.callback_id === "save_to_doit") {
            waitUntil(saveToDoit(payload));
            return ok();
        }
        if (payload.type === "block_actions") {
            waitUntil(blockActions(payload));
            return ok();
        }
    } catch (err) {
        logError("slack/interactions", err);
    }
    return ok();
}

async function withStore(fn) {
    const pool = await getPool();
    const client = await pool.connect();
    try {
        return await fn(await loadPgStore(client), client, pool);
    } finally {
        client.release();
    }
}

const findTodo = (store, list, id) => (store.getList(list)?.todos || []).find(t => t.id === id);

async function blockActions(payload) {
    const pool = await getPool();
    const lines = [];
    const changed = new Set();
    for (const a of payload.actions || []) {
        const opId = uuidv5(`action:${a.action_ts}`);
        const value = a.selected_option?.value ?? a.value;
        try {
            if (a.action_id.startsWith("doit:")) {
                const { tool, args } = JSON.parse(value);
                const r = await applySlackOp(pool, opId, tool, args);
                lines.push(r.status === "failed" ? r.error : r.text || "Done.");
                if (args.list) changed.add(args.list);
            } else if (a.action_id === "home:list") {
                await withStore(async (_, client) => setSetting(client, "home_list", value));
                await publishHome(pool, { list: value });
            } else if (a.action_id === "home:more") {
                const { list, offset } = JSON.parse(value);
                await publishHome(pool, { list, offset });
            } else if (a.action_id === "home:add") {
                await withStore(store => slackApi("views.open", { trigger_id: payload.trigger_id, view: itemModal(store, { mode: "add", list: value || "daily" }) }));
            } else if (a.action_id === "home:item") {
                await homeItem(pool, payload, opId, JSON.parse(value), changed);
            } else if (a.action_id.startsWith("feed:")) {
                const { list, id } = JSON.parse(value);
                if (a.action_id === "feed:notes") {
                    const todo = await withStore(store => findTodo(store, list, id));
                    const notes = todo ? stripFooter(todo.description || "").trim() || "No notes." : "That item is gone.";
                    await slackApi("chat.postEphemeral", { channel: payload.channel?.id || payload.container?.channel_id, user: payload.user.id, text: `*${title(todo || { text: id })}*\n${notes}` });
                } else {
                    const todo = await withStore(store => findTodo(store, list, id));
                    const tool = a.action_id === "feed:done" ? "complete_todo" : todo?.in_progress ? "update_todo" : "start_todo";
                    const args = tool === "update_todo" ? { list, id, in_progress: false } : { list, id };
                    await applySlackOp(pool, opId, tool, args);
                    changed.add(list);
                }
            }
        } catch (err) {
            logError("slack/interactions", err, { action: a.action_id });
        }
    }
    if (lines.length && payload.response_url) {
        await fetch(payload.response_url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ response_type: "ephemeral", replace_original: true, text: lines.join("\n") }),
        });
    }
    await settle(pool, [...changed]);
}

async function homeItem(pool, payload, opId, { a, list, id }, changed) {
    if (a === "done" || a === "start" || a === "stop") {
        const tool = { done: "complete_todo", start: "start_todo", stop: "update_todo" }[a];
        await applySlackOp(pool, opId, tool, a === "stop" ? { list, id, in_progress: false } : { list, id });
        changed.add(list);
        return;
    }
    await withStore(async store => {
        const todo = findTodo(store, list, id);
        if (!todo) return publishHome(pool, { list });
        const view = a === "edit" ? itemModal(store, { mode: "edit", list, id, todo })
            : a === "delete" ? deleteModal({ list, id, todo })
                : a === "move" ? pickModal("move", { list, id, options: listOptions(store).filter(o => o.value !== list) })
                    : pickModal("priority", { list, id, options: priorityOptions(), initial: todo.priorities || "none" });
        return slackApi("views.open", { trigger_id: payload.trigger_id, view });
    });
}

async function saveToDoit(payload) {
    const msg = payload.message || {};
    const link = await slackApi("chat.getPermalink", { channel: payload.channel?.id, message_ts: msg.ts });
    const text = (msg.text || "").trim();
    const notes = [text, link.permalink].filter(Boolean).join("\n\n");
    await withStore(store => slackApi("views.open", {
        trigger_id: payload.trigger_id,
        view: itemModal(store, { mode: "add", list: "daily", todo: { text: text.split("\n")[0].slice(0, 120) }, notes }),
    }));
}

async function submission(payload) {
    const view = payload.view || {};
    const meta = JSON.parse(view.private_metadata || "{}");
    const pool = await getPool();
    const opId = uuidv5(`view:${view.id}:${view.hash || ""}`);
    let r;
    const changed = [meta.list];
    if (view.callback_id === "item_modal") {
        const list = modalValue(view, "list") || meta.list || "daily";
        const priority = modalValue(view, "priority");
        const fields = {
            text: (modalValue(view, "title") || "").trim(),
            priority: priority === "none" ? (meta.mode === "edit" ? "none" : undefined) : priority,
            due: modalValue(view, "due") || (meta.mode === "edit" ? "" : undefined),
            description: modalValue(view, "notes") || undefined,
        };
        if (!fields.text) return json({ response_action: "errors", errors: { title: "Give it a title." } });
        if (meta.mode === "edit") {
            r = await applySlackOp(pool, opId, "update_todo", { list: meta.list, id: meta.id, ...fields, description: fields.description ?? "" });
            if (r.status !== "failed" && list !== meta.list) {
                r = await applySlackOp(pool, uuidv5(`view-move:${view.id}:${view.hash || ""}`), "move_todo", { from_list: meta.list, id: meta.id, to_list: list });
                changed.push(list);
            }
        } else {
            r = await applySlackOp(pool, opId, "add_todo", { list, ...fields });
            changed.push(list);
        }
    } else if (view.callback_id === "priority_modal") {
        r = await applySlackOp(pool, opId, "update_todo", { list: meta.list, id: meta.id, priority: modalValue(view, "priority") || "none" });
    } else if (view.callback_id === "move_modal") {
        const to = modalValue(view, "move");
        r = await applySlackOp(pool, opId, "move_todo", { from_list: meta.list, id: meta.id, to_list: to });
        changed.push(to);
    } else if (view.callback_id === "delete_modal") {
        r = await applySlackOp(pool, opId, "delete_todo", { list: meta.list, id: meta.id });
    } else {
        return ok();
    }
    if (r.status === "failed") {
        // a delete modal has no input block to pin the error on
        if (view.callback_id === "delete_modal") return json({ response_action: "update", view: { ...deleteModal({ list: meta.list, id: meta.id, todo: { text: r.error } }), submit: undefined } });
        return json({ response_action: "errors", errors: { [view.callback_id === "item_modal" ? "title" : view.callback_id.replace("_modal", "")]: r.error.slice(0, 250) } });
    }
    waitUntil(settle(pool, changed.filter(Boolean)));
    return json({ response_action: "clear" });
}
