-- Handles loading/saving from disk, plus importing/exporting.
local vim = vim

local due_dates = require("doit.modules.todos.state.due_dates")
local client = require("doit.client")
local client = require("doit.client")

-- the owed-items inbox; the MCP server and tmux refuse to delete or rename it too
local PERMANENT_LIST = "daily"

local storage = {
    -- Pre-define the functions to prevent nil value errors
    load_from_disk = function() end,
    save_to_disk = function() end,
    create_list = function() return true, "Not implemented" end,
    load_list = function() return true, "Not implemented" end,
    delete_list = function() return true, "Not implemented" end,
    rename_list = function() return true, "Not implemented" end,
    get_available_lists = function() return {} end,
    import_todos = function() return true, "Not implemented" end,
    export_todos = function() return true, "Not implemented" end,
    backup_all_lists = function() return true, "Not implemented" end,
    PERMANENT_LIST = PERMANENT_LIST,
}

-- Transient keys (`_score`, `_priority_weight`) are computed per-render and must never
-- reach disk; tmux and MCP round-trip unknown keys verbatim, so nvim owns the cleanup.
local function strip_transient(todo)
    local clean = {}
    for k, v in pairs(todo) do
        if type(k) ~= "string" or k:sub(1, 1) ~= "_" then
            clean[k] = v
        end
    end
    return clean
end

local function serializable_todos(todos)
    local out = {}
    for i, todo in ipairs(todos or {}) do
        out[i] = strip_transient(todo)
    end
    return out
end

local function is_transient(k)
    return type(k) == "string" and k:sub(1, 1) == "_"
end

local function index_by_id(items)
    local out = {}
    for _, item in ipairs(items or {}) do
        if item.id ~= nil then
            out[item.id] = item
        end
    end
    return out
end

-- Per field: what nvim changed since its last load or save keeps nvim's value; every
-- other field takes the disk value, so tmux and MCP edits to the same item survive.
local function merge_fields(base, ours, theirs)
    local merged = {}
    for k, v in pairs(theirs or {}) do
        merged[k] = v
    end
    for k, v in pairs(ours) do
        if not is_transient(k) and not vim.deep_equal(v, base and base[k]) then
            merged[k] = v
        end
    end
    for k in pairs(base or {}) do
        if ours[k] == nil then
            merged[k] = nil
        end
    end
    return merged
end

-- Live objects stay the same tables so callers holding a todo keep writing to state.
local function assign(target, fields)
    for k in pairs(target) do
        if fields[k] == nil and not is_transient(k) then
            target[k] = nil
        end
    end
    for k, v in pairs(fields) do
        target[k] = v
    end
end

local function merge_items(base, ours, theirs)
    local base_by, ours_by = index_by_id(base), index_by_id(ours)
    local out, seen = {}, {}
    for _, t in ipairs(theirs or {}) do
        local o = t.id ~= nil and ours_by[t.id] or nil
        if o then
            seen[t.id] = true
            assign(o, merge_fields(base_by[t.id], o, t))
            table.insert(out, o)
        elseif t.id == nil or base_by[t.id] == nil then
            table.insert(out, t)
        end
    end
    for _, o in ipairs(ours or {}) do
        local b = base_by[o.id]
        if not seen[o.id] and (b == nil or not vim.deep_equal(strip_transient(o), b)) then
            table.insert(out, o)
        end
    end
    return out
end
storage._merge_items = merge_items

local function disk_stamp(path)
    local stat = (vim.uv or vim.loop).fs_stat(path)
    if not stat then
        return nil
    end
    return string.format("%d.%d:%d", stat.mtime.sec, stat.mtime.nsec or 0, stat.size)
end

local function read_list_file(path)
    local file = io.open(path, "r")
    if not file then
        return nil
    end
    local content = file:read("*all")
    file:close()
    local ok, data = pcall(vim.fn.json_decode, content)
    if ok and type(data) == "table" then
        return data
    end
end

-- Mutates in place: used on load so pre-existing leaked keys are dropped from live state.
local function scrub_transient(todos)
    local scrubbed = false
    for _, todo in ipairs(todos or {}) do
        for k in pairs(todo) do
            if type(k) == "string" and k:sub(1, 1) == "_" then
                todo[k] = nil
                scrubbed = true
            end
        end
    end
    return scrubbed
