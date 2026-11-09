-- One tool call per change, then the active list is reloaded from the replica so memory matches disk.
local client = require("doit.client")

local M = {}
local state

function M.setup(parent_state)
	state = parent_state
	return M
end

local function lists_dir()
	return vim.fn.fnamemodify(state.get_list_path(state.todo_lists.active), ":h")
end

function M.call(tool, args, opts)
	opts = opts or {}
	local list = state.todo_lists.active
	local ok, text = client.call(tool, args or {}, { list = list, lists_dir = lists_dir() })
	if not ok then
		if not opts.quiet then
			vim.notify("doit: " .. tostring(text), vim.log.levels.ERROR)
		end
		return false, text
	end
	if opts.reload ~= false then
		state.load_list(state.todo_lists.active)
	end
	return true, text
end

function M.id_from(text)
	return (text or ""):match("%[id:([^%]]+)%]")
end

function M.by_id(id)
	for _, todo in ipairs(state.todos or {}) do
		if todo.id == id then
			return todo
		end
	end
end

return M
