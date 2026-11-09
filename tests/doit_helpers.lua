-- Shared spec plumbing: a fresh data dir per test, so specs that write through doitd never
-- touch the container's real lists or each other's.
local M = {}

local orig_stdpath

function M.fresh_data()
	local tmpdir = vim.fn.tempname()
	vim.fn.mkdir(tmpdir .. "/doit/lists", "p")
	orig_stdpath = orig_stdpath or vim.fn.stdpath
	local orig = orig_stdpath
	vim.fn.stdpath = function(what)
		if what == "data" then
			return tmpdir
		end
		return orig(what)
	end
	M.tmpdir = tmpdir
	return tmpdir
end

function M.restore()
	if orig_stdpath then
		vim.fn.stdpath = orig_stdpath
	end
	if M.tmpdir then
		vim.fn.delete(M.tmpdir, "rf")
		M.tmpdir = nil
	end
end

-- a fresh todos module state on a fresh data dir
function M.fresh_state()
	M.fresh_data()
	for key in pairs(package.loaded) do
		if key == "doit" or key:match("^doit%.") then
			package.loaded[key] = nil
		end
	end
	require("doit").setup({ modules = { todos = { enabled = true } } })
	return require("doit.core").get_module("todos").state
end

return M
