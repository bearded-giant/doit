#!/bin/bash

# The machine-managed "last modified" footer on todo descriptions is written by
# doitd; the views strip it so editing shows the body only.

# Drop the footer so editing shows body only and re-saving refreshes rather
# than stacks. Matches either verb so older "last updated" stamps are stripped.
# Pure bash: macOS awk reads RS="\0" as paragraph mode and eats every blank line.
strip_footer() {
    local s="$1" nl=$'\n'
    local re="${nl}*----------${nl}last (updated|modified):[^${nl}]*${nl}*\$"
    [[ "$s" =~ $re ]] && s="${s%"${BASH_REMATCH[0]}"}"
    printf '%s' "$s"
}
