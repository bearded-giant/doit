import { isSequenced } from "@doit/core/sequence.js";
import { PRIORITY_LABELS, isMineList, stripFooter } from "@doit/core/tools.js";
import { loadPgStore } from "./pgStore.js";
import { getSetting } from "./settings.js";
import { env, slackApi } from "./slack.js";

const PRIORITY_RANK = { critical: 4, urgent: 3, important: 2 };
const priorityRank = t => (typeof t.priorities === "string" && PRIORITY_RANK[t.priorities]) || 1;

// mirrors lua/doit/modules/todos/state/sorting.lua origin()
export function origin(t) {
    if (typeof t.source === "string" && t.source) return t.source === "mcp" ? "claude" : "mine";
    if (t.twin && typeof t.twin === "object") return "claude";
    const s = (t.text || "").trimStart();
    return /^claude:|^\[[^\[\]]+\]|^\d+[a-z]*\.\s/.test(s) ? "claude" : "mine";
}

// the nvim comparator: done last, mine before claude, in progress first, sequence, priority, order, due, age
function lessThan(a, b) {
    if (Boolean(a.done) !== Boolean(b.done)) return a.done ? 1 : -1;
    if (!a.done) {
        const am = origin(a) === "mine";
        const bm = origin(b) === "mine";
        if (am !== bm) return am ? -1 : 1;
    }
    if (Boolean(a.in_progress) !== Boolean(b.in_progress)) return a.in_progress ? -1 : 1;
    const as = isSequenced(a);
    const bs = isSequenced(b);
    if (as !== bs) return as ? -1 : 1;
    if (as && a.sequence !== b.sequence) return a.sequence - b.sequence;
    if (priorityRank(a) !== priorityRank(b)) return priorityRank(b) - priorityRank(a);
    if (a.order_index && b.order_index && a.order_index !== b.order_index) return a.order_index - b.order_index;
    if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
    if (a.due_date && !b.due_date) return -1;
    if (!a.due_date && b.due_date) return 1;
    return (a.created_at || 0) - (b.created_at || 0);
}

// nvim order with each subtree kept together under its parent
export function homeOrder(todos) {
    const byId = new Map(todos.map(t => [t.id, t]));
    const children = new Map();
    const roots = [];
    for (const t of todos) {
        const parent = t.parent_id ? byId.get(t.parent_id) : null;
        if (parent && parent !== t) {
            if (!children.has(t.parent_id)) children.set(t.parent_id, []);
            children.get(t.parent_id).push(t);
        } else roots.push(t);
    }
    roots.sort(lessThan);
    for (const g of children.values()) g.sort(lessThan);
    const out = [];
    const seen = new Set();
    const emit = (t, depth) => {
        if (seen.has(t.id)) return;
        seen.add(t.id);
        out.push({ todo: t, depth });
        for (const c of children.get(t.id) || []) emit(c, depth + 1);
    };
    for (const r of roots) emit(r, 0);
    for (const t of todos) if (!seen.has(t.id)) out.push({ todo: t, depth: 0 });
    return out;
}

export const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const title = t => (t.text || "").split("\n")[0].replace(/\s*\[id:[^\]]+\]\s*$/, "");
const label = t => (t.priorities && PRIORITY_LABELS[t.priorities] ? `*${PRIORITY_LABELS[t.priorities]}* ` : "");

const PAGE = 45;
const option = (text, value) => ({ text: { type: "plain_text", text: String(text).slice(0, 75) }, value });
const plain = text => ({ type: "plain_text", text: String(text).slice(0, 150) });

export function listOptions(store) {
    const names = store.listNames();
    const mine = names.filter(n => isMineList(n, store.getList(n)));
    return [...mine, ...names.filter(n => !mine.includes(n))].map(n => option(n, n));
}

