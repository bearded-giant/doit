import { z } from "zod";
import { composeTodoText, nextRank, normalizeTodoText, parseTags, parseTodoText, relabelTwin, renumberText } from "./todo-text.js";
import { isSequenced, setSequence } from "./sequence.js";

// the tmux chip shows list names whole, so length is capped here instead of cut there
const MAX_LIST_NAME = 24;
const listNameSchema = z.string()
    .max(MAX_LIST_NAME, `List names are capped at ${MAX_LIST_NAME} chars; shorten it (drop repeated or trailing words), do not cut mid-word.`)
    // the name is the filename; same charset as tmux sanitize_list_name, so no path can escape lists/
    .regex(/^(?!\.\.?$)[\w.-]+$/, "List names use letters, digits, '.', '_' and '-' only.");

export const PRIORITY_LABELS = { critical: "!!!", urgent: "!!", important: "!" };

// The cross-project inbox for actions the user owes; owe twins land here.
export const OWED_LIST = "daily";

// nudge callers to write human-readable notes — these render in the tmux/nvim
// right pane, so dense single-block walls are unreadable. claude:-prefixed
// todos are LLM burn-down items (machine-read) and don't need this.
const TYPE_HINT =
    " Short lowercase tag for the kind of work, rendered as a scannable [tag]" +
    " prefix — e.g. decision, gate, loader, bug, spike, chore, research." +
    " Free-form: coin a new one when none fit. Always set it on MCP-created items.";

const DEPS_HINT =
    " Rank numbers this item depends on, e.g. [12, 28] renders '(dep on #12, #28)'." +
    " Reference the leading N. of the blocking item, not its id. Pass [] to clear.";

const SCOPE_HINT = {
    worktree:
        "Worktree this item belongs to (the git worktree's directory name, e.g. 'golden-runs-tooling')." +
        " One repo list serves every worktree; set it on every item a session creates. Shown as [wt:...].",
    feature: "Feature this item belongs to, when the work is for one. Shown as [feat:...].",
};

const SEQUENCE_HINT =
    "Run-queue position (1 = first). Pending items with a sequence run in this order" +
    " across priorities; items already at this position and after it shift down one." +
    " To set a whole list's order at once, use sequence_todos.";

const NOTE_TODOS_HINT =
    " Todos on the same list this note relates to: each a rank number (the leading N.) or a todo id," +
    " e.g. [3, 12]. Unknown ones are rejected.";

const NOTE_FORMAT_HINT =
    " Format for a human reader: each labeled section on its own line, a blank" +
    " line between sections, commands/paths/code on their own lines (fence" +
    " multi-line code with ```). Don't cram it into one dense paragraph." +
    " (Exception: todos whose text starts 'claude:' are machine-read — plain is fine.)";

export const INSTRUCTIONS = `Do-it.nvim todo manager. Data lives at ~/.local/share/nvim/doit/lists/*.json, NOT in any project directory. Always use these tools for todo reads and writes; NEVER bash, grep, find, cat, or python on the JSON files.

Default list: "daily", unless the DOIT_ACTIVE_LIST env var names another. Every call without list= goes there. The user's tmux window links and global pointer are view state and never change this default, so pass list= explicitly for project work. switch_list changes the user's views only; call it only when the user asks. When list_lists marks the active list "(via DOIT_ACTIVE_LIST env override ...)", tell the user: a stale export in the shell that launched this server pins every omitted list= to one list.

Priorities: 'priorities' is critical, urgent, important, or absent (default). The user works by priority most days. Priority is criticality, not order: work order is the optional 'sequence' field (sequence_todos), taken before priority.

Item text convention, MANDATORY for every item you create:

    claude: [type] N. body (dep on #M, #K)

- [type]: short lowercase work-type tag (decision, gate, loader, bug, spike, chore, research, or one you coin). Pass add_todo's 'type' param, never hand-write the brackets. The tag makes a list scannable.
- N.: the item's fixed handle, unique across the list, assigned by add_todo (never write it into 'text'). Deps and #N references point at it. Never renumbered, so it is NOT the work order.
- body: a short label, 40 chars or fewer: verb + object, or a decision's topic as a short question. The user's tmux chip and board sidebar show it. Paths, commands, file lists, sub-steps, options, rationale, and status go in 'description', never the body.
- (dep on #M): pass blockers as the 'deps' param (rank numbers, not ids). Blocked work says so in the title, not only in the notes.
- claude:: leading marker on items the model burns down via /burn, in front of the type tag. Drop it with update_todo's 'claude' param set to false once the item is no longer model work; rewriting 'text' won't remove it, and never delete and recreate the item.
Retype or re-dep with update_todo's 'type' / 'deps' params; the rank is kept.

Owed items: "${OWED_LIST}" is the user's cross-project inbox of actions THEY owe, kept to signal. Call add_todo with owe=true and list=<the project list> only when all four hold: (1) only the user can do it: credentials, a console (vault, DNS, IdP, GCP, beta admin), or outward comms; a decision or question is never owed, ask it with AskUserQuestion; (2) actionable now: not waiting on another reviewer, a release, a cutover window, or another item; (3) something waits on it: blocked work, or a security/prod risk; (4) not routine flow. Never owe: resuming a session (the handoff carries it), merging or reviewing an MR, tagging or deploying after a merge, watching for a future event, "say ship it", approving a diff proposed in chat, anything the model can run. Conditional asks stay on the project list with deps and no owe; owe them once the dep clears. One console session is one owed item with a checklist. A decision item (type decision) exists only after the user deferred the question: ask it first (AskUserQuestion, 'Decide later' as the last option) and add the item only on that answer, or when nobody can be asked (/auto run, subagent, loop). Project list, no owe, never twinned into "${OWED_LIST}". One owe=true call writes the project item and its "${OWED_LIST}" twin, linked both ways. Write the description for the user: why, do (exact command + expected result), links, resume. Owed items never carry 'claude:'. complete_todo, revert_todo, delete_todo, move_todo, and update_todo's done/priority/due apply to both twins.`;

// unflagged lists count as claude; mirrors tmux/scripts/lib-source.sh
export function isMineList(name, data) {
    return name === "daily" || data?._metadata?.source === "user";
}

const SOURCE_FILTERS = ["all", "mine", "claude"];

const text = s => ({ content: [{ type: "text", text: s }] });

// a missing list is an error except daily, the fallback every surface lands on, which self-creates like nvim's load_list
function openList(ctx, listName, key = "list") {
    const name = listName || ctx.activeList;
    let data = ctx.store.getList(name);
    if (!data) {
        if (name !== OWED_LIST) throw new Error(`List "${name}" not found at ${ctx.store.pathOf(name)}`);
        const now = ctx.clock.now();
        data = { todos: [], _metadata: { created_at: now, updated_at: now } };
        ctx.store.putList(name, data);
    }
    if (key) ctx.resolved[key] = name;
    return { name, data };
}

// A copied id identifies an item globally, so an id-addressed call resolves the
// list that holds it instead of failing on whichever list happens to be active.
function openListForTodo(ctx, listName, id, key = "list") {
    if (!listName && id) {
        const found = ctx.store.findListByTodoId(id);
        if (found) {
            if (key) ctx.resolved[key] = found.name;
            return found;
        }
    }
    return openList(ctx, listName, key);
}

function save(ctx, name, data) {
    data._metadata = data._metadata || {};
    data._metadata.updated_at = ctx.clock.now();
    ctx.store.putList(name, data);
}

// Twins live in two files, so a change made here has to be written there too.
// tmux (tmux/scripts/lib-twin.sh) and nvim (lua/doit/modules/todos/state/twin.lua) mirror this.
function syncTwin(ctx, todo, mutate) {
    if (!todo.twin || !todo.twin.list || !todo.twin.id) return "";
    const data = ctx.store.getList(todo.twin.list);
    if (!data) return `\nTwin list "${todo.twin.list}" is gone.`;
    const twin = (data.todos || []).find(t => t.id === todo.twin.id);
    if (!twin) return `\nTwin ${todo.twin.id} is no longer in "${todo.twin.list}".`;
    const what = mutate(data, twin);
    save(ctx, todo.twin.list, data);
    return `\nTwin in "${todo.twin.list}" ${what}: ${twin.text}`;
}

// notes never sync between twins, so the deleted side's notes move onto the survivor
function detachTwin(ctx, todo, deletedList) {
    if (!todo.twin || todo.twin.list === deletedList) return "";
    const header = `${todo.twin.list}: ${todo.twin.id}`;
    return syncTwin(ctx, todo, (_, twin) => {
        let notes = stripFooter(todo.description).trim();
        if (notes.startsWith(header)) notes = notes.slice(header.length).trim();
        const body = stripFooter(twin.description).trimEnd();
        const parts = [body];
        if (notes && !body.includes(notes)) parts.push(`notes from "${deletedList}":\n${notes}`);
        parts.push(`list "${deletedList}" deleted ${ctx.clock.date()}; twin link dropped`);
        twin.description = stampDescription(ctx, parts.filter(Boolean).join("\n\n"));
        delete twin.twin;
        return "detached";
    });
}

