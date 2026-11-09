#!/bin/bash

# Every data write goes through doitd, the single writer of the lists; reads stay direct jq reads.
# doit_call TOOL [JSON] [LIST] prints the tool's text; a tool error prints its message on stderr
# and returns 1. LIST is the caller's active list (default: get_active_list_name), where an op
# that names no list lands. Needs get-active-list.sh sourced first.

SCRIPT_DIR_CALL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

doit_sock() { printf '%s/doitd.sock' "${DOIT_STATE_DIR:-$HOME/.local/state/doit}"; }
doitd_up() { [[ -S "$(doit_sock)" ]]; }

doit_call() {
    local tool="$1" args="$2" list="${3:-}" body res
    local DOIT_SOCK; DOIT_SOCK=$(doit_sock)
    [[ -n "$args" ]] || args='{}'
    [[ -n "$list" ]] || list=$(get_active_list_name)
    body=$(jq -cn --arg tool "$tool" --argjson args "$args" --arg list "$list" \
        '{tool: $tool, args: $args, source: "user", active_list: $list}')
    if res=$(curl -s --max-time 5 --unix-socket "$DOIT_SOCK" -X POST http://doitd/call \
            -H 'content-type: application/json' --data-binary "$body" 2>/dev/null) && [[ -n "$res" ]]; then
        if [[ "$(jq -r '.ok' <<< "$res")" == true ]]; then
            jq -r '.text' <<< "$res"
            return 0
        fi
        jq -r '.error // "doitd error"' <<< "$res" >&2
        return 1
    fi
    # no daemon: the CLI applies the op in-process under the daemon lock, or refuses when a live daemon holds it
    if command -v doit &>/dev/null; then
        doit call "$tool" "$args" -l "$list"
    elif command -v node &>/dev/null; then
        node "$SCRIPT_DIR_CALL/../../packages/cli/cli.js" call "$tool" "$args" -l "$list"
    else
        echo "doitd is not running at $DOIT_SOCK and neither doit nor node is on PATH" >&2
        return 1
    fi
}

# the id of the item a tool just wrote, from its "[id:...]" token
doit_result_id() { sed -n 's/.*\[id:\([^]]*\)\].*/\1/p' <<< "$1" | head -1; }

# 'twin in "daily": completed' from a tool's 'Twin in "daily" completed: ...' line, empty when none
doit_twin_msg() { sed -n 's/^Twin in \("[^"]*"\) \([a-z]*\).*/twin in \1: \2/p' <<< "$1" | head -1; }

# " [offline queued 3 conflicts 1]" from doitd's state file, empty in local mode or when all is well
sync_badge() {
    local f="${DOIT_STATE_DIR:-$HOME/.local/state/doit}/sync/state.json"
    [[ -f "$f" ]] || return 0
    jq -r 'if .mode != "sync" then "" else
        [(if .online then empty else "offline" end),
         (if (.queue // 0) > 0 then "queued \(.queue)" else empty end),
         (if (.conflicts // 0) > 0 then "conflicts \(.conflicts)" else empty end)]
        | join(" ") | if . == "" then "" else " [" + . + "]" end end' "$f" 2>/dev/null
}
