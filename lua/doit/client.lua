-- Every data change goes to doitd, the single writer of the lists; nvim keeps reading the replica files.
-- call(tool, args, opts) -> ok, text. opts.list is the active list an op without a list lands on;
-- opts.lists_dir names the replica so a daemon serving another data dir refuses instead of writing.
local M = {}

local function state_dir()
	return vim.env.DOIT_STATE_DIR or (vim.env.HOME .. "/.local/state/doit")
end

function M.socket()
	return state_dir() .. "/doitd.sock"
end

function M.data_dir(lists_dir)
	if vim.env.DOIT_DATA_DIR then
		return vim.env.DOIT_DATA_DIR
	end
	return vim.fn.fnamemodify(lists_dir or (vim.fn.stdpath("data") .. "/doit/lists"), ":h")
end

local function repo_root()
	return vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h:h")
end

-- an empty Lua table would encode as [], which the tools reject where an object is due
local function encode(value)
	if value == nil or (type(value) == "table" and next(value) == nil) then
		value = vim.empty_dict()
	end
	return vim.json.encode(value)
end

function M.call(tool, args, opts)
	opts = opts or {}
	local data_dir = M.data_dir(opts.lists_dir)
	if args == nil or (type(args) == "table" and next(args) == nil) then
		args = vim.empty_dict()
	end
	local body = encode({ tool = tool, args = args, source = "user", active_list = opts.list, data_dir = data_dir })
	local res = vim.system({
		"curl", "-s", "--max-time", "5", "--unix-socket", M.socket(), "-X", "POST", "http://doitd/call",
		"-H", "content-type: application/json", "--data-binary", body,
	}, { text = true }):wait(6000)
	if res.code == 0 and res.stdout and res.stdout ~= "" then
		local ok, parsed = pcall(vim.json.decode, res.stdout)
		if ok and type(parsed) == "table" then
			if parsed.ok then
				return true, parsed.text
			end
			return false, parsed.error or "doitd error"
		end
	end
	-- no daemon: the CLI applies the op in-process under the daemon lock
	local cmd = vim.fn.executable("doit") == 1 and { "doit" } or { "node", repo_root() .. "/packages/cli/cli.js" }
	vim.list_extend(cmd, { "call", tool, encode(args) })
	if opts.list then
		vim.list_extend(cmd, { "-l", opts.list })
	end
	res = vim.system(cmd, { text = true, env = { DOIT_DATA_DIR = data_dir } }):wait(15000)
	if res.code == 0 then
		return true, vim.trim(res.stdout or "")
	end
	local err = res.stderr and res.stderr ~= "" and res.stderr or res.stdout
	return false, vim.trim(err or "doit call failed")
end

-- "[offline queued 2]" from doitd's sync state; empty in local mode or when all is well
function M.sync_badge()
	local fh = io.open(state_dir() .. "/sync/state.json", "r")
	if not fh then
		return ""
	end
	local raw = fh:read("*a")
	fh:close()
	local ok, s = pcall(vim.json.decode, raw)
	if not ok or type(s) ~= "table" or s.mode ~= "sync" then
		return ""
	end
	local parts = {}
	if not s.online then
		parts[#parts + 1] = "offline"
	end
	if (s.queue or 0) > 0 then
		parts[#parts + 1] = "queued " .. s.queue
	end
	if (s.conflicts or 0) > 0 then
		parts[#parts + 1] = "conflicts " .. s.conflicts
	end
	return #parts > 0 and ("[" .. table.concat(parts, " ") .. "]") or ""
end

return M