function removeTodo(data, id) {
    const idx = data.todos.findIndex(t => t.id === id);
    // incomplete children outlive their parent (no completion cascade)
    promoteChildren(data.todos, id);
    const [removed] = data.todos.splice(idx, 1);
    data._metadata = data._metadata || {};
    data._metadata.deleted_todos = data._metadata.deleted_todos || [];
    data._metadata.deleted_todos.unshift(removed);
    data._metadata.deleted_todos = data._metadata.deleted_todos.slice(0, 10);
    return removed;
}

function hasTag(todoText, tag) {
    if (!tag) return true;
    return parseTags(todoText).includes(tag);
}

// Due dates are "YYYY-MM-DD" strings in the shared `due_date` field, matching
// state/due_dates.lua. Both ends of the comparison are taken at noon so a DST
// shift cannot round the difference to the wrong day.
const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDue(due) {
    if (typeof due !== "string" || !DUE_DATE_RE.test(due)) return null;
    const [y, m, d] = due.split("-").map(Number);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, m - 1, d, 12);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dt;
}

function daysUntilDue(due, now) {
    const dt = parseDue(due);
    if (!dt) return null;
    const ref = now || new Date();
    const todayNoon = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 12);
    return Math.round((dt - todayNoon) / 86400000);
}

export function renderDue(due, now) {
    const days = daysUntilDue(due, now);
    if (days === null) return "";
    if (days < 0) return `overdue ${-days}d`;
    if (days === 0) return "due today";
    if (days === 1) return "due tomorrow";
    return `in ${days}d`;
}

// Nesting: parent_id + depth, mirroring state/sorting.lua's structure_aware().
// A child rides with its parent so a subtree is contiguous and never splits
// across a section, and a child whose parent is missing is treated as a root so
// nothing disappears from the listing.
export function structureAware(todos) {
    const byId = new Map(todos.map(t => [t.id, t]));
    const children = new Map();
    const roots = [];

    for (const todo of todos) {
        const parent = todo.parent_id ? byId.get(todo.parent_id) : null;
        if (parent && parent !== todo) {
            if (!children.has(todo.parent_id)) children.set(todo.parent_id, []);
            children.get(todo.parent_id).push(todo);
        } else {
            roots.push(todo);
        }
    }

    const byOrder = (a, b) =>
        isSequenced(b) - isSequenced(a) ||
        (isSequenced(a) ? a.sequence - b.sequence : 0) ||
        (a.order_index || 0) - (b.order_index || 0);
    roots.sort(byOrder);
    for (const group of children.values()) group.sort(byOrder);

    const ordered = [];
    const seen = new Set();
    const emit = (todo, depth) => {
        if (seen.has(todo.id)) return;
        seen.add(todo.id);
        ordered.push({ todo, depth });
        for (const child of children.get(todo.id) || []) emit(child, depth + 1);
    };
    for (const root of roots) emit(root, 0);
    // anything left sat in a parent cycle; keep it reachable
    for (const todo of todos) if (!seen.has(todo.id)) ordered.push({ todo, depth: 0 });

    return ordered;
}

