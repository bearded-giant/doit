-- tmux and the MCP write list files while nvim holds the same list in memory. nvim never
-- writes a list itself: every change is a tool call to doitd followed by a reload, so an
-- external edit always survives an nvim action. Needs a doitd (docker/run-tests.sh starts one).

describe("op path", function()
	local tmpdir, orig_stdpath, state

	local function list_path(name)
		return tmpdir .. "/doit/lists/" .. name .. ".json"
	end

	local function read_list(name)
		local f = io.open(list_path(name), "r")
		local data = vim.fn.json_decode(f:read("*all"))
		f:close()
		return data
	end

	local function external_edit(name, fn)
		local data = read_list(name)
		fn(data)
		local f = io.open(list_path(name), "w")
		f:write(vim.fn.json_encode(data))
		f:close()
	end

	local function find(items, id)
		for _, item in ipairs(items or {}) do
			if item.id == id then
				return item
			end
		end
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
		vim.fn.mkdir(tmpdir .. "/doit/lists", "p")
		orig_stdpath = vim.fn.stdpath
		vim.fn.stdpath = function(what)
			if what == "data" then
				return tmpdir
			end
			return orig_stdpath(what)
		end
		local f = io.open(list_path("work"), "w")
		f:write(vim.fn.json_encode({
			_metadata = { source = "user" },
			todos = {
				{ id = "a", text = "alpha", done = false, order_index = 1 },
				{ id = "x", text = "xray", done = false, order_index = 2 },
			},
			notes = { { id = "n1", title = "scratch", body = "one" } },
		}))
		f:close()

		for key in pairs(package.loaded) do
			if key == "doit" or key:match("^doit%.") then
				package.loaded[key] = nil
			end
		end
		require("doit").setup({ modules = { todos = { enabled = true } } })
		state = require("doit.core").get_module("todos").state
		state.load_list("work")
	end)

	after_each(function()
		vim.fn.stdpath = orig_stdpath
		vim.fn.delete(tmpdir, "rf")
	end)

	it("keeps an item the MCP added while nvim completes another", function()
		external_edit("work", function(data)
			table.insert(data.todos, { id = "b", text = "bravo", done = false, order_index = 3 })
		end)

		state.complete_todo(index_of("a"))

		local disk = read_list("work")
		assert.is_truthy(find(disk.todos, "b"))
		assert.is_true(find(disk.todos, "a").done)
		assert.are.equal("number", type(find(disk.todos, "a").completed_at))
		assert.is_truthy(find(state.todos, "b"), "the reload picked up the external item")
	end)

	it("adds through doitd as the user's item with a footer", function()
		local todo = state.add_todo("new thing", "urgent")
		assert.is_truthy(todo and todo.id)
		local disk = find(read_list("work").todos, todo.id)
		assert.are.equal("user", disk.source)
		assert.are.equal("urgent", disk.priorities)
		assert.are.equal("new thing", disk.text)
		assert.is_truthy(disk.description:match("last modified: "))
	end)

	it("edits by id, so a reload during a prompt cannot hit another item", function()
		external_edit("work", function(data)
			table.remove(data.todos, 1)
		end)
		assert.is_true((state.update_todo("x", { text = "xray renamed" })))
		assert.are.equal("xray renamed", find(read_list("work").todos, "x").text)
		assert.are.equal(1, #state.todos)
	end)

	it("sets and clears a due date", function()
		assert.is_true((state.set_due_date(index_of("x"), "2026-12-01")))
		assert.are.equal("2026-12-01", find(read_list("work").todos, "x").due_date)
		assert.is_true((state.remove_due_date(index_of("x"))))
		assert.is_nil(find(read_list("work").todos, "x").due_date)
	end)

	it("deletes to a tombstone and undoes by id", function()
		state.delete_todo(index_of("a"))
		local disk = read_list("work")
		assert.is_nil(find(disk.todos, "a"))
		assert.are.equal("a", disk._metadata.deleted_todos[1].id)
		assert.is_true(state.undo_delete())
		assert.is_truthy(find(read_list("work").todos, "a"))
	end)

	it("creates, renames and deletes lists through the tools", function()
		assert.is_true((state.create_list("scratch")))
		assert.are.equal("user", read_list("scratch")._metadata.source)
		assert.is_true((state.rename_list("scratch", "scratch2")))
		assert.are.equal(1, vim.fn.filereadable(list_path("scratch2")))
		assert.is_true((state.delete_list("scratch2")))
		assert.are.equal(0, vim.fn.filereadable(list_path("scratch2")))
		assert.are.equal(1, #vim.fn.glob(tmpdir .. "/doit/deleted/scratch2-*.json", false, true))
	end)

	it("list notes go through the tools", function()
		local note = state.add_note("title", "body")
		assert.is_truthy(note and note.id)
		assert.is_true(state.update_note(note.id, "title two"))
		local disk = read_list("work")
		assert.are.equal(2, #disk.notes)
		assert.are.equal("title two", disk.notes[2].title)
		assert.is_true(state.delete_note(note.id))
		assert.are.equal(1, #read_list("work").notes)
	end)

	it("moves an item to another list", function()
		state.create_list("other")
		assert.is_true((state.move_todo_to_list("x", "other")))
		assert.is_nil(find(read_list("work").todos, "x"))
		assert.is_truthy(find(read_list("other").todos, "x"))
	end)

	it("has no direct save path left", function()
		assert.has_error(function()
			state.save_to_disk()
		end)
	end)
end)
