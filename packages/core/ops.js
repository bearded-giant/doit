import { OWED_LIST } from "./tools.js";

// Rewrites an op's args with what the handler resolved at local apply (ids for queries and
// rank refs, the list an omitted name landed on, the ranks it assigned), so a replay hits the
// same items whatever else changed on the way.
export function pinArgs(args, resolved = {}) {
    const out = { ...args };
    if (resolved.id !== undefined) {
        out.id = resolved.id;
        delete out.query;
    }
    if (resolved.list !== undefined) out.list = resolved.list;
    if (resolved.from_list !== undefined) out.from_list = resolved.from_list;
    if (resolved.parent !== undefined) out.parent = resolved.parent;
    if (resolved.order !== undefined) out.order = resolved.order;
    if (resolved.todo_ids !== undefined) out.todo_ids = resolved.todo_ids;
    const pin = {};
    for (const k of ["rank", "owed_rank", "rank_base"]) if (resolved[k] != null) pin[k] = resolved[k];
    if (Object.keys(pin).length) out._pin = pin;
    return out;
}

const pinList = op => (op.tool === "move_todo" ? op.args.to_list : op.tool === "merge_list" ? op.args.to : op.args.list);

// Applies a server rank_remap ({list: {old: new}}) to the ops still queued: deps and pinned
// ranks follow in one simultaneous substitution. A queued pin that now collides with a rank the
// server handed out moves up to the next free one in the same pass, so a later dep on it follows too.
export function remapOps(ops, rankRemap) {
    const maps = {};
    for (const [list, m] of Object.entries(rankRemap || {})) {
        maps[list] = Object.fromEntries(Object.entries(m).map(([k, v]) => [Number(k), Number(v)]));
    }
    for (const [list, m] of Object.entries(maps)) {
        const assigned = new Set(Object.values(m));
        let top = Math.max(...Object.keys(m).map(Number), ...Object.values(m));
        for (const op of ops) {
            const pin = op.args?._pin;
            if (!pin || pin.rank == null || pinList(op) !== list || m[pin.rank] !== undefined) continue;
            top = Math.max(top, pin.rank);
            if (assigned.has(pin.rank)) {
                top++;
                m[pin.rank] = top;
                assigned.add(top);
            }
        }
    }
    const map = (list, ref) => {
        const m = maps[list];
        if (!m) return ref;
        const s = String(ref).replace(/^#/, "");
        const num = parseInt(s, 10);
        if (Number.isNaN(num) || m[num] === undefined) return ref;
        return typeof ref === "number" ? m[num] : `${m[num]}${s.slice(String(num).length)}`;
    };
    return ops.map(op => {
        const args = { ...op.args };
        if (Array.isArray(args.deps) && args.list) args.deps = args.deps.map(d => map(args.list, d));
        if (args._pin) {
            const pin = { ...args._pin };
            if (pin.rank != null) pin.rank = map(pinList(op), pin.rank);
            if (pin.owed_rank != null) pin.owed_rank = map(OWED_LIST, pin.owed_rank);
            if (pin.rank_base != null) pin.rank_base = map(args.to, pin.rank_base);
            args._pin = pin;
        }
        return { ...op, args };
    });
}
