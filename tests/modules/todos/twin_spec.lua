-- Owed items live twice (a project list and daily). Every nvim change is a tool call, and
-- the tools keep the other copy in step. Needs a doitd (docker/run-tests.sh starts one).

describe("owed twin sync", function()
	local tmpdir, orig_stdpath, state

	local function list_path(name)
		return tmpdir .. "/doit/lists/" .. name .. ".json"
	end

	local function write_list(name, todos, metadata)
		vim.fn.mkdir(tmpdir .. "/doit/lists", "p")
		local f = io.open(list_path(name), "w")
		f:write(vim.fn.json_encode({ todos = todos, _metadata = metadata or { created_at = 1 } }))
		f:close()
	end

	local function read_list(name)
		local f = io.open(list_path(name), "r")
		local data = vim.fn.json_decode(f:read("*all"))
		f:close()
		return data
	end

	local function item(list, id)
		for _, t in ipairs(read_list(list).todos or {}) do
			if t.id == id then
				return t
			end
		end
	end

	local function deleted_ids(list)
		local ids = {}
		for _, t in ipairs(read_list(list)._metadata.deleted_todos or {}) do
			table.insert(ids, t.id)
		end
		return ids
	end

	local function index_of(id)
		for i, t in ipairs(state.todos) do
			if t.id == id then
				return i
			end
		end
	end

	before_each(function()
		tmpdir = vim.fn.tempname()
		vim.fn.mkdir(tmpdir, "p")
		orig_stdpath = vim.fn.stdpath
		vim.fn.stdpath = function(what)
			if what == "data" then
				return tmpdir
			end
			return orig_stdpath(what)
		end

		write_list("proj", {
			{ id = "P1", text = "owed in daily #1: merge it", done = false, in_progress = false, order_index = 1,
				twin = { list = "daily", id = "D1" } },
			{ id = "P2", text = "plain", done = false, in_progress = false, order_index = 2 },
		})
		write_list("daily", {
			{ id = "D1", text = "proj: merge it", done = false, in_progress = true, order_index = 1,
				twin = { list = "proj", id = "P1" } },
		}, { created_at = 1, deleted_todos = { { id = "OLD", text = "old" } } })
		write_list("other", {})

		for key in pairs(package.loaded) do
			if key == "doit" or key:match("^doit%.") then
				package.loaded[key] = nil
			end
		end
		require("doit").setup({ modules = { todos = { enabled = true } } })
		state = require("doit.core").get_module("todos").state
		state.load_list("proj")
	end)

	after_each(function()
		vim.fn.stdpath = orig_stdpath
		vim.fn.delete(tmpdir, "rf")
	end)

	it("toggle pending -> in_progress leaves the twin alone", function()
		local before = read_list("daily")
		state.toggle_todo(index_of("P1"))
		assert.are.same(before, read_list("daily"))
	end)

	it("toggle to done completes the twin with the same completed_at", function()
		state.toggle_todo(index_of("P1"))
		state.toggle_todo(index_of("P1"))
		local d1 = item("daily", "D1")
		assert.is_true(d1.done)
		assert.is_false(d1.in_progress)
		assert.are.equal(item("proj", "P1").completed_at, d1.completed_at)
		assert.is_true(read_list("daily")._metadata.updated_at > 1)
	end)

	it("toggle done -> pending reverts the twin", function()
		for _ = 1, 3 do
			state.toggle_todo(index_of("P1"))
		end
		local d1 = item("daily", "D1")
		assert.is_false(d1.done)
		assert.is_nil(d1.completed_at)
	end)

	it("revert_to_pending reverts the twin", function()
		state.complete_todo(index_of("P1"))
		state.revert_to_pending(index_of("P1"))
		local d1 = item("daily", "D1")
		assert.is_false(d1.done)
		assert.is_false(d1.in_progress)
		assert.is_nil(d1.completed_at)
	end)

	it("set_in_progress does not sync", function()
		local before = read_list("daily")
		state.set_in_progress(index_of("P1"), true)
		assert.are.same(before, read_list("daily"))
	end)

	it("delete moves the twin to the front of its list's deleted_todos", function()
		state.delete_todo(index_of("P1"))
		assert.is_nil(item("daily", "D1"))
		assert.are.same({ "D1", "OLD" }, deleted_ids("daily"))
	end)

	it("undo of a delete restores the twin", function()
		state.delete_todo(index_of("P1"))
		assert.is_true(state.undo_last())
		assert.is_truthy(item("proj", "P1"))
		assert.is_truthy(item("daily", "D1"))
		assert.are.same({ "OLD" }, deleted_ids("daily"))
	end)

	it("priority copies or clears", function()
		state.set_priority("P1", "urgent")
		assert.are.equal("urgent", item("daily", "D1").priorities)
		state.set_priority("P1", nil)
		assert.is_nil(item("daily", "D1").priorities)
	end)

	it("due set / remove syncs", function()
		state.set_due_date(index_of("P1"), "2026-11-01")
		assert.are.equal("2026-11-01", item("daily", "D1").due_date)
		state.remove_due_date(index_of("P1"))
		assert.is_nil(item("daily", "D1").due_date)
	end)

	it("move relinks the twin to the destination list", function()
		assert.is_true((state.move_todo_to_list("P1", "other")))
		assert.are.same({ list = "other", id = "P1" }, item("daily", "D1").twin)
		assert.are.equal("other: merge it", item("daily", "D1").text)
	end)

	it("rename relinks twins of the renamed list", function()
		assert.is_true((state.rename_list("proj", "proj2")))
		assert.are.same({ list = "proj2", id = "P1" }, item("daily", "D1").twin)
		assert.are.equal("proj2", state.todo_lists.active)
	end)

	it("delete_list archives the file and keeps each daily twin, unlinked, with notes that never synced", function()
		state.update_todo("P1", { description = "do: merge\n  DONE half" })
		state.load_list("daily")
		assert.is_true((state.delete_list("proj")))
		assert.are.equal(0, vim.fn.filereadable(list_path("proj")))
		local d1 = item("daily", "D1")
		assert.is_nil(d1.twin)
		assert.is_truthy(d1.description:match('notes from "proj":\ndo: merge\n  DONE half'))
		assert.is_truthy(d1.description:match('list "proj" deleted %d%d%d%d%-%d%d%-%d%d; twin link dropped'))
	end)

	it("works in the other direction (daily -> project)", function()
		state.load_list("daily")
		state.complete_todo(index_of("D1"))
		assert.is_true(item("proj", "P1").done)
	end)
end)
