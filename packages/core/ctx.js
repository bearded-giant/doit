import { createHash } from "crypto";
import { noView } from "./view.js";

function parts(ts, tz) {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    return Object.fromEntries(fmt.formatToParts(new Date(ts)).map(p => [p.type, p.value]));
}

export const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// One ctx per op. Handlers take time, ids, the writer's identity and the active list from
// here and nothing from the environment, so local apply and server replay produce the same bytes.
export function createCtx({
    store, view = noView, ts = Date.now(), tz = localTz(), opId = null, source = "mcp", host = "",
    activeList = "daily", activeListNote = "",
}) {
    const seconds = Math.floor(ts / 1000);
    const seed = opId || `${ts}:${Math.random()}`;
    let n = 0;
    return {
        store, view, source, host, tz, ts, opId, activeList, activeListNote,
        resolved: {},
        clock: {
            now: () => seconds,
            stamp() {
                const p = parts(ts, tz);
                return `${p.year}-${p.month}-${p.day}: ${p.hour}:${p.minute}`;
            },
            date() {
                const p = parts(ts, tz);
                return `${p.year}-${p.month}-${p.day}`;
            },
        },
        // n-th id of an op: <unix>_<7 digits of sha256(op_id:n)>, the format every surface parses
        newId() {
            n++;
            const hash = createHash("sha256").update(`${seed}:${n}`).digest("hex");
            return `${seconds}_${String(BigInt(`0x${hash.slice(0, 16)}`) % 10000000n).padStart(7, "0")}`;
        },
    };
}
