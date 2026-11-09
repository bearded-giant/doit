#!/bin/bash

# Mark the next undone todo as in-progress

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/get-active-list.sh"
source "$SCRIPT_DIR/lib-origin.sh"
source "$SCRIPT_DIR/lib-call.sh"

TODO_LIST_PATH="$(get_active_list_path)"
ACTIVE_LIST_NAME="$(get_active_list_name)"

if ! command -v jq &> /dev/null; then
    echo "Error: jq is required but not installed"
    exit 1
fi

if [[ ! -f "$TODO_LIST_PATH" ]]; then
    tmux display-message "Error: Todo list not found"
    exit 1
fi

# the first pending todo in view order
NEXT_TODO=$(jq -r "$ORIGIN_JQ"'
    .todos |
    map(select(.done == false and .in_progress != true)) |
    sort_by(origin_rank, (if (.sequence | type) == "number" then [0, .sequence] else [1, 0] end), (if .priorities == "critical" then 0 elif .priorities == "urgent" then 1 elif .priorities == "important" then 2 else 3 end), .order_index) |
    first |
    .id // empty
' "$TODO_LIST_PATH")

if [[ -z "$NEXT_TODO" ]]; then
    tmux display-message "No pending todos to start"
    exit 0
fi

# start_todo stops the item in the same worktree slot, like every other surface
OUT=$(doit_call start_todo "$(jq -cn --arg id "$NEXT_TODO" --arg list "$ACTIVE_LIST_NAME" '{id: $id, list: $list}')" "$ACTIVE_LIST_NAME" 2>&1) \
    || { tmux display-message "Error: $OUT"; exit 1; }

TODO_TEXT=$(jq -r --arg id "$NEXT_TODO" '.todos[] | select(.id == $id) | .text' "$TODO_LIST_PATH")
tmux display-message "▶ Started: $TODO_TEXT"