export function homeBlocks(store, listName, offset = 0) {
    const doc = store.getList(listName);
    const todos = doc ? doc.todos : [];
    const rows = homeOrder(todos.filter(t => !t.done));
    const done = todos.length - rows.length;
    const page = rows.slice(offset, offset + PAGE);
    const lists = listOptions(store);
    const blocks = [
        {
            type: "actions",
            block_id: "home:header",
            elements: [
                { type: "static_select", action_id: "home:list", placeholder: plain("List"), options: lists, ...(lists.some(o => o.value === listName) ? { initial_option: option(listName, listName) } : {}) },
                { type: "button", action_id: "home:add", text: plain("Add item"), value: listName, style: "primary" },
            ],
        },
        { type: "context", elements: [{ type: "mrkdwn", text: `${rows.length} pending, ${done} done · ${listName}` }] },
    ];
    if (!doc) blocks.push({ type: "section", text: { type: "mrkdwn", text: `List *${esc(listName)}* does not exist.` } });
    for (const { todo: t, depth } of page) {
        const item = JSON.stringify({ list: listName, id: t.id });
        blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: `${"        ".repeat(depth)}${t.in_progress ? "▶ " : ""}${label(t)}${esc(title(t))}` },
            accessory: {
                type: "overflow",
                action_id: "home:item",
                options: [
                    option("Done", JSON.stringify({ a: "done", ...JSON.parse(item) })),
                    option(t.in_progress ? "Stop" : "Start", JSON.stringify({ a: t.in_progress ? "stop" : "start", ...JSON.parse(item) })),
                    option("Priority…", JSON.stringify({ a: "priority", ...JSON.parse(item) })),
                    option("Move…", JSON.stringify({ a: "move", ...JSON.parse(item) })),
                    option("Edit…", JSON.stringify({ a: "edit", ...JSON.parse(item) })),
                    option("Delete…", JSON.stringify({ a: "delete", ...JSON.parse(item) })),
                ],
            },
        });
        const ctx = [];
        if (t.due_date) ctx.push(`due ${t.due_date}`);
        if (t.twin) ctx.push(`owed · ${esc(t.twin.list)}`);
        if (stripFooter(t.description || "").trim()) ctx.push("has notes");
        if (ctx.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: ctx.join(" · ") }] });
    }
    if (offset + PAGE < rows.length) {
        blocks.push({ type: "actions", elements: [{ type: "button", action_id: "home:more", text: plain(`Show more (${rows.length - offset - PAGE})`), value: JSON.stringify({ list: listName, offset: offset + PAGE }) }] });
    }
    return blocks.slice(0, 100);
}

export async function publishHome(pool, { offset = 0, list } = {}) {
    const client = await pool.connect();
    try {
        const store = await loadPgStore(client);
        const listName = list || (await getSetting(client, "home_list", "daily"));
        return slackApi("views.publish", { user_id: env().owner, view: { type: "home", blocks: homeBlocks(store, listName, offset) } });
    } finally {
        client.release();
    }
}

const PRIORITIES = ["none", "important", "urgent", "critical"];

// add, edit, and save-to-doit share one modal; private_metadata says what the submission does
export function itemModal(store, { mode = "add", list = "daily", id, todo = {}, notes } = {}) {
    const input = (block, element, labelText, optional = false) => ({ type: "input", block_id: block, optional, label: plain(labelText), element: { action_id: "v", ...element } });
    const priority = PRIORITIES.includes(todo.priorities) ? todo.priorities : "none";
    const description = notes ?? stripFooter(todo.description || "").trim();
    return {
        type: "modal",
        callback_id: "item_modal",
        private_metadata: JSON.stringify({ mode, list, id }),
        title: plain(mode === "edit" ? "Edit item" : "New item"),
        submit: plain(mode === "edit" ? "Save" : "Add"),
        close: plain("Cancel"),
        blocks: [
            input("title", { type: "plain_text_input", initial_value: title(todo) || undefined, max_length: 200 }, "Title"),
            input("list", { type: "static_select", options: listOptions(store), initial_option: option(list, list) }, "List"),
            input("priority", { type: "static_select", options: PRIORITIES.map(p => option(p, p)), initial_option: option(priority, priority) }, "Priority"),
            input("due", { type: "datepicker", ...(todo.due_date ? { initial_date: todo.due_date } : {}) }, "Due", true),
            input("notes", { type: "plain_text_input", multiline: true, ...(description ? { initial_value: description.slice(0, 3000) } : {}) }, "Notes", true),
        ],
    };
}

export function pickModal(kind, { list, id, options, initial }) {
    return {
        type: "modal",
        callback_id: `${kind}_modal`,
        private_metadata: JSON.stringify({ list, id }),
        title: plain(kind === "move" ? "Move item" : "Priority"),
        submit: plain("Apply"),
        close: plain("Cancel"),
        blocks: [{
            type: "input", block_id: kind, label: plain(kind === "move" ? "To list" : "Priority"),
            element: { type: "static_select", action_id: "v", options, ...(initial && options.some(o => o.value === initial) ? { initial_option: option(initial, initial) } : {}) },
        }],
    };
}

export function deleteModal({ list, id, todo }) {
    return {
        type: "modal",
        callback_id: "delete_modal",
        private_metadata: JSON.stringify({ list, id }),
        title: plain("Delete item"),
        submit: plain("Delete"),
        close: plain("Cancel"),
        blocks: [{ type: "section", text: { type: "mrkdwn", text: `Delete *${esc(title(todo))}* from *${esc(list)}*?` } }],
    };
}

export const priorityOptions = () => PRIORITIES.map(p => option(p, p));
export const modalValue = (view, block) => {
    const v = view.state?.values?.[block]?.v || {};
    return v.value ?? v.selected_option?.value ?? v.selected_date ?? null;
};
