#!/bin/bash

# Toggle the completion status of the current in-progress todo

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/get-active-list.sh"
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

# Get the ID of the current in-progress todo
TODO_ID=$(jq -r '.todos[] | select(.in_progress == true) | .id' "$TODO_LIST_PATH" 2>/dev/null | head -1)

if [[ -z "$TODO_ID" ]]; then
    # No in-progress todo, get the first undone todo
    TODO_ID=$(jq -r '.todos | sort_by(.order_index) | .[] | select(.done == false) | .id' "$TODO_LIST_PATH" 2>/dev/null | head -1)

    if [[ -z "$TODO_ID" ]]; then
        tmux display-message "No active todos to toggle"
        exit 0
    fi
fi

read -r WAS_DONE TODO_TEXT < <(jq -r --arg id "$TODO_ID" '.todos[] | select(.id == $id) | "\(.done) \(.text | split("\n")[0])"' "$TODO_LIST_PATH")
ARGS=$(jq -cn --arg id "$TODO_ID" --arg list "$ACTIVE_LIST_NAME" '{id: $id, list: $list}')

if [[ "$WAS_DONE" == true ]]; then
    OUT=$(doit_call revert_todo "$ARGS" "$ACTIVE_LIST_NAME" 2>&1) || { tmux display-message "Error: $OUT"; exit 1; }
    TWIN_MSG=$(doit_twin_msg "$OUT")
    tmux display-message "↻ Reopened: $TODO_TEXT${TWIN_MSG:+ · $TWIN_MSG}"
else
    OUT=$(doit_call complete_todo "$ARGS" "$ACTIVE_LIST_NAME" 2>&1) || { tmux display-message "Error: $OUT"; exit 1; }
    TWIN_MSG=$(doit_twin_msg "$OUT")
    tmux display-message "✓ Completed: $TODO_TEXT${TWIN_MSG:+ · $TWIN_MSG}"
fi
