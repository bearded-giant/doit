#!/bin/bash
# fzf bind helper: reorder a todo within its section and keep the cursor on it.
# Called from todo-interactive.sh via a `transform` bind for K/J reorder.
# The swap rules (sequence vs order_index, siblings only, same Mine / Claude
# block) live in core's reorder_todo; this prints the fzf actions afterwards:
# reload(format)+pos(new line of todo).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/get-active-list.sh"
source "$SCRIPT_DIR/lib-call.sh"
unset DOIT_ACTIVE_LIST
ACTIVE_LIST_NAME="$(get_active_list_name)"

DIRECTION="$1"
shift
LINE="$*"
TODO_ID=$(echo "$LINE" | grep -oE '\[[^]]+\]$' | tr -d '[]')

# only real todos reorder; notes/headers just keep the cursor put
if [[ -n "$TODO_ID" && "$TODO_ID" != note_* ]]; then
    case "$DIRECTION" in
        up|down)
            doit_call reorder_todo "$(jq -cn --arg id "$TODO_ID" --arg list "$ACTIVE_LIST_NAME" --arg d "$DIRECTION" \
                '{id: $id, list: $list, direction: $d}')" "$ACTIVE_LIST_NAME" >/dev/null 2>&1
            ;;
    esac
fi

# locate the (possibly moved) row in the freshly formatted list so fzf can
# re-anchor the cursor on it. reload-sync (not reload) so pos() runs AFTER the
# list reloads -- async reload resets the cursor to the top, dropping pos().
[[ -z "$TODO_ID" ]] && exit 0
N=$("$SCRIPT_DIR/todo-interactive.sh" --format \
    | sed 's/\x1b\[[0-9;]*m//g' \
    | grep -nF "[$TODO_ID]" | head -1 | cut -d: -f1)
[[ -z "$N" ]] && exit 0
echo "reload-sync($SCRIPT_DIR/todo-interactive.sh --format)+pos($N)"