end

function storage.setup(M)
    -- Get module configuration
    local config
    local success, core_module = pcall(require, "doit.core")
    if success and core_module and core_module.get_module_config then
        config = core_module.get_module_config("todos")
    else
        -- Fallback configuration if core is not available
        config = {
            save_path = vim.fn.stdpath("data") .. "/doit_todos.json",
            lists_dir = vim.fn.stdpath("data") .. "/doit/lists",
            default_list = "daily",
            priorities = {}
        }
    end

    -- get configured default list name (check nested lists config too)
    local default_list_name = config.default_list
        or (config.lists and config.lists.default_list)
        or "daily"

    -- Ensure lists directory exists
    if not config.lists_dir then
        -- Check if lists configuration exists
        if config.lists and config.lists.save_path then
            config.lists_dir = config.lists.save_path
        elseif config.storage and config.storage.save_path then
            -- Use storage.save_path as base for lists
            local base_path = config.storage.save_path
            if base_path:match("%.json$") then
                -- Remove filename if it's a json file path
                base_path = vim.fn.fnamemodify(base_path, ":h")
            end
            config.lists_dir = base_path .. "/lists"
        else
            config.lists_dir = vim.fn.stdpath("data") .. "/doit/lists"
        end
    end

    -- Create directory if it doesn't exist
    local mkdir_cmd = vim.fn.has("win32") == 1 and "mkdir" or "mkdir -p"
    vim.fn.system(mkdir_cmd .. " " .. vim.fn.shellescape(config.lists_dir))

    -- Set default active list if not specified
    if not config.active_list then
        config.active_list = default_list_name
    end

    -- Track list names and paths
    M.todo_lists = {
        available = {},
        active = config.active_list
    }

    -- the merge base for save_to_disk: what this list looked like on disk when nvim last read or wrote it
    local function take_snapshot(list_name, list_path)
        M.todo_lists.base = {
            list = list_name,
            stamp = disk_stamp(list_path),
            todos = vim.deepcopy(serializable_todos(M.todos)),
            notes = vim.deepcopy(M.todo_lists.notes or {}),
            metadata = vim.deepcopy(M.todo_lists.metadata or {}),
        }
    end

    -- Get list of available todo lists
    storage.get_available_lists = function()
        local lists = {}

        -- Check if lists directory exists
        if vim.fn.isdirectory(config.lists_dir) == 0 then
            return lists
        end

        -- Get all JSON files in the lists directory
        local ls_command = string.format("ls %s/*.json 2>/dev/null || true", vim.fn.shellescape(config.lists_dir))
        local output = vim.fn.systemlist(ls_command)

        -- Parse list names
        for _, file_path in ipairs(output) do
            local name = file_path:match("[^/]+%.json$")
            if name then
                name = name:gsub("%.json$", "")

                -- Load list metadata
                local file = io.open(file_path, "r")
                if file then
                    local content = file:read("*all")
                    file:close()

                    if content and content ~= "" then
                        local metadata = {}
                        local todo_count = 0
                        local overdue_count = 0
                        local due_today_count = 0
                        local overdue_items = {}
                        pcall(function()
                            local data = vim.fn.json_decode(content)
                            if data._metadata then
                                metadata = data._metadata
                            end
                            -- Count active todos in the list (exclude completed)
                            if data.todos then
                                for _, todo in ipairs(data.todos) do
                                    if not todo.done then
                                        todo_count = todo_count + 1
                                        local due_status = todo.due_date and due_dates.status(todo.due_date)
                                        if due_status == "overdue" then
                                            overdue_count = overdue_count + 1
                                            table.insert(overdue_items, {
                                                text = vim.split(todo.text or "", "\n", { plain = true })[1],
                                                due_date = todo.due_date,
                                            })
                                        elseif due_status == "today" then
                                            due_today_count = due_today_count + 1
                                        end
                                    end
                                end
                            end
                        end)

                        -- Add active todo count to metadata
                        metadata.todo_count = todo_count
                        metadata.overdue_count = overdue_count
                        metadata.due_today_count = due_today_count
                        metadata.overdue_items = overdue_items

                        table.insert(lists, {
                            name = name,
                            path = file_path,
                            metadata = metadata
                        })
                    end
                end
            end
        end

        M.todo_lists.available = lists
        return lists
    end

    -- Get the path for a specific list
    local function get_list_path(list_name)
        if not list_name or list_name == "" then
            list_name = default_list_name
        end

        -- A list name is a filename. Without this a name carrying a slash or
        -- ".." would resolve outside lists_dir; the same rule runs in bash on
        -- the tmux side so both surfaces agree on where a list lives.
        local project_list = require("doit.modules.todos.state.project_list")
        list_name = project_list.sanitize(list_name) or default_list_name

        return config.lists_dir .. "/" .. list_name .. ".json"
    end
    storage.get_list_path = get_list_path

    local function call(tool, args, active)
        return client.call(tool, args, { list = active or M.todo_lists.active, lists_dir = config.lists_dir })
    end

    -- imported items arrive through add_todo one by one; done ones are completed afterwards
    local function add_items(list_name, todos)
        local footer = require("doit.core.utils.footer")
        for _, todo in ipairs(todos or {}) do
            if todo.text and todo.text ~= "" then
                local ok, out = call("add_todo", {
                    list = list_name,
                    text = todo.text,
                    priority = type(todo.priorities) == "string" and todo.priorities ~= "" and todo.priorities or nil,
                    description = todo.description and footer.strip(todo.description) or nil,
                    due = todo.due_date,
                }, list_name)
                local id = ok and out:match("%[id:([^%]]+)%]")
                if id and todo.done then
                    call("complete_todo", { list = list_name, id = id }, list_name)
                end
            end
        end
    end

    -- Create a new todo list. metadata.auto marks a list the resolver creates on its own
    -- (project or default list), which stays Claude's like tmux's auto-create; any other is the user's.
    storage.create_list = function(list_name, initial_todos, metadata)
        if not list_name or list_name == "" then
            return false, "Invalid list name"
        end

        local list_path = get_list_path(list_name)
        if vim.fn.filereadable(list_path) == 1 then
            return false, "List '" .. list_name .. "' already exists"
        end

        local args = { name = list_name }
        if not (metadata and (metadata.auto or metadata.source == "mcp")) then
            args.source = "user"
        end
        local ok, err = call("create_list", args)
        if not ok then
            return false, "Failed to create list: " .. tostring(err)
        end
        add_items(list_name, initial_todos)

        -- Update available lists
        storage.get_available_lists()

        return true, "Created list '" .. list_name .. "'"
    end

    -- Load a specific todo list
    storage.load_list = function(list_name)
        if not list_name or list_name == "" then
            list_name = default_list_name
        end

        local list_path = get_list_path(list_name)
        M.todo_lists.base = nil

        -- Debug logging
        if config.development_mode then
            vim.notify(string.format("Loading list '%s' from path: %s", list_name, list_path), vim.log.levels.DEBUG)
        end

        -- Check if file exists, if not create a default list
        if vim.fn.filereadable(list_path) == 0 then
            storage.create_list(list_name, {}, { auto = true })
        end

        local file = io.open(list_path, "r")
        if file then
            local content = file:read("*all")
            file:close()

            if content and content ~= "" then
                local data = {}
                local success, decoded = pcall(vim.fn.json_decode, content)

                if success and decoded then
                    data = decoded

                    -- Extract todos and metadata
                    M.todos = data.todos or {}
                    M.todo_lists.metadata = data._metadata or {
                        created_at = os.time(),
                        updated_at = os.time()
                    }
                    M.todo_lists.notes = data.notes or {}

                    local needs_migration = scrub_transient(M.todos)

                    -- Migration: Add order_index if missing
                    for i, todo in ipairs(M.todos) do
                        if not todo.order_index then
                            todo.order_index = i
                            needs_migration = true
                        end

                        -- Add unique ID if missing
                        if not todo.id then
                            todo.id = require("doit.core.utils.id").generate(M.todos)
                            needs_migration = true
                        end

                        -- Migration: `timestamp` was nvim-only; `created_at` is the
                        -- cross-surface field tmux and MCP have always written.
                        if todo.timestamp and not todo.created_at then
                            todo.created_at = todo.timestamp
                            needs_migration = true
                        end
                        if todo.timestamp then
                            todo.timestamp = nil
                            needs_migration = true
                        end
                    end

                    -- Nesting: a todo with no parent_id is top level. A parent_id
                    -- pointing at an id that is not in this list (parent deleted,
                    -- or the child was moved here alone) promotes the child rather
                    -- than leaving it unreachable.
                    local ids = {}
                    for _, todo in ipairs(M.todos) do
                        if todo.id then
                            ids[todo.id] = true
                        end
                    end
                    for _, todo in ipairs(M.todos) do
                        if todo.parent_id and not ids[todo.parent_id] then
                            todo.parent_id = nil
                            todo.depth = 0
                            needs_migration = true
                        end
                        if todo.parent_id == nil and (todo.depth or 0) ~= 0 then
                            todo.depth = 0
                            needs_migration = true
                        end
                    end

                    -- Migration: Convert priorities from array to string
                    for _, todo in ipairs(M.todos) do
                        if todo.priorities and type(todo.priorities) == "table" then
                            local highest_priority = nil
                            local highest_weight = 0

                            for _, prio_name in ipairs(todo.priorities) do
                                for _, p in ipairs(config.priorities or {}) do
                                    if p.name == prio_name and (p.weight or 0) > highest_weight then
                                        highest_weight = p.weight or 0
                                        highest_priority = prio_name
                                    end
                                end
                            end

                            todo.priorities = highest_priority
                            needs_migration = true
                        end
                    end

                    -- Update active list BEFORE any migration save: save_to_disk resolves
                    -- its path from M.todo_lists.active, so migrating during a list switch
                    -- would write these todos into the previously-active list's file.
                    M.todo_lists.active = list_name
                    config.active_list = list_name

                    take_snapshot(list_name, list_path)

                    return true, "Loaded list '" .. list_name .. "'"
                end
            end
        end

        -- If loading failed, initialize with empty list
        M.todos = {}
        M.todo_lists.metadata = {}
        M.todo_lists.notes = {}
        M.todo_lists.active = list_name
        config.active_list = list_name
        take_snapshot(list_name, list_path)

        return false, "Failed to load list or list is empty"
    end

    storage.refresh_if_changed = function()
        local list_name = M.todo_lists.active or default_list_name
        local base = M.todo_lists.base
        if base and base.list == list_name and base.stamp == disk_stamp(get_list_path(list_name)) then
            return false
        end
        storage.load_list(list_name)
        return true
    end

    -- persists the link; load_list alone must not, it also runs for startup restore, previews and moves
    storage.switch_list = function(list_name)
        local ok, msg = storage.load_list(list_name)
        if ok then
            require("doit.modules.todos.state.session").save_session(list_name)
        end
        return ok, msg
    end

    -- Delete a todo list
    storage.delete_list = function(list_name)
        if not list_name or list_name == "" then
            return false, "Invalid list name"
        end
        if list_name == PERMANENT_LIST then
            return false, PERMANENT_LIST .. " is permanent; it can't be deleted"
        end

        local list_path = get_list_path(list_name)

        -- Check if file exists
        if vim.fn.filereadable(list_path) == 0 then
            return false, "List does not exist"
        end

        -- the tool archives the file under deleted/ and detaches owed twins on other lists
        local ok, err = call("delete_list", { name = list_name })
        if not ok then
            return false, "Failed to delete list: " .. tostring(err)
        end

        -- Update available lists
        storage.get_available_lists()

        -- if we deleted the active list, switch to first available
        if M.todo_lists.active == list_name then
            local available = storage.get_available_lists()
            if #available > 0 then
                storage.load_list(available[1].name)
            else
                storage.load_list(default_list_name)
            end
        end

        return true, "Deleted list '" .. list_name .. "'"
    end

    -- Rename a todo list
    storage.rename_list = function(old_name, new_name)
        if not old_name or old_name == "" or not new_name or new_name == "" then
            return false, "Invalid list name"
        end
        if old_name == PERMANENT_LIST then
            return false, PERMANENT_LIST .. " is permanent; it can't be renamed"
        end

        local old_path = get_list_path(old_name)
        local new_path = get_list_path(new_name)

        -- Check if source exists and destination doesn't
        if vim.fn.filereadable(old_path) == 0 then
            return false, "Source list does not exist"
        end

        if vim.fn.filereadable(new_path) == 1 then
            return false, "Destination list already exists"
        end

        -- the tool renames the file and relabels owed twins; window links are this process's to move
        local ok, err = call("rename_list", { old_name = old_name, new_name = new_name })
        if not ok then
            return false, "Failed to rename list: " .. tostring(err)
        end

        -- Update available lists
        storage.get_available_lists()

        -- If we renamed the active list, update active list name
        if M.todo_lists.active == old_name then
            M.todo_lists.active = new_name
            config.active_list = new_name

            -- Update session with new name
            local session = require("doit.modules.todos.state.session")
            session.save_session(new_name)
        end
        require("doit.modules.todos.state.session").relink_list(old_name, new_name)

        return true, "Renamed list '" .. old_name .. "' to '" .. new_name .. "'"
    end

    -- Load from disk (compatibility with older versions)
    storage.load_from_disk = function()
        -- Try to restore last session's list. Inside tmux the window's linked
        -- list wins (from_link), and an explicit link also outranks project
        -- derivation below.
        local session = require("doit.modules.todos.state.session")
        local last_list, from_link = session.load_session()

        if last_list then
            -- Verify the list still exists
            local list_path = get_list_path(last_list)
            if vim.fn.filereadable(list_path) == 1 then
                config.active_list = last_list
            else
                -- dead link: fall back through the rest of the chain
                from_link = false
            end
        end

        -- Opt-in: a git repo gets its own list. Runs after the session restore so
        -- it wins for this session, but the session file still remembers whatever
        -- list was last active globally. load_list creates the file when missing.
        if not from_link and config.project_lists then
            local project_list = require("doit.modules.todos.state.project_list")
            local derived = project_list.derive()
            if derived then
                config.active_list = derived
            end
        end

        -- Load the configured active list
        storage.load_list(config.active_list)

        -- Get available lists
        storage.get_available_lists()
    end

    -- doitd is the only writer of the list files; every change is a tool call that reloads the list
    storage.save_to_disk = function()
        error("doit: lists are written by doitd; call the tool for the change instead of save_to_disk")
    end

    -- List-scoped scratch notes (stored in the active list's JSON top-level `notes`)
    storage.get_notes = function()
        M.todo_lists.notes = M.todo_lists.notes or {}
        return M.todo_lists.notes
    end

    storage.add_note = function(title, body, todo_ids)
        local ok, out = call("create_note", {
            list = M.todo_lists.active,
            title = title or "",
            body = body or "",
            todo_ids = (todo_ids and #todo_ids > 0) and todo_ids or nil,
        })
        if not ok then
            return nil
        end
        storage.load_list(M.todo_lists.active)
        local id = out:match("%[id:([^%]]+)%]")
        for _, note in ipairs(storage.get_notes()) do
            if note.id == id then
                return note
            end
        end
    end

    storage.update_note = function(note_id, title, body, todo_ids)
        local args = { list = M.todo_lists.active, id = note_id, title = title, body = body }
        if todo_ids ~= nil then
            args.todo_ids = todo_ids
        end
        local ok = call("update_note", args)
        if ok then
            storage.load_list(M.todo_lists.active)
        end
        return ok and true or false
    end

    storage.delete_note = function(note_id)
        local ok = call("delete_note", { list = M.todo_lists.active, id = note_id })
        if ok then
            storage.load_list(M.todo_lists.active)
        end
        return ok and true or false
    end

    storage.import_todos = function(file_path, list_name)
        -- If list_name not provided, import to active list
        if not list_name then
            list_name = M.todo_lists.active or default_list_name
        end

        local file = io.open(file_path, "r")
        if not file then
            return false, "Could not open file: " .. file_path
        end
        local content = file:read("*all")
        file:close()

        -- Try to parse the imported data
        local status, imported_data = pcall(vim.fn.json_decode, content)
        if not status then
            return false, "Error parsing JSON file"
        end

        -- Check if the imported file has the new format (with _metadata and todos)
        local imported_todos = nil
        local imported_metadata = nil

        if imported_data.todos and type(imported_data.todos) == "table" then
            -- New format with metadata
            imported_todos = imported_data.todos
            imported_metadata = imported_data._metadata
        elseif type(imported_data) == "table" and #imported_data > 0 then
            -- Old format, direct array of todos
            imported_todos = imported_data
        else
            return false, "Invalid format in imported file"
        end

        if not imported_todos then
            return false, "No todos found in imported file"
        end

        -- Handle importing to a new list
        if list_name ~= M.todo_lists.active then
            -- Create a new list with the imported todos
            local success, msg = storage.create_list(list_name, imported_todos, imported_metadata)
            if not success then
                return false, msg
            end

            -- Switch to the new list
            storage.switch_list(list_name)
            return true, string.format("Created new list '%s' with %d imported todos", list_name, #imported_todos)
        end

        -- Otherwise, merge with current list
        add_items(list_name, imported_todos)
        storage.load_list(list_name)
        return true, string.format("Imported %d todos to list '%s'", #imported_todos, list_name)
    end

    storage.export_todos = function(file_path, export_format)
        local file = io.open(file_path, "w")
        if not file then
            return false, "Could not open file for writing: " .. file_path
        end

        local json_content = ""

        if export_format == "simple" then
            -- Simple format - just an array of todos
            json_content = vim.fn.json_encode(serializable_todos(M.todos))
        else
            -- Full format with metadata
            local data = {
                _metadata = M.todo_lists.metadata or {
                    name = M.todo_lists.active,
                    exported_at = os.time()
                },
                todos = serializable_todos(M.todos)
            }
            json_content = vim.fn.json_encode(data)
        end

        file:write(json_content)
        file:close()

        return true, string.format("Exported %d todos from list '%s' to %s",
                                   #M.todos, M.todo_lists.active, file_path)
    end

    storage.backup_all_lists = function()
        local backup_dir = config.backup_dir
            or (config.storage and config.storage.backup_dir)
            or (vim.fn.stdpath("data") .. "/doit/backups")

        local timestamp = os.date("%Y-%m-%d_%H-%M-%S")
        local backup_path = backup_dir .. "/" .. timestamp

        vim.fn.mkdir(backup_path, "p")

        local lists_dir = config.lists_dir
        local copied = 0

        -- copy all list json files
        local ls_cmd = string.format("ls %s/*.json 2>/dev/null || true", vim.fn.shellescape(lists_dir))
        local files = vim.fn.systemlist(ls_cmd)
        for _, file_path in ipairs(files) do
            if file_path ~= "" then
                local filename = file_path:match("[^/]+$")
                local src = io.open(file_path, "r")
                if src then
                    local content = src:read("*all")
                    src:close()
                    local dst = io.open(backup_path .. "/" .. filename, "w")
                    if dst then
                        dst:write(content)
                        dst:close()
                        copied = copied + 1
                    end
                end
            end
        end

        -- copy session.json
        local session_path = vim.fn.stdpath("data") .. "/doit/session.json"
        local src = io.open(session_path, "r")
        if src then
            local content = src:read("*all")
            src:close()
            local dst = io.open(backup_path .. "/session.json", "w")
            if dst then
                dst:write(content)
                dst:close()
            end
        end

        if copied == 0 then
            return false, "No lists found to backup"
        end

        return true, string.format("Backed up %d lists to %s", copied, backup_path)
    end

    storage.move_todo_to_list = function(todo_id, destination_list_name)
        if not destination_list_name or destination_list_name == "" then
            return false, "Invalid destination list name"
        end
        if vim.fn.filereadable(get_list_path(destination_list_name)) == 0 then
            return false, "Destination list does not exist"
        end
        local source_list_name = M.todo_lists.active or default_list_name
        local ok, err = call("move_todo", { id = todo_id, from_list = source_list_name, to_list = destination_list_name })
        if not ok then
            return false, tostring(err)
        end
        storage.load_list(source_list_name)
        return true, string.format("Moved todo to list '%s'", destination_list_name)
    end

    return storage
end

return storage