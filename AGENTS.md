# Working in this repo

Do-It.nvim is one repo with several surfaces over the same lists: the Neovim plugin (`lua/`), the tmux add-on (`tmux/`), and the Node packages under `packages/` (npm workspaces). `packages/core` holds the tool handlers every surface writes through, `packages/daemon` is `doitd` (the one writer per machine, plus sync), `packages/cli` is the `doit` command and the MCP bridge, `packages/server` is the hosted authority (Vercel functions over Postgres, Slack routes), and `packages/vault-export` mirrors lists into an Obsidian vault.

## Build and test

| Surface | Command |
|---------|---------|
| Node packages | `npm install && npm test` at the repo root; one package: `npm test -w packages/core` |
| Server and sync | `npm test -w packages/server -w packages/daemon` with a Postgres at `postgres://postgres:doit@127.0.0.1:54329/doit` (`docker run -d --name doit-pg -p 54329:5432 -e POSTGRES_PASSWORD=doit -e POSTGRES_DB=doit postgres:16-alpine`); `TEST_DATABASE_URL` points elsewhere; the database-backed files skip without one |
| Neovim plugin | `docker/run-tests.sh` (`--pattern <substr>` narrows to spec files whose path contains it). It starts a `doitd` inside the container with `DOIT_ANY_DATA_DIR=1`; a headless run outside Docker needs one started the same way: `DOIT_STATE_DIR=/tmp/doit-test-state DOIT_ANY_DATA_DIR=1 node packages/daemon/doitd.js &` with the same `DOIT_STATE_DIR` exported to nvim |
| One nvim spec | `nvim --headless -c "lua require('plenary.test_harness').test_directory('tests/modules/todos/sorting_spec.lua')" -c "qa!"` |
| tmux add-on | `tests/tmux/run-tests.sh [test_x.sh]` (starts its own `doitd`) |
| Help docs | `make check-docs` (duplicate tags and dangling references) |

Every change runs the suite of the surface it touches before it lands. Writes to list files go through the tools in `packages/core/tools.js`; no surface edits the JSON directly, and `tests/tmux/test_no_direct_writes.sh` guards the tmux scripts.

## Versioning

The root `VERSION` file is the single source of truth (bare `2.0.3`, no `v`). Neovim, tmux, and the MCP bridge read it at runtime; the `package.json` files carry the same number as npm metadata. A release bumps `VERSION`, runs `npm version <v> --workspaces --include-workspace-root --no-git-tag-version`, and tags the commit with the bare version, so `VERSION`, every `package.json`, and the latest tag agree. Module-level version strings in Lua are a separate concept and stay as they are.

## Style

Lua modules use the local `M = {}` pattern, 4-space indentation, lines under 120 characters, `snake_case` names, and `vim.notify()` for errors. Node code is ESM, 4-space indentation, no build step. Follow the patterns already in the file you are editing, including how windows, buffers, and state are handled in the plugin.

## Help files

Tags live once across `doc/*.txt` (`*tag*` defines, `|tag|` refers), named `doit-{module}-{section}`. `make check-docs` must pass before a docs change lands.
