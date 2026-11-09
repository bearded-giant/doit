import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

// tmux format output separator; window names can hold tabs and spaces
const TMUX_SEP = "\x1f";

function tmux(args) {
    return execFileSync("tmux", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\n$/, "");
}

// Machine-local view state: session.json and tmux window options. Never synced.
export function localView(dataDir) {
    const sessionFile = path.join(dataDir, "session.json");
    const readSession = () => {
        try {
            return JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
        } catch {
            return {};
        }
    };
    return {
        // The tmux window this process runs in, or null outside tmux: its id and its
        // key "<session>:<window name>", which a link persists under in session.json.
        // Resolved per call, not per process: the user moves panes between windows
        // and the server lives long.
        getTmuxWindow() {
            if (!process.env.TMUX) return null;
            try {
                // popups have no TMUX_PANE; $TMUX ends in the session id, which beats the most-recent-session guess
                const sid = process.env.TMUX.split(",").pop();
                const target = process.env.TMUX_PANE ? ["-t", process.env.TMUX_PANE]
                    : /^\d+$/.test(sid) ? ["-t", `$${sid}`] : [];
                const [id, ...rest] = tmux(["display-message", "-p", ...target, `#{window_id}${TMUX_SEP}#S:#W`]).split(TMUX_SEP);
                const key = rest.join(TMUX_SEP);
                return id && key ? { id, key } : null;
            } catch {
                return null;
            }
        },
        // The live link is the window's @doit-window-list option, which follows the
        // window through renames and moves; the key stamp lets tmux/scripts/todo-relink.sh
        // move the persisted copy after a rename.
        setWindowLink(win, list) {
            tmux(["set-option", "-wq", "-t", win.id, "@doit-window-list", list]);
            tmux(["set-option", "-wq", "-t", win.id, "@doit-window-key", win.key]);
        },
        // Live windows linked to list `from` now link `to`; a null `to` unlinks them.
        retagLiveWindows(from, to) {
            if (!process.env.TMUX) return;
            try {
                for (const line of tmux(["list-windows", "-a", "-F", `#{window_id}${TMUX_SEP}#{@doit-window-list}`]).split("\n")) {
                    const [id, list] = line.split(TMUX_SEP);
                    if (!id || list !== from) continue;
                    if (to) {
                        tmux(["set-option", "-wq", "-t", id, "@doit-window-list", to]);
                    } else {
                        tmux(["set-option", "-wqu", "-t", id, "@doit-window-list"]);
                        tmux(["set-option", "-wqu", "-t", id, "@doit-window-key"]);
                    }
                }
            } catch {
                // tmux gone: the persisted links in session.json were still updated
            }
        },
        readSession,
        updateSession(mutate) {
            const session = readSession();
            mutate(session);
            session.timestamp = Math.floor(Date.now() / 1000);
            fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
            fs.writeFileSync(`${sessionFile}.tmp`, JSON.stringify(session, null, 2));
            fs.renameSync(`${sessionFile}.tmp`, sessionFile);
        },
    };
}

// rename, delete and merge change what windows and session.json point at; the process in the
// user's tmux runs this once the data change is applied (in-process handlers run it themselves)
export function applyViewEffect(view, tool, args) {
    const relink = (from, to) => {
        view.updateSession(session => {
            for (const [key, list] of Object.entries(session.sessions || {})) {
                if (list !== from) continue;
                if (to) session.sessions[key] = to;
                else delete session.sessions[key];
            }
        });
        view.retagLiveWindows(from, to);
    };
    if (tool === "rename_list") relink(args.old_name, args.new_name);
    else if (tool === "delete_list") relink(args.name, null);
    else if (tool === "merge_list") relink(args.from, args.to);
}

export const noView = {
    getTmuxWindow: () => null,
    setWindowLink() {},
    retagLiveWindows() {},
    readSession: () => ({}),
    updateSession() {},
};