// Accepts an id or a rank number (the leading "N." the user scans), matching how
// deps are referenced.
function resolveTodoRef(todos, ref) {
    if (ref === undefined || ref === null || ref === "") return null;
    const asId = todos.find(t => t.id === String(ref));
    if (asId) return asId;
    const rank = Number(String(ref).replace(/^#/, ""));
    if (!Number.isNaN(rank)) {
        const byRank = todos.find(t => parseTodoText(t.text).rank === rank);
        if (byRank) return byRank;
    }
    return undefined; // explicitly "asked for one, found none"
}

function descendantIds(todos, rootId) {
    const out = new Set();
    const walk = id => {
        for (const t of todos) {
            if (t.parent_id === id && !out.has(t.id)) {
                out.add(t.id);
                walk(t.id);
            }
        }
    };
    walk(rootId);
    return out;
}

function redepth(todos, parentId, depth) {
    for (const t of todos) {
        if (t.parent_id === parentId) {
            t.depth = depth;
            redepth(todos, t.id, depth + 1);
        }
    }
}

// Promote a deleted todo's DIRECT children to top level. Their own descendants
// stay attached and are only re-depthed — a grandchild must not be orphaned
// because its grandparent went away. Completion is per-item with no cascade, so
// a child never vanishes because its parent was deleted.
function promoteChildren(todos, parentId) {
    for (const t of todos) {
        if (t.parent_id === parentId) {
            delete t.parent_id;
            t.depth = 0;
            redepth(todos, t.id, 1);
        }
    }
}

// Drop the machine-managed footer so re-saving refreshes the stamp instead of
// stacking. Matches either verb so older "last updated" stamps are stripped too.
export function stripFooter(desc) {
    return (desc || "").replace(/\n*----------\nlast (updated|modified):[\s\S]*$/, "");
}

// Append a fresh footer. Body may be empty (footer-only) — every todo carries a stamp.
function stampDescription(ctx, desc) {
    const body = stripFooter(desc).replace(/\s+$/, "");
    return `${body}\n\n\n----------\nlast modified: ${ctx.clock.stamp()}`;
}

function getMaxOrder(todos) {
    if (!todos.length) return 0;
    return Math.max(...todos.map(t => t.order_index || 0));
}

function fuzzyMatch(todos, query) {
    const words = query.toLowerCase().split(/\s+/);
    return todos.filter(t => {
        const hay = t.text.toLowerCase();
        return words.every(w => hay.includes(w));
    });
}

function scopeLabel(t) {
    return `${t.worktree ? ` [wt:${t.worktree}]` : ""}${t.feature ? ` [feat:${t.feature}]` : ""}`;
}

// "" clears a field; keep leaves a field the item already has
function applyScope(todo, { worktree, feature }, { keep = false } = {}) {
    for (const [key, val] of Object.entries({ worktree, feature })) {
        if (val === undefined || (keep && todo[key])) continue;
        if (val === "") delete todo[key];
        else todo[key] = val;
    }
}

// sessions in different worktrees share one repo list, so each worktree keeps its own active item
function stopActive(todos, todo) {
    for (const t of todos || []) {
        if (t !== todo && t.in_progress && (t.worktree || "") === (todo.worktree || "")) t.in_progress = false;
    }
}

function setDone(ctx, todo, done) {
    todo.done = done;
    if (done) {
        todo.in_progress = false;
        todo.completed_at = ctx.clock.now();
    } else {
        delete todo.completed_at;
    }
}

function formatTodoLine(t) {
    const status = t.done ? "[x]" : t.in_progress ? "[~]" : "[ ]";
    const prio = t.priorities ? ` ${PRIORITY_LABELS[t.priorities] || t.priorities}` : "";
    const hasNote = t.description ? " (has notes)" : "";
    return `${status}${prio} ${t.text}${hasNote}${scopeLabel(t)}  [id:${t.id}]`;
}

function presentChoices(matches, context, actionHint) {
    const lines = matches.map((t, i) => `${i + 1}. ${formatTodoLine(t)}`);
    return text(`${context}:\n\n${lines.join("\n")}\n\n${actionHint}`);
}

function formatNoteLine(n) {
    return `${n.title}  [id:${n.id}]`;
}

// unranked todos carry their id so the reference stays usable as a todo_ids entry
function formatTodoRef(t) {
    const first = (t.text || "").split("\n")[0];
    const { rankLabel, body } = parseTodoText(first);
    return rankLabel ? `#${rankLabel} ${body}` : `${first} [id:${t.id}]`;
}

// stale ids (deleted or moved todos) drop out instead of erroring
function linkedTodos(data, note) {
    const ids = new Set(note.todo_ids || []);
    return (data.todos || []).filter(t => ids.has(t.id));
}

function linkedNotes(data, todoId) {
    return (data.notes || []).filter(n => (n.todo_ids || []).includes(todoId));
}

function formatNoteTodos(data, note) {
    const todos = linkedTodos(data, note);
    return todos.length ? `todos: ${todos.map(formatTodoRef).join(", ")}` : "";
}

function resolveNoteTodoIds(ctx, data, listName, refs) {
    const ids = refs.map(ref => {
        const todo = resolveTodoRef(data.todos || [], ref);
        if (!todo) throw new Error(`Todo "${ref}" not found in list "${listName}". Pass a rank number or an id from that list.`);
        return todo.id;
    });
    const unique = [...new Set(ids)];
    ctx.resolved.todo_ids = unique;
    return unique;
}

function setNoteTodoIds(note, ids) {
    if (ids.length) note.todo_ids = ids;
    else delete note.todo_ids;
}

function presentNoteChoices(matches, context, actionHint) {
    const lines = matches.map((n, i) => `${i + 1}. ${formatNoteLine(n)}`);
    return text(`${context}:\n\n${lines.join("\n")}\n\n${actionHint}`);
}

// resolve a list note by id or fuzzy query on title/body
function resolveNote(ctx, data, listName, { id, query }) {
    const notes = data.notes || [];

    if (id) {
        const note = notes.find(n => n.id === id);
        if (!note) throw new Error(`Note "${id}" not found in list "${listName}"`);
        ctx.resolved.id = note.id;
        return { note };
    }

    if (query) {
        const words = query.toLowerCase().split(/\s+/);
        const matches = notes.filter(n => {
            const hay = `${n.title} ${n.body || ""}`.toLowerCase();
            return words.every(w => hay.includes(w));
        });
        if (matches.length === 0) return { noMatch: `No notes matching "${query}" on "${listName}".` };
        if (matches.length === 1) {
            ctx.resolved.id = matches[0].id;
            return { note: matches[0] };
        }
        return { matches };
    }

    return { noMatch: "Provide an id or query to identify the note." };
}

// resolve a todo by id, query, or fallback filter — returns { todo, ambiguous? response }
function resolveTodo(ctx, data, listName, { id, query, fallbackFilter }) {
    const todos = data.todos || [];
    const pick = todo => {
        ctx.resolved.id = todo.id;
        return { todo };
    };

    if (id) {
        const todo = todos.find(t => t.id === id);
        if (!todo) throw new Error(`Todo "${id}" not found in list "${listName}"`);
        return pick(todo);
    }

    if (query) {
        const notDone = todos.filter(t => !t.done);
        const matches = fuzzyMatch(notDone, query);
        if (matches.length === 0) return { noMatch: `No pending/in_progress items matching "${query}" on "${listName}".` };
        if (matches.length === 1) return pick(matches[0]);
        return { matches };
    }

    if (fallbackFilter) {
        const filtered = todos.filter(fallbackFilter);
        if (filtered.length === 0) return { noMatch: null };
        if (filtered.length === 1) return pick(filtered[0]);
        return { matches: filtered };
    }

    return { noMatch: "Provide an id or query to identify the todo item." };
}

function resolveParent(ctx, data, listName, parent, todo = null) {
    const parentTodo = resolveTodoRef(data.todos || [], parent);
    if (!parentTodo) throw new Error(`Parent "${parent}" not found in list "${listName}".`);
    if (todo) {
        if (parentTodo.id === todo.id) throw new Error("A todo cannot be its own parent.");
        if (descendantIds(data.todos || [], todo.id).has(parentTodo.id)) {
            throw new Error("That parent is inside this todo's own subtree, which would make a cycle.");
        }
    }
    ctx.resolved.parent = parentTodo.id;
    return parentTodo;
}

const listArg = z.string().optional().describe("List name (default: active list)");
const idArg = z.string().optional().describe("Todo ID.");
const queryArg = z.string().optional().describe("Fuzzy text match (all words must appear).");

export const TOOLS = [
    // --- READ ---
    {
        name: "list_todos",
        description: "List todo items from a do-it list (data at ~/.local/share/nvim/doit/lists/, not in project dir). Returns all items by default, or filter by status and/or priority. Priorities: critical, urgent, important, or none (default). Use this tool instead of reading JSON files directly.",
        schema: {
            list: listArg,
            filter: z.enum(["all", "pending", "done", "in_progress"]).optional().describe("Filter by status (default: all)"),
            priority: z.enum(["critical", "urgent", "important"]).optional().describe("Filter by priority level. Items without a priority are 'default'."),
            tag: z.string().optional().describe("Filter by inline #tag, without the '#'. Exact match: 'labels' does not match 'labels-web'."),
            due: z.enum(["overdue", "today", "week"]).optional().describe("Filter by due date: overdue, due today, or due within 7 days (which includes overdue and today)."),
            worktree: z.string().optional().describe("Only items stamped with this worktree (exact match)."),
            feature: z.string().optional().describe("Only items stamped with this feature (exact match)."),
        },
        async handler(ctx, { list, filter = "all", priority, tag, due, worktree, feature }) {
            const { name, data } = openList(ctx, list);
            let todos = data.todos || [];

            if (filter === "pending") todos = todos.filter(t => !t.done && !t.in_progress);
            else if (filter === "done") todos = todos.filter(t => t.done);
            else if (filter === "in_progress") todos = todos.filter(t => t.in_progress);

            if (priority) todos = todos.filter(t => t.priorities === priority);

            if (tag) {
                const wanted = tag.replace(/^#/, "");
                todos = todos.filter(t => hasTag(t.text, wanted));
            }

            if (worktree !== undefined) todos = todos.filter(t => t.worktree === worktree);
            if (feature !== undefined) todos = todos.filter(t => t.feature === feature);

            if (due) {
                todos = todos.filter(t => {
                    const days = daysUntilDue(t.due_date);
                    if (days === null) return false;
                    if (due === "overdue") return days < 0;
                    if (due === "today") return days === 0;
                    return days <= 7; // "week" spans overdue through the next 7 days
                });
            }

            const lines = structureAware(todos).map(({ todo: t, depth }) => {
                const status = t.done ? "[x]" : t.in_progress ? "[~]" : "[ ]";
                const prio = t.priorities ? ` ${PRIORITY_LABELS[t.priorities] || t.priorities}` : "";
                const dueLabel = t.due_date ? ` [${renderDue(t.due_date)}]` : "";
                const seqLabel = isSequenced(t) ? ` [seq ${t.sequence}]` : "";
                const indent = "  ".repeat(depth);
                let line = `${indent}${status}${prio} ${t.text}${dueLabel}${seqLabel}${scopeLabel(t)}  [id:${t.id}]`;
                if (t.description) {
                    const notePreview = t.description.split("\n").map(l => `    ${l}`).join("\n");
                    line += `\n    notes:\n${notePreview}`;
                }
                return line;
            });

            const notes = data.notes || [];
            let out = `List: ${name} (${todos.length} items)\n\n${lines.join("\n") || "(empty)"}`;
            if (notes.length) {
                out += `\n\nNotes (${notes.length}):\n${notes.map(n => `- ${formatNoteLine(n)}`).join("\n")}`;
            }
            return text(out);
        },
    },
    {
        name: "list_tags",
        description: "List the inline #tags used on a do-it list, with how many items carry each. Tags are parsed from todo text — there is no tag field. Counts cover active (not done) items by default, matching what the nvim and tmux tag pickers show.",
        schema: {
            list: listArg,
            include_done: z.boolean().optional().describe("Also count tags on completed items (default: false)"),
        },
        async handler(ctx, { list, include_done }) {
            const { name, data } = openList(ctx, list);
            const todos = (data.todos || []).filter(t => include_done || !t.done);

            const counts = new Map();
            for (const todo of todos) {
                for (const tag of parseTags(todo.text)) counts.set(tag, (counts.get(tag) || 0) + 1);
            }

            if (counts.size === 0) return text(`No tags on "${name}".`);

            const rows = [...counts.entries()]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([tag, n]) => `#${tag}  (${n})`);
            return text(`Tags on "${name}":\n\n${rows.join("\n")}`);
        },
    },
    {
        name: "search_todos",
        description: "Search across all do-it todo lists (in ~/.local/share/nvim/doit/lists/) for items matching a text pattern. Use this instead of grepping files.",
        schema: {
            query: z.string().describe("Search text (case-insensitive substring match)"),
            include_done: z.boolean().optional().describe("Include completed items (default: false)"),
        },
        async handler(ctx, { query, include_done = false }) {
            const pattern = query.toLowerCase();
            const results = [];

            for (const listName of ctx.store.listNames()) {
                const data = ctx.store.getList(listName);
                for (const t of data.todos || []) {
                    if (!include_done && t.done) continue;
                    const haystack = `${t.text} ${t.description || ""}`.toLowerCase();
                    if (haystack.includes(pattern)) results.push(`${formatTodoLine(t)}  [list:${listName}]`);
                }
            }

            return text(results.length
                ? `Found ${results.length} match(es):\n\n${results.join("\n")}`
                : `No matches for "${query}"`);
        },
    },
    {
        name: "get_todo",
        description: "Fetch one todo item by id from whichever list holds it — no list name needed. Use this when the user pastes or names an id (ids are copyable from the tmux and nvim item views). The result names the list, so follow-up tools can be scoped to it; start_todo, complete_todo, revert_todo, update_todo, add_note, delete_todo and move_todo also accept a bare id and find the list themselves.",
        schema: {
            id: z.string().describe("Todo id, as copied from the tmux (i) or nvim (y) item view, or shown as [id:...] by list_todos"),
        },
        async handler(ctx, { id }) {
            const found = ctx.store.findListByTodoId(id);
            if (!found) return text(`No todo with id "${id}" in any list. Use search_todos to find it by text.`);

            const todos = found.data.todos || [];
            const todo = todos.find(t => t.id === id);
            const parent = todo.parent_id ? todos.find(t => t.id === todo.parent_id) : null;
            const children = todos.filter(t => t.parent_id === id);
            const tags = parseTags(todo.text || "");

            const lines = [
                `List: ${found.name}`,
                `Status: ${todo.done ? "Done" : todo.in_progress ? "In Progress" : "Pending"}`,
                `Priority: ${todo.priorities || "none"}`,
            ];
            if (todo.sequence) lines.push(`Sequence: ${todo.sequence}`);
            if (todo.worktree) lines.push(`Worktree: ${todo.worktree}`);
            if (todo.feature) lines.push(`Feature: ${todo.feature}`);
            if (todo.due_date) lines.push(`Due: ${todo.due_date} (${renderDue(todo.due_date)})`);
            if (tags.length) lines.push(`Tags: ${tags.map(t => `#${t}`).join(" ")}`);
            if (parent) lines.push(`Parent: ${formatTodoLine(parent)}`);
            if (children.length) {
                lines.push(`Children (${children.length}):`);
                for (const child of children) lines.push(`  ${formatTodoLine(child)}`);
            }
            const notes = linkedNotes(found.data, id);
            if (notes.length) {
                lines.push(`List notes (${notes.length}):`);
                for (const note of notes) lines.push(`  ${formatNoteLine(note)}`);
            }
            lines.push("", todo.text || "");
            if (todo.description) lines.push("", "Notes:", todo.description);
            return text(lines.join("\n"));
        },
    },

    // --- CREATE ---
    {
        name: "add_todo",
        description: "Add a new todo item to a do-it list (writes to ~/.local/share/nvim/doit/lists/). Do not write JSON files directly. Stored text is composed as \"claude: [type] N. text (dep on #M)\" — pass type and deps as params, the rank N is assigned automatically.",
        schema: {
            text: z.string().describe("Todo text: a short label, 40 chars or fewer (verb + object; a decision's topic as a short question). Paths, commands, sub-steps, options, and why go in 'description'. Omit the [type] prefix and the leading rank number — those are composed from the params below. Keep a leading 'claude:' if the item is for the model to burn down."),
            list: listArg,
            type: z.string().optional().describe("Work type." + TYPE_HINT),
            deps: z.array(z.union([z.number(), z.string()])).optional().describe("Blocking rank numbers." + DEPS_HINT),
            description: z.string().optional().describe("Multi-line notes/description." + NOTE_FORMAT_HINT),
            priority: z.enum(["critical", "urgent", "important"]).optional().describe("Priority level"),
            due: z.string().optional().describe("Due date as YYYY-MM-DD. Shared with the nvim and tmux views."),
            parent: z.union([z.number(), z.string()]).optional().describe("Nest under this item: its rank number (the leading N.) or its id. Ranks stay flat and unique across the whole list."),
            start: z.boolean().optional().describe("Immediately set as in_progress (default: false)"),
            sequence: z.number().int().positive().optional().describe(SEQUENCE_HINT),
            worktree: z.string().optional().describe(SCOPE_HINT.worktree),
            feature: z.string().optional().describe(SCOPE_HINT.feature),
            owe: z.boolean().optional().describe(`The USER owes this action and nothing else can do it: credentials, a console (vault, DNS, IdP, GCP, beta admin), or outward comms (a decision or question is asked, never owed), actionable now, with work or a security/prod risk waiting on it. Never for resuming a session, merging/reviewing an MR, tagging/deploying after a merge, watching for a future event, or anything the model can run. Writes this item AND a twin in "${OWED_LIST}", cross-linked by id, so the user tracks everything they owe across projects in one list. Completing, reverting, deleting or re-prioritizing either twin through these tools applies to both. Put why / do / links / resume sections in 'description'; both twins get it. Not for 'claude:' items.`),
        },
        async handler(ctx, { text: todoText, list, type, deps, description, priority, due, parent, start, sequence, owe, worktree, feature }) {
            const { name, data } = openList(ctx, list);
            const id = ctx.newId();
            const parsed = parseTodoText(todoText);
            const twinned = Boolean(owe) && name !== OWED_LIST;
            if (twinned && parsed.claude) {
                throw new Error("owe items are the user's work: drop the leading 'claude:'.");
            }
            const owed = twinned ? openList(ctx, OWED_LIST, null) : null;
            const owedRank = owed ? nextRank(owed.data.todos || []) : null;
            const rank = nextRank(data.todos || []);
            const composed = twinned
                ? composeTodoText(`owed in ${OWED_LIST} #${owedRank}: ${parsed.body.trim()}`, { type: type || parsed.type, deps, rank })
                : composeTodoText(todoText, { type, deps, rank: ctx.source === "mcp" ? rank : null });
            const newTodo = {
                id,
                text: composed,
                done: false,
                in_progress: start || false,
                order_index: getMaxOrder(data.todos || []) + 1,
                created_at: ctx.clock.now(),
                source: ctx.source,
            };
            newTodo.description = stampDescription(ctx, description || "");
            applyScope(newTodo, { worktree, feature });
            if (priority) newTodo.priorities = priority;
            if (due) {
                if (!parseDue(due)) throw new Error(`Invalid due date "${due}". Use YYYY-MM-DD.`);
                newTodo.due_date = due;
            }
            if (parent !== undefined) {
                const parentTodo = resolveParent(ctx, data, name, parent);
                newTodo.parent_id = parentTodo.id;
                newTodo.depth = (parentTodo.depth || 0) + 1;
            }

            let twinLine = "";
            if (twinned) {
                const owedId = ctx.newId();
                const extra = description ? `\n\n${description}` : "";
                const owedTodo = {
                    id: owedId,
                    // the rank leads so a list named "claude" is a label, not the burn marker
                    text: composeTodoText(`${owedRank}. ${name}: ${parsed.body.trim()}`, { type: type || parsed.type }),
                    done: false,
                    in_progress: false,
                    order_index: getMaxOrder(owed.data.todos || []) + 1,
                    created_at: newTodo.created_at,
                    source: "mcp",
                    description: stampDescription(ctx, `from: ${name} #${rank} (id ${id})${extra}`),
                    twin: { list: name, id },
                };
                if (newTodo.priorities) owedTodo.priorities = newTodo.priorities;
                if (newTodo.due_date) owedTodo.due_date = newTodo.due_date;
                applyScope(owedTodo, newTodo);
                newTodo.description = stampDescription(ctx, `${OWED_LIST}: ${owedId}${extra}`);
                newTodo.twin = { list: OWED_LIST, id: owedId };
                owed.data.todos = owed.data.todos || [];
                owed.data.todos.push(owedTodo);
                save(ctx, OWED_LIST, owed.data);
                twinLine = `\nTwin in "${OWED_LIST}": ${owedTodo.text} [id:${owedId}]`;
            }

            data.todos = data.todos || [];
            if (start) stopActive(data.todos, newTodo);
            data.todos.push(newTodo);
            if (sequence) setSequence(data.todos, newTodo, sequence);
            save(ctx, name, data);

            const status = start ? " (in_progress)" : "";
            return text(`Added to "${name}": ${composed}${status}${scopeLabel(newTodo)} [id:${id}]${twinLine}`);
        },
    },

    // --- UPDATE ---
    {
        name: "update_todo",
        description: "Update a todo item (in ~/.local/share/nvim/doit/lists/) — change text, description, status (done/in_progress), priority, or reorder. Requires ID. For fuzzy matching, use start_todo/complete_todo/revert_todo instead.",
        schema: {
            id: z.string().describe("Todo ID"),
            list: listArg,
            text: z.string().optional().describe("New text: a short label, 40 chars or fewer; details go in 'description'. The item's existing [type] prefix and rank number carry over — pass the body only."),
            type: z.string().optional().describe("Change the work type." + TYPE_HINT),
            deps: z.array(z.union([z.number(), z.string()])).optional().describe("Replace the blocking rank numbers." + DEPS_HINT),
            claude: z.boolean().optional().describe("Toggle the leading 'claude:' burn-down marker. Pass false to drop it when an item stops being model work — rewriting 'text' alone will not remove it."),
            description: z.string().optional().describe("New description/notes." + NOTE_FORMAT_HINT),
            priority: z.enum(["critical", "urgent", "important", "none"]).optional().describe("Set priority level. Use 'none' to remove priority."),
            done: z.boolean().optional().describe("Set done status"),
            in_progress: z.boolean().optional().describe("Set in_progress status"),
            order_index: z.number().optional().describe("Set order position inside the item's priority section. For run order across priorities use 'sequence'."),
            sequence: z.number().int().min(0).optional().describe(SEQUENCE_HINT + " 0 clears it."),
            due: z.string().optional().describe("Set due date as YYYY-MM-DD. Use an empty string to clear it."),
            parent: z.union([z.number(), z.string()]).optional().describe("Re-nest under this item (rank number or id). Use an empty string to move it back to the top level."),
            worktree: z.string().optional().describe(SCOPE_HINT.worktree + " Empty string clears it."),
            feature: z.string().optional().describe(SCOPE_HINT.feature + " Empty string clears it."),
        },
        async handler(ctx, { id, list, text: todoText, type, deps, claude, description, priority, done, in_progress, order_index, sequence, due, parent, worktree, feature }) {
            const { name, data } = openListForTodo(ctx, list, id);
            const todo = (data.todos || []).find(t => t.id === id);
            if (!todo) throw new Error(`Todo "${id}" not found in list "${name}"`);
            ctx.resolved.id = todo.id;

            if (todoText !== undefined || type !== undefined || deps !== undefined || claude !== undefined) {
                todo.text = composeTodoText(todoText !== undefined ? todoText : todo.text, {
                    type,
                    deps,
                    claude,
                    inherit: todo.text,
                });
            }
            if (description !== undefined) todo.description = stampDescription(ctx, description);
            applyScope(todo, { worktree, feature });
            if (priority !== undefined) {
                if (priority === "none") delete todo.priorities;
                else todo.priorities = priority;
            }
            if (done !== undefined) setDone(ctx, todo, done);
            if (in_progress !== undefined) {
                todo.in_progress = in_progress;
                if (in_progress) todo.done = false;
            }
            if (order_index !== undefined) todo.order_index = order_index;
            if (sequence !== undefined) setSequence(data.todos, todo, sequence);
            if (parent !== undefined) {
                if (parent === "") {
                    delete todo.parent_id;
                    todo.depth = 0;
                    ctx.resolved.parent = "";
                } else {
                    const parentTodo = resolveParent(ctx, data, name, parent, todo);
                    todo.parent_id = parentTodo.id;
                    todo.depth = (parentTodo.depth || 0) + 1;
                }
            }
            if (due !== undefined) {
                if (due === "") {
                    delete todo.due_date;
                } else if (!parseDue(due)) {
                    throw new Error(`Invalid due date "${due}". Use YYYY-MM-DD.`);
                } else {
                    todo.due_date = due;
                }
            }

            save(ctx, name, data);
            let twinNote = "";
            if (done !== undefined || priority !== undefined || due !== undefined) {
                twinNote = syncTwin(ctx, todo, (_, t) => {
                    if (done !== undefined) {
                        t.done = done;
                        if (done) {
                            t.in_progress = false;
                            t.completed_at = todo.completed_at;
                        } else {
                            delete t.completed_at;
                        }
                    }
                    if (priority !== undefined) {
                        if (todo.priorities) t.priorities = todo.priorities;
                        else delete t.priorities;
                    }
                    if (due !== undefined) {
                        if (todo.due_date) t.due_date = todo.due_date;
                        else delete t.due_date;
                    }
                    return "updated";
                });
            }

            return text(`Updated in "${name}": ${todo.text}${scopeLabel(todo)} [done:${todo.done}, in_progress:${todo.in_progress}${todo.sequence ? `, sequence:${todo.sequence}` : ""}]${twinNote}`);
        },
    },
    {
        name: "sequence_todos",
        description: "Set a list's whole run order in one call. Items in 'order' get sequence 1..n and every other item's sequence is cleared. Pending sequenced items render in a Sequence section above the priority sections and run in this order across priorities. Each item's rank N is unchanged, so deps and #N references keep working.",
        schema: {
            order: z.array(z.union([z.number(), z.string()])).min(1).describe("Items in run order, by rank number (the leading N.) or id."),
            list: listArg,
        },
        async handler(ctx, { order, list }) {
            const { name, data } = openList(ctx, list);
            const todos = data.todos || [];
            const picked = order.map(ref => {
                const todo = resolveTodoRef(todos, ref);
                if (!todo) throw new Error(`"${ref}" not found in list "${name}".`);
                return todo;
            });
            if (new Set(picked).size !== picked.length) throw new Error("An item appears more than once in 'order'.");
            ctx.resolved.order = picked.map(t => t.id);

            for (const t of todos) delete t.sequence;
            picked.forEach((t, i) => { t.sequence = i + 1; });
            save(ctx, name, data);

            const lines = picked.map((t, i) => {
                const status = t.done ? " (done, ignored until reverted)" : t.in_progress ? " (in progress, shows under In Progress)" : "";
                return `${i + 1}) ${t.text}${status}`;
            });
            return text(`Sequenced "${name}":\n${lines.join("\n")}`);
        },
    },
    {
        name: "start_todo",
        description: "Start a todo item (set in_progress=true): the active item for its worktree, shown in the user's tmux chip and nvim statusline. Supports fuzzy text query. One item per worktree is in_progress: starting one stops the current one with the same worktree (items with no worktree share one slot), so parallel sessions on one repo list each keep their own. Call it before working an item, and leave the next item started when you stop.",
        schema: { id: idArg, query: queryArg, list: listArg },
        async handler(ctx, { id, query, list }) {
            const { name, data } = openListForTodo(ctx, list, id);
            const result = resolveTodo(ctx, data, name, {
                id, query,
                fallbackFilter: t => !t.done && !t.in_progress,
            });

            if (result.noMatch !== undefined) return text(result.noMatch || `No pending items on "${name}".`);
            if (result.matches) {
                return presentChoices(result.matches, `Multiple items match on "${name}"`, "Ask the user which to start, then call start_todo with the chosen ID.");
            }

            stopActive(data.todos, result.todo);
            result.todo.in_progress = true;
            result.todo.done = false;
            save(ctx, name, data);

            return text(`Started in "${name}": ${result.todo.text}${scopeLabel(result.todo)}`);
        },
    },
    {
        name: "complete_todo",
        description: "Complete a todo item (set done=true). Supports fuzzy text query. With no args, finds in_progress items. Single match auto-completes; multiple returns list for user to pick.",
        schema: { id: z.string().optional().describe("Todo ID to complete."), query: queryArg, list: listArg },
        async handler(ctx, { id, query, list }) {
            const { name, data } = openListForTodo(ctx, list, id);
            const result = resolveTodo(ctx, data, name, {
                id, query,
                fallbackFilter: t => t.in_progress && !t.done,
            });

            if (result.noMatch !== undefined) {
                return text(result.noMatch || `No in_progress items on "${name}". Use complete_todo with a query to match by text.`);
            }
            if (result.matches) {
                return presentChoices(result.matches, `Multiple items match on "${name}"`, "Ask the user which to complete, then call complete_todo with the chosen ID.");
            }

            setDone(ctx, result.todo, true);
            save(ctx, name, data);
            const twinNote = syncTwin(ctx, result.todo, (_, t) => {
                t.done = true;
                t.in_progress = false;
                t.completed_at = result.todo.completed_at;
                return "completed";
            });

            return text(`Completed in "${name}": ${result.todo.text}${twinNote}`);
        },
    },
    {
        name: "revert_todo",
        description: "Revert a todo item back to pending (done=false, in_progress=false). Supports fuzzy text query. Useful for un-completing or un-starting items.",
        schema: {
            id: idArg,
            query: z.string().optional().describe("Fuzzy text match (all words must appear). Searches done and in_progress items."),
            list: listArg,
        },
        async handler(ctx, { id, query, list }) {
            const { name, data } = openListForTodo(ctx, list, id);
            const result = resolveTodo(ctx, data, name, {
                id, query,
                fallbackFilter: t => t.done || t.in_progress,
            });

            if (result.noMatch !== undefined) return text(result.noMatch || `No done/in_progress items on "${name}" to revert.`);
            if (result.matches) {
                return presentChoices(result.matches, `Multiple items match on "${name}"`, "Ask the user which to revert, then call revert_todo with the chosen ID.");
            }

            result.todo.done = false;
            result.todo.in_progress = false;
            delete result.todo.completed_at;
            save(ctx, name, data);
            const twinNote = syncTwin(ctx, result.todo, (_, t) => {
                t.done = false;
                t.in_progress = false;
                delete t.completed_at;
                return "reverted";
            });

            return text(`Reverted to pending in "${name}": ${result.todo.text}${twinNote}`);
        },
    },
    {
        name: "add_note",
        description: "Add or update a note (description) on a todo item. Supports fuzzy text query. By default appends to existing notes; use mode='replace' to overwrite.",
        schema: {
            id: idArg,
            query: queryArg,
            note: z.string().describe("Note text to add to the todo item." + NOTE_FORMAT_HINT),
            list: listArg,
            mode: z.enum(["append", "replace"]).optional().describe("'append' (default) adds to existing notes, 'replace' overwrites them."),
        },
        async handler(ctx, { id, query, note, list, mode = "append" }) {
            const { name, data } = openListForTodo(ctx, list, id);
            const result = resolveTodo(ctx, data, name, { id, query });

            if (result.noMatch !== undefined) return text(result.noMatch);
            if (result.matches) {
                return presentChoices(result.matches, `Multiple items match on "${name}"`, "Ask the user which item to add the note to, then call add_note with the chosen ID.");
            }

            const todo = result.todo;
            if (mode === "replace" || !todo.description) {
                todo.description = stampDescription(ctx, note);
            } else {
                todo.description = stampDescription(ctx, stripFooter(todo.description).trimEnd() + "\n\n" + note);
            }
            save(ctx, name, data);

            return text(`Note ${mode === "replace" ? "set" : "added"} on "${name}": ${todo.text}\n\nFull note:\n${todo.description}`);
        },
    },

    // --- DELETE ---
    {
        name: "delete_todo",
        description: "Delete a todo item. Supports fuzzy text query. Moves to _metadata.deleted_todos for undo support.",
        schema: { id: idArg, query: queryArg, list: listArg },
        async handler(ctx, { id, query, list }) {
            const { name, data } = openListForTodo(ctx, list, id);
            const result = resolveTodo(ctx, data, name, { id, query });

            if (result.noMatch !== undefined) return text(result.noMatch);
            if (result.matches) {
                return presentChoices(result.matches, `Multiple items match on "${name}"`, "Ask the user which to delete, then call delete_todo with the chosen ID.");
            }

            const removed = removeTodo(data, result.todo.id);
            save(ctx, name, data);
            const twinNote = syncTwin(ctx, removed, (twinData, t) => {
                removeTodo(twinData, t.id);
                return "deleted";
            });

            return text(`Deleted from "${name}": ${removed.text}${twinNote}`);
        },
    },
    {
        name: "clear_done",
        description: "Delete all completed (done) items from a list. Moves them to _metadata.deleted_todos (last 10 kept for undo).",
        schema: { list: listArg },
        async handler(ctx, { list }) {
            const { name, data } = openList(ctx, list);
            const done = (data.todos || []).filter(t => t.done);

            if (done.length === 0) return text(`No completed items on "${name}".`);

            for (const t of done) promoteChildren(data.todos, t.id);
            data.todos = data.todos.filter(t => !t.done);
            data._metadata = data._metadata || {};
            data._metadata.deleted_todos = [...done, ...(data._metadata.deleted_todos || [])].slice(0, 10);
            save(ctx, name, data);

            return text(`Cleared ${done.length} completed items from "${name}".`);
        },
    },
    {
        name: "dedupe_todos",
        description: "Remove duplicate todos from a list. Duplicates are items whose text matches after normalization — the claude: marker, [type] tag, rank prefix and (dep on #N) suffix are ignored, so an item typed in nvim matches the same item created here. Defaults to a DRY RUN that only reports what it would remove; pass dry_run:false to actually delete. Ranks are not renumbered.",
        schema: {
            list: listArg,
            dry_run: z.boolean().optional().describe("Report without deleting (default: true). Pass false to delete."),
        },
        async handler(ctx, { list, dry_run }) {
            const dryRun = dry_run !== false;
            const { name, data } = openList(ctx, list);
            const todos = data.todos || [];

            // first occurrence in order_index order is the keeper, so repeated runs
            // are stable; a copy carrying notes wins over a bare one
            const ordered = [...todos].sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
            const groups = new Map();
            for (const todo of ordered) {
                const key = normalizeTodoText(todo.text);
                if (!key) continue; // an empty body carries no identity
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(todo);
            }

            const removed = [];
            const report = [];
            for (const [, items] of groups) {
                if (items.length < 2) continue;
                // every todo carries a footer stamp, so "has a description" is always
                // true — the tie-break has to look past the footer at real notes
                const hasNotes = t => Boolean(stripFooter(t.description).trim());
                const keepIdx = items.findIndex(hasNotes);
                const keeper = items[keepIdx === -1 ? 0 : keepIdx];
                const drops = items.filter(t => t !== keeper);
                removed.push(...drops);
                report.push(
                    `keep: ${keeper.text}` +
                        drops.map(d => `\n  drop: ${d.text}${hasNotes(d) ? " (HAS NOTES)" : ""}`).join("")
                );
            }

            if (removed.length === 0) return text(`No duplicates on "${name}".`);

            if (dryRun) {
                return text(
                    `DRY RUN — would remove ${removed.length} duplicate(s) from "${name}":\n\n` +
                        report.join("\n\n") +
                        `\n\nRe-run with dry_run:false to apply.`,
                );
            }

            const dropIds = new Set(removed.map(t => t.id));
            data.todos = todos.filter(t => !dropIds.has(t.id));
            data._metadata = data._metadata || {};
            data._metadata.deleted_todos = [...removed, ...(data._metadata.deleted_todos || [])].slice(0, 10);
            save(ctx, name, data);

            return text(`Removed ${removed.length} duplicate(s) from "${name}":\n\n${report.join("\n\n")}`);
        },
    },

    // --- LIST NOTES (list-scoped scratch notes, parallel to todos — not todo descriptions) ---
    {
        name: "list_notes",
        description: "List the list-scoped scratch notes on a do-it list (top-level notes array, separate from todo item descriptions). Returns titles + ids and the todos each note links to; use get_note for a full body.",
        schema: { list: listArg },
        async handler(ctx, { list }) {
            const { name, data } = openList(ctx, list);
            const notes = data.notes || [];
            const lines = notes.map(n => {
                const todos = formatNoteTodos(data, n);
                return `- ${formatNoteLine(n)}${todos ? `\n    ${todos}` : ""}`;
            });
            return text(`Notes on "${name}" (${notes.length}):\n\n${lines.join("\n") || "(none)"}`);
        },
    },
    {
        name: "get_note",
        description: "Read the full body of one list note. Find by id or fuzzy query on title/body.",
        schema: {
            id: z.string().optional().describe("Note ID."),
            query: z.string().optional().describe("Fuzzy text match on title/body (all words must appear)."),
            list: listArg,
        },
        async handler(ctx, { id, query, list }) {
            const { name, data } = openList(ctx, list);
            const result = resolveNote(ctx, data, name, { id, query });

            if (result.noMatch) return text(result.noMatch);
            if (result.matches) {
                return presentNoteChoices(result.matches, `Multiple notes match on "${name}"`, "Ask the user which note, then call get_note with the chosen ID.");
            }

            const n = result.note;
            const todos = formatNoteTodos(data, n);
            return text(`# ${n.title}  [id:${n.id}]${todos ? `\n${todos}` : ""}\n\n${n.body || "(empty body)"}`);
        },
    },
    {
        name: "create_note",
        description: "Create a new list-scoped scratch note on a do-it list. It lives in the list's notes, not in any todo's description (to write onto a todo item use add_note), and may link to todos on the same list via todo_ids.",
        schema: {
            title: z.string().describe("Note title (single line, shown in list rows)"),
            body: z.string().optional().describe("Note body (may contain newlines)"),
            list: listArg,
            todo_ids: z.array(z.union([z.number(), z.string()])).optional().describe("Link the note to these todos." + NOTE_TODOS_HINT),
        },
        async handler(ctx, { title, body, list, todo_ids }) {
            const { name, data } = openList(ctx, list);
            const now = ctx.clock.now();
            const note = {
                id: ctx.newId(),
                title,
                body: body || "",
                created_at: now,
                updated_at: now,
            };
            if (todo_ids) setNoteTodoIds(note, resolveNoteTodoIds(ctx, data, name, todo_ids));
            data.notes = data.notes || [];
            data.notes.push(note);
            save(ctx, name, data);

            const todos = formatNoteTodos(data, note);
            return text(`Created note on "${name}": ${formatNoteLine(note)}${todos ? `\n${todos}` : ""}`);
        },
    },
    {
        name: "update_note",
        description: "Update a list note's title, body, and/or linked todos. Find by id or fuzzy query. Body mode: 'replace' (default) overwrites, 'append' adds to existing body.",
        schema: {
            id: z.string().optional().describe("Note ID."),
            query: z.string().optional().describe("Fuzzy text match on title/body (all words must appear)."),
            list: listArg,
            title: z.string().optional().describe("New title"),
            body: z.string().optional().describe("New/additional body text"),
            mode: z.enum(["replace", "append"]).optional().describe("'replace' (default) overwrites body, 'append' adds to it"),
            todo_ids: z.array(z.union([z.number(), z.string()])).optional().describe("Replace the note's linked todos with these; [] clears them. Omit to leave links as they are." + NOTE_TODOS_HINT),
        },
        async handler(ctx, { id, query, list, title, body, mode = "replace", todo_ids }) {
            const { name, data } = openList(ctx, list);
            const result = resolveNote(ctx, data, name, { id, query });

            if (result.noMatch) return text(result.noMatch);
            if (result.matches) {
                return presentNoteChoices(result.matches, `Multiple notes match on "${name}"`, "Ask the user which note to update, then call update_note with the chosen ID.");
            }

            const note = result.note;
            if (todo_ids !== undefined) setNoteTodoIds(note, resolveNoteTodoIds(ctx, data, name, todo_ids));
            if (title !== undefined) note.title = title;
            if (body !== undefined) {
                if (mode === "append" && note.body) note.body = note.body.trimEnd() + "\n\n" + body;
                else note.body = body;
            }
            note.updated_at = ctx.clock.now();
            save(ctx, name, data);

            const todos = formatNoteTodos(data, note);
            return text(`Updated note on "${name}": ${formatNoteLine(note)}${todos ? `\n${todos}` : ""}`);
        },
    },
    {
        name: "delete_note",
        description: "Delete a list note. Find by id or fuzzy query. Moves to _metadata.deleted_notes (last 10 kept).",
        schema: {
            id: z.string().optional().describe("Note ID."),
            query: z.string().optional().describe("Fuzzy text match on title/body (all words must appear)."),
            list: listArg,
        },
        async handler(ctx, { id, query, list }) {
            const { name, data } = openList(ctx, list);
            const result = resolveNote(ctx, data, name, { id, query });

            if (result.noMatch) return text(result.noMatch);
            if (result.matches) {
                return presentNoteChoices(result.matches, `Multiple notes match on "${name}"`, "Ask the user which note to delete, then call delete_note with the chosen ID.");
            }

            const idx = data.notes.findIndex(n => n.id === result.note.id);
            const [removed] = data.notes.splice(idx, 1);
            data._metadata = data._metadata || {};
            data._metadata.deleted_notes = data._metadata.deleted_notes || [];
            data._metadata.deleted_notes.unshift(removed);
            data._metadata.deleted_notes = data._metadata.deleted_notes.slice(0, 10);
            save(ctx, name, data);

            return text(`Deleted note from "${name}": ${removed.title}`);
        },
    },

    // --- MOVE ---
    {
        name: "move_todo",
        description: "Move a todo item from one list to another. Supports fuzzy text query to find the item.",
        schema: {
            id: idArg,
            query: queryArg,
            from_list: z.string().optional().describe("Source list (default: active list)"),
            to_list: z.string().describe("Target list name to move the item to"),
        },
        async handler(ctx, { id, query, from_list, to_list }) {
            const source = openListForTodo(ctx, from_list, id, "from_list");
            const result = resolveTodo(ctx, source.data, source.name, { id, query });

            if (result.noMatch !== undefined) return text(result.noMatch);
            if (result.matches) {
                return presentChoices(result.matches, `Multiple items match on "${source.name}"`, "Ask the user which to move, then call move_todo with the chosen ID.");
            }

            const targetData = ctx.store.getList(to_list);
            if (!targetData) throw new Error(`Target list "${to_list}" not found. Use list_lists to see available lists.`);

            // remove from source
            const idx = source.data.todos.findIndex(t => t.id === result.todo.id);
            // the subtree stays behind, promoted, rather than following across lists
            promoteChildren(source.data.todos, source.data.todos[idx].id);
            const [moved] = source.data.todos.splice(idx, 1);
            delete moved.parent_id;
            moved.depth = 0;

            // add to target
            targetData.todos = targetData.todos || [];
            moved.order_index = getMaxOrder(targetData.todos) + 1;
            delete moved.sequence;
            const { rank } = parseTodoText(moved.text);
            const rankMap = rank === null ? null : new Map([[rank, nextRank(targetData.todos)]]);
            if (rankMap) {
                const { text: renumbered, dropped } = renumberText(moved.text, rankMap);
                moved.text = renumbered;
                if (dropped.length) {
                    const kept = stripFooter(moved.description).trimEnd();
                    moved.description = stampDescription(
                        ctx,
                        `${kept ? `${kept}\n\n` : ""}moved from ${source.name} #${rank}; its deps there: ${dropped.join(", ")}`,
                    );
                }
            }
            if (moved.in_progress) stopActive(targetData.todos, moved);
            targetData.todos.push(moved);

            save(ctx, source.name, source.data);
            save(ctx, to_list, targetData);
            const twinNote = syncTwin(ctx, moved, (_, t) => {
                relabelTwin(t, t.twin.list, to_list, rankMap);
                t.twin.list = to_list;
                return "relinked";
            });

            return text(`Moved from "${source.name}" to "${to_list}": ${moved.text}${twinNote}`);
        },
    },
    {
        name: "merge_list",
        description: `Move every item and list note from one do-it list into another, e.g. folding an old feature or worktree list into its repo list. Moved items take fresh ranks after the target's highest, their (dep on #N) refs follow, owed twins and tmux window links follow to the target, and worktree/feature are stamped on moved items that have none. The source list is left empty, not deleted: delete_list it once the user confirms. Never from or to "${OWED_LIST}".`,
        schema: {
            from: z.string().describe("List to empty"),
            to: listNameSchema.describe("List to merge into; created when missing"),
            worktree: z.string().optional().describe("Stamp this worktree on moved items that have none"),
            feature: z.string().optional().describe("Stamp this feature on moved items that have none"),
        },
        async handler(ctx, { from, to, worktree, feature }) {
            if (from === to) throw new Error("from and to are the same list.");
            if (from === OWED_LIST || to === OWED_LIST) {
                throw new Error(`"${OWED_LIST}" holds the owed twins; merge project lists only.`);
            }
            const source = openList(ctx, from, null);
            const now = ctx.clock.now();
            const target = ctx.store.getList(to) || { todos: [], _metadata: { created_at: now, updated_at: now } };
            target.todos = target.todos || [];
            const moved = source.data.todos || [];
            const notes = source.data.notes || [];

            let next = nextRank(target.todos);
            const rankMap = new Map();
            const ranks = new Set(moved.map(t => parseTodoText(t.text).rank).filter(n => n !== null));
            for (const rank of [...ranks].sort((a, b) => a - b)) rankMap.set(rank, next++);

            const orderBase = getMaxOrder(target.todos);
            const seqBase = Math.max(0, ...target.todos.filter(isSequenced).map(t => t.sequence));
            const active = new Set(target.todos.filter(t => t.in_progress && !t.done).map(t => t.worktree || ""));
            for (const t of moved) {
                t.text = renumberText(t.text, rankMap).text;
                t.order_index = orderBase + (t.order_index || 0);
                if (typeof t.sequence === "number") t.sequence += seqBase;
                applyScope(t, { worktree, feature }, { keep: true });
                if (t.in_progress && !t.done) {
                    const slot = t.worktree || "";
                    if (active.has(slot)) t.in_progress = false;
                    else active.add(slot);
                }
            }
            // a twin pair inside the two lists is rewritten here, before syncTwin walks the other lists
            for (const t of [...moved, ...target.todos]) {
                if (t.twin && t.twin.list === from) {
                    relabelTwin(t, from, to, rankMap);
                    t.twin.list = to;
                }
            }
            target.todos.push(...moved);
            if (notes.length) target.notes = [...(target.notes || []), ...notes];

            // target first: a crash between the writes duplicates items instead of losing them
            save(ctx, to, target);
            source.data.todos = [];
            source.data.notes = [];
            save(ctx, from, source.data);

            let relinked = 0;
            for (const t of moved) {
                if (!t.twin || t.twin.list === to) continue;
                syncTwin(ctx, t, (_, twin) => {
                    relabelTwin(twin, twin.twin.list, to, rankMap);
                    twin.twin.list = to;
                    relinked++;
                    return "relinked";
                });
            }
            ctx.view.updateSession(session => {
                for (const [sess, list] of Object.entries(session.sessions || {})) {
                    if (list === from) session.sessions[sess] = to;
                }
            });
            ctx.view.retagLiveWindows(from, to);

            const pending = moved.filter(t => !t.done).length;
            const span = rankMap.size ? `; ranks #${[...rankMap.values()][0]}-#${next - 1}` : "";
            return text(`Merged ${moved.length} item(s) (${pending} pending) and ${notes.length} note(s) from "${from}" into "${to}"${span}; ${relinked} twin(s) relinked. "${from}" is empty; delete_list it once the user confirms.`);
        },
    },

    // --- LIST MANAGEMENT ---
    {
        name: "list_lists",
        description: "Show all available do-it todo lists (from ~/.local/share/nvim/doit/lists/), which one is active, which tmux windows link each, and whose each is ([mine] or [claude]). Every list stays usable from here whatever its source.",
        schema: {
            source: z.enum(SOURCE_FILTERS).optional().describe("Only lists of this source. Omit for all; the user's view filter does not apply here."),
        },
        async handler(ctx, { source }) {
            const linksByList = {};
            for (const [win, list] of Object.entries(ctx.view.readSession().sessions || {})) {
                (linksByList[list] = linksByList[list] || []).push(win);
            }

            const lines = ctx.store.listNames().flatMap(name => {
                const data = ctx.store.getList(name);
                const mine = isMineList(name, data);
                if (source === "mine" && !mine) return [];
                if (source === "claude" && mine) return [];
                const total = (data.todos || []).length;
                const pending = (data.todos || []).filter(t => !t.done).length;
                const linked = linksByList[name] ? ` (linked: ${linksByList[name].join(", ")})` : "";
                const marker = name === ctx.activeList ? ` <-- active${ctx.activeListNote}` : "";
                return [`${name} [${mine ? "mine" : "claude"}]: ${pending} pending / ${total} total${linked}${marker}`];
            });

            return text(lines.join("\n") || `No ${source} lists.`);
        },
    },
    {
        name: "set_list_source",
        description: "Mark a list as the user's ('user', shown as mine) or Claude's ('mcp'). Only changes which of the user's views (mine / claude / all) show it; any session can still use the list. 'daily' is always the user's. Call only when the user asks.",
        schema: {
            name: z.string().describe("List name"),
            source: z.enum(["user", "mcp"]).describe("'user' = the user's list, 'mcp' = Claude's"),
        },
        async handler(ctx, { name, source }) {
            const { data } = openList(ctx, name, null);
            if (name === "daily" && source !== "user") throw new Error(`"daily" is always the user's list.`);
            data._metadata = { ...(data._metadata || {}), source };
            save(ctx, name, data);
            return text(`List "${name}" is now ${source === "user" ? "mine" : "claude"}`);
        },
    },
    {
        name: "set_source_filter",
        description: "Set the user's list view filter shared by the tmux board, tmux pickers, and nvim: 'mine', 'claude', or 'all'. Changes only what those views show; never what any tool here can read or write. Call only when the user asks.",
        schema: {
            filter: z.enum(SOURCE_FILTERS).describe("Which lists the user's views show"),
        },
        async handler(ctx, { filter }) {
            ctx.view.updateSession(session => {
                session.source_filter = filter;
            });
            return text(`List views now show ${filter === "all" ? "all lists" : `${filter} lists`}`);
        },
    },
    {
        name: "switch_list",
        description: "Switch the active do-it list. Inside tmux the default links the current tmux window to the list AND updates the global pointer; scope narrows the write.",
        schema: {
            list: z.string().describe("List name to switch to"),
            scope: z.enum(["window", "session", "global"]).optional().describe("'window': only link the current tmux window (needs tmux); 'session' is its older name. 'global': only set the global pointer, touch no window link. Omit for the default (both inside tmux, global outside)."),
        },
        async handler(ctx, { list, scope }) {
            if (scope === "session") scope = "window";
            if (!ctx.store.getList(list)) throw new Error(`List "${list}" not found. Use list_lists to see available lists.`);

            const win = ctx.view.getTmuxWindow();
            if (scope === "window" && !win) {
                throw new Error("Not inside tmux — there is no window to link. Use scope 'global' or omit scope.");
            }

            const linkIt = scope !== "global" && win;
            const setGlobal = scope !== "window";
            ctx.view.updateSession(session => {
                if (linkIt) {
                    session.sessions = session.sessions || {};
                    session.sessions[win.key] = list;
                }
                if (setGlobal) session.active_list = list;
            });
            if (linkIt) ctx.view.setWindowLink(win, list);

            const effects = [];
            if (linkIt) effects.push(`linked tmux window "${win.key}"`);
            if (setGlobal) effects.push("set the global pointer");
            return text(`Switched active list to "${list}" (${effects.join(" and ")})`);
        },
    },
    {
        name: "create_list",
        description: "Create a new empty do-it todo list.",
        schema: {
            name: listNameSchema.describe("List name (used as filename, no spaces — use hyphens, max 24 chars)"),
        },
        async handler(ctx, { name }) {
            if (ctx.store.getList(name)) throw new Error(`List "${name}" already exists.`);
            const now = ctx.clock.now();
            ctx.store.putList(name, { todos: [], _metadata: { created_at: now, updated_at: now } });
            return text(`Created list "${name}" at ${ctx.store.pathOf(name)}`);
        },
    },
    {
        name: "rename_list",
        description: "Rename a do-it todo list. Cannot rename the active list (switch away first) or \"daily\".",
        schema: {
            old_name: z.string().describe("Current list name"),
            new_name: listNameSchema.describe("New list name (no spaces — use hyphens, max 24 chars)"),
        },
        async handler(ctx, { old_name, new_name }) {
            if (!ctx.store.getList(old_name)) throw new Error(`List "${old_name}" not found.`);
            if (old_name === OWED_LIST) throw new Error(`"${OWED_LIST}" is permanent and cannot be renamed.`);
            if (ctx.store.getList(new_name)) throw new Error(`List "${new_name}" already exists.`);

            ctx.store.renameList(old_name, new_name);
            // a twin pair can sit inside this one list, and syncTwin would look for it under the old name
            const renamed = ctx.store.getList(new_name);
            if ((renamed.todos || []).some(t => t.twin && t.twin.list === old_name)) {
                for (const t of renamed.todos) {
                    if (t.twin && t.twin.list === old_name) {
                        relabelTwin(t, old_name, new_name);
                        t.twin.list = new_name;
                    }
                }
                save(ctx, new_name, renamed);
            }
            for (const t of renamed.todos || []) {
                syncTwin(ctx, t, (_, twin) => {
                    relabelTwin(twin, twin.twin.list, new_name);
                    twin.twin.list = new_name;
                    return "relinked";
                });
            }

            ctx.view.updateSession(session => {
                for (const [sess, list] of Object.entries(session.sessions || {})) {
                    if (list === old_name) session.sessions[sess] = new_name;
                }
            });
            ctx.view.retagLiveWindows(old_name, new_name);

            return text(`Renamed list "${old_name}" to "${new_name}"`);
        },
    },
    {
        name: "delete_list",
        description: "Delete an entire do-it todo list. Cannot delete the active list or \"daily\". The file moves to deleted/ under the data dir; each owed item's twin on another list stays, unlinked, with the deleted copy's notes.",
        schema: {
            name: z.string().describe("List name to delete"),
        },
        async handler(ctx, { name }) {
            const data = ctx.store.getList(name);
            if (!data) throw new Error(`List "${name}" not found.`);
            if (name === OWED_LIST) throw new Error(`"${OWED_LIST}" is permanent and cannot be deleted.`);

            const count = (data.todos || []).length;
            const twinNotes = (data.todos || []).map(t => detachTwin(ctx, t, name)).join("");
            const archived = ctx.store.archiveList(name, ctx.clock.now());

            ctx.view.updateSession(session => {
                for (const [sess, list] of Object.entries(session.sessions || {})) {
                    if (list === name) delete session.sessions[sess];
                }
            });
            ctx.view.retagLiveWindows(name, null);

            return text(`Deleted list "${name}" (had ${count} items), archived to ${archived}${twinNotes}`);
        },
    },
];

export const toolByName = name => TOOLS.find(t => t.name === name);

// One entry point for every surface: validates against the full schema (internal args included),
// runs the handler, and reports what the handler resolved so the caller can pin the op.
export async function runTool(ctx, name, args = {}) {
    const tool = toolByName(name);
    if (!tool) throw new Error(`Unknown tool "${name}"`);
    const parsed = z.object({ ...tool.schema, ...(tool.internalArgs || {}) }).parse(args);
    const result = await tool.handler(ctx, parsed);
    if (Object.keys(ctx.resolved).length) result._meta = { ...(result._meta || {}), resolved: ctx.resolved };
    return result;
}
