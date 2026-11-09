#!/bin/bash

# tests for lib-footer.sh: strip must preserve internal blank lines.
# regression guard for the macOS-awk paragraph-mode bug that collapsed notes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test_harness.sh"
source "$SCRIPT_DIR/../../tmux/scripts/lib-footer.sh"

describe "strip_footer: blank line preservation"

it "keeps internal blank lines on plain body (no footer)"
BODY=$'First para\n\nSecond para\n\n\nThird after two blanks'
assert_eq "$BODY" "$(strip_footer "$BODY")"

it "strips a 'last modified' footer, keeps body blanks"
STAMPED=$'Body\n\nmore\n\n\n----------\nlast modified: 2026-07-14: 16:00'
assert_eq $'Body\n\nmore' "$(strip_footer "$STAMPED")"

it "strips legacy 'last updated' footer"
OLD=$'Body\n\nmore\n\n\n----------\nlast updated: 2026-01-01: 09:00'
assert_eq $'Body\n\nmore' "$(strip_footer "$OLD")"

report
