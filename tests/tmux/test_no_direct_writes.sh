#!/bin/bash

# doitd is the only writer of the list files: no tmux script may rewrite a list
# JSON itself or keep .bak copies beside it. session.json (view state) is exempt.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test_harness.sh"

SCRIPTS="$SCRIPT_DIR/../../tmux/scripts"

describe "tmux scripts write lists only through doitd"

it "no jq read-modify-write of a list file"
assert_eq "" "$(grep -nE 'TODO_LIST_PATH}?\.tmp|TARGET_PATH}?\.tmp|\$tpath\.tmp|\$file\.tmp|\$list_file\.tmp|> "\$LISTS_DIR' "$SCRIPTS"/*.sh)"

it "no .bak copies next to a list"
assert_eq "" "$(grep -n '\.bak' "$SCRIPTS"/*.sh)"

it "no heredoc or printf into a list file"
assert_eq "" "$(grep -nE '(cat|printf) .*> "\$LISTS_DIR/' "$SCRIPTS"/*.sh)"

it "the twin and quick-add scripts are gone"
assert_eq "no no" "$([[ -f "$SCRIPTS/lib-twin.sh" ]] && echo yes || echo no) $([[ -f "$SCRIPTS/todo-quick-add.sh" ]] && echo yes || echo no)"

report
