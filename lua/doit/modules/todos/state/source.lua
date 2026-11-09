-- must match tmux/scripts/lib-source.sh and packages/core/server.js: all three surfaces share the store
local session = require("doit.modules.todos.state.session")
local PERMANENT_LIST = require("doit.modules.todos.state.storage").PERMANENT_LIST

local M = {}

local NEXT_FILTER = { all = "mine", mine = "claude", claude = "all" }

local state

function M.setup(parent_state)
    state = parent_state
    return M
end

function M.is_mine(name, metadata)
    return name == PERMANENT_LIST or (type(metadata) == "table" and metadata.source == "user")
end

function M.get_filter()
    local filter = session.read().source_filter
    return NEXT_FILTER[filter] and filter or "all"
end

local function set_filter(filter)
    session.update(function(data)
        data.source_filter = filter
    end)
    return filter
end

function M.cycle_filter()
    return set_filter(NEXT_FILTER[M.get_filter()])
end

-- mine <-> claude, all lands on mine
function M.toggle_view()
    return set_filter(M.get_filter() == "mine" and "claude" or "mine")
end

function M.in_filter(name, metadata, filter)
    if filter == "mine" then
        return M.is_mine(name, metadata)
    elseif filter == "claude" then
        return not M.is_mine(name, metadata)
    end
    return true
end

function M.filter_lists(lists, filter, keep)
    return vim.tbl_filter(function(list)
        return list.name == keep or M.in_filter(list.name, list.metadata, filter)
    end, lists or {})
end

function M.label(source)
    return source == "user" and "mine" or "claude"
end

function M.toggle_list_source(name)
    if name == PERMANENT_LIST then
        return nil, PERMANENT_LIST .. " is permanent; it always counts as yours"
    end
    local path = state.get_list_path(name)
    local file = io.open(path, "r")
    if not file then
        return nil, "List '" .. name .. "' not found"
    end
    local content = file:read("*all")
    file:close()
    local ok, data = pcall(vim.fn.json_decode, content)
    if not ok or type(data) ~= "table" then
        return nil, "Failed to parse list '" .. name .. "'"
    end

    local next_source = M.is_mine(name, data._metadata) and "mcp" or "user"
    local sent, err = require("doit.client").call("set_list_source", { name = name, source = next_source },
        { list = state.todo_lists.active, lists_dir = vim.fn.fnamemodify(path, ":h") })
    if not sent then
        return nil, "Failed to flip list '" .. name .. "': " .. tostring(err)
    end
    if state.todo_lists and state.todo_lists.active == name then
        state.load_list(name)
    end
    return next_source
end

return M
