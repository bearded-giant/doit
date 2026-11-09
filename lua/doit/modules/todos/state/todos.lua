local ops = require("doit.modules.todos.state.ops")

local M = {}

function M.setup(state)
    local function by_index(index)
        return state.todos[index]
    end

    local function id_args(todo, extra)
        local args = { id = todo.id, list = state.todo_lists.active }
        for k, v in pairs(extra or {}) do
            args[k] = v
        end
        return args
    end

    -- one level, like tmux u: the last status change, else the last delete
    local function remember_status(todo)
        state.last_undo = {
            kind = "status",
            id = todo.id,
            done = todo.done == true,
            in_progress = todo.in_progress == true,
        }
    end

    function M.add_todo(text, priorities, parent_id)
        local priority = priorities
        if type(priorities) == "table" then
            priority = priorities[1]
        end
        if priority == "" then
            priority = nil
        end
        -- a parent that is not on the list means top level, as the old in-memory add did
        if parent_id and not ops.by_id(parent_id) then
            parent_id = nil
        end
        local ok, out = ops.call("add_todo", {
            list = state.todo_lists.active,
            text = text,
            priority = priority,
            parent = parent_id,
        })
        if not ok then
            return nil
        end
        return ops.by_id(ops.id_from(out))
    end

    function M.get_todo_by_id(id)
        if not id then return nil end
        return ops.by_id(id)
    end

    function M.get_todos_by_note_id(note_id)
        if not note_id then return {} end

        local linked_todos = {}
        for _, todo in ipairs(state.todos) do
            if todo.note_id == note_id then
                table.insert(linked_todos, todo)
            end
        end
        return linked_todos
    end

    -- changes: text, description, priority ("none" clears), due ("" clears), sequence (0 clears),
    -- in_progress, parent ("" unnests), fields (surface-owned keys; vim.NIL clears one)
    function M.update_todo(id, changes)
        local args = { id = id, list = state.todo_lists.active }
        for k, v in pairs(changes or {}) do
            args[k] = v
        end
        return ops.call("update_todo", args)
    end

    function M.set_priority(id, name)
        return M.update_todo(id, { priority = name or "none" })
    end

    -- reorder one step inside the item's section; the swap rules live in core's reorder_todo
    function M.reorder(id, direction)
        return ops.call("reorder_todo", { id = id, list = state.todo_lists.active, direction = direction })
    end

    local STATUS_TOOL = { start = "start_todo", complete = "complete_todo", revert = "revert_todo" }

    function M.set_status(todo, action)
        return ops.call(STATUS_TOOL[action], id_args(todo))
    end

    function M.start_todo(index)
        local todo = by_index(index)
        if not todo then
            return
        end
        remember_status(todo)
        M.set_status(todo, "start")
    end

    function M.complete_todo(index)
        local todo = by_index(index)
        if not todo or todo.done then
            return
        end
        remember_status(todo)
        M.set_status(todo, "complete")
    end

    function M.undo_last()
        local last = state.last_undo
        state.last_undo = nil
        if last and last.kind == "status" then
            local todo = M.get_todo_by_id(last.id)
            if not todo then
                return false
            end
            -- back to the status it had; the tool re-stamps completed_at and mirrors an owed twin
            if last.done then
                M.set_status(todo, "complete")
            elseif last.in_progress then
                M.set_status(todo, "start")
            else
                M.set_status(todo, "revert")
            end
            return true
        end
        return M.undo_delete()
    end

    -- pending -> in_progress -> done -> pending
    function M.toggle_todo(index)
        local todo = by_index(index)
        if not todo then
            return
        end
        remember_status(todo)
        if todo.done then
            M.set_status(todo, "revert")
        elseif todo.in_progress then
            M.set_status(todo, "complete")
        else
            M.set_status(todo, "start")
        end
    end

    function M.set_in_progress(index, value)
        local todo = by_index(index)
        if todo then
            M.update_todo(todo.id, { in_progress = value and true or false })
        end
    end

    function M.revert_to_pending(index)
        local todo = by_index(index)
        if todo then
            remember_status(todo)
            M.set_status(todo, "revert")
        end
    end

    -- deletes become tombstones on the list (the tool keeps the last 10); undo restores by id
    function M.delete_todo(index)
        local todo = by_index(index)
        if not todo then
            return
        end
        if ops.call("delete_todo", id_args(todo)) then
            table.insert(state.deleted_todos, 1, vim.deepcopy(todo))
            state.deleted_todos[state.MAX_UNDO_HISTORY + 1] = nil
            state.last_undo = { kind = "delete" }
        end
    end

    function M.delete_completed()
        local done = 0
        for _, todo in ipairs(state.todos) do
            if todo.done then
                done = done + 1
            end
        end
        if done == 0 then
            return 0
        end
        return ops.call("clear_done", { list = state.todo_lists.active }) and done or 0
    end

    function M.undo_delete()
        local todo = table.remove(state.deleted_todos, 1)
        if not todo then
            return false
        end
        return (ops.call("restore_todo", { id = todo.id, list = state.todo_lists.active }))
    end

    function M.edit_todo(index, new_text)
        local todo = by_index(index)
        if todo then
            M.update_todo(todo.id, { text = new_text })
        end
    end

    -- through the state table so a spec with a fake state can stand in for the tool
    local function update(id, changes)
        return (state.update_todo or M.update_todo)(id, changes)
    end

    function M.link_todo_to_note(todo_index, note_id, note_summary)
        local todo = by_index(todo_index)
        if not todo then
            return false
        end
        return (update(todo.id, { fields = { note_id = note_id, note_summary = note_summary, note_updated_at = os.time() } }))
    end

    function M.unlink_todo_from_note(todo_index)
        local todo = by_index(todo_index)
        if not todo then
            return false
        end
        return (update(todo.id, { fields = { note_id = vim.NIL, note_summary = vim.NIL, note_updated_at = vim.NIL } }))
    end

    -- Indices of todos that repeat an earlier todo's normalized text. The first
    -- occurrence is always the keeper, so this is stable under re-runs.
    local function duplicate_indices()
        local normalize = require("doit.modules.todos.state.normalize")
        local footer = require("doit.core.utils.footer")
        -- every todo carries a footer stamp, so "has a description" is always
        -- true — the keeper test has to look past the footer at real notes
        local function has_notes(todo)
            return footer.strip(todo.description or ""):gsub("%s", "") ~= ""
        end

        local groups = {}
        local order = {}
        for i, todo in ipairs(state.todos) do
            local key = normalize.normalize(todo.text)
            -- an empty body carries no identity; never collapse those together
            if key ~= "" then
                if not groups[key] then
                    groups[key] = {}
                    table.insert(order, key)
                end
                table.insert(groups[key], i)
            end
        end

        local dupes = {}
        for _, key in ipairs(order) do
            local idxs = groups[key]
            if #idxs > 1 then
                -- keep the copy carrying real notes, else the first occurrence,
                -- so nvim and MCP agree on which one survives
                local keep = idxs[1]
                for _, i in ipairs(idxs) do
                    if has_notes(state.todos[i]) then
                        keep = i
                        break
                    end
                end
                for _, i in ipairs(idxs) do
                    if i ~= keep then
                        table.insert(dupes, i)
                    end
                end
            end
        end

        table.sort(dupes)
        return dupes
    end

    -- Non-destructive: lets the UI show a count and preview before confirming.
    function M.find_duplicates()
        local dupes = duplicate_indices()
        local previews = {}
        for _, idx in ipairs(dupes) do
            table.insert(previews, state.todos[idx].text)
        end
        return #dupes, previews
    end

    function M.remove_duplicates()
        local dupes = duplicate_indices()
        if #dupes == 0 then
            return 0
        end
        for _, idx in ipairs(dupes) do
            table.insert(state.deleted_todos, 1, vim.deepcopy(state.todos[idx]))
        end
        state.deleted_todos[state.MAX_UNDO_HISTORY + 1] = nil
        return ops.call("dedupe_todos", { list = state.todo_lists.active, dry_run = false }) and #dupes or 0
    end

    return M
end

return M
