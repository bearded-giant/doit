-- load, import and export against a real data dir; writes go through doitd
-- (docker/run-tests.sh starts one).

describe("storage", function()
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

	local function write_json(path, data)
		local f = io.open(path, "w")
		f:write(vim.fn.json_encode(data))
		f:close()
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
		write_json(list_path("daily"), {
			_metadata = {},
			todos = { { id = "t1", text = "Loaded todo", done = false, order_index = 1 } },
		})

		for key in pairs(package.loaded) do
			if key == "doit" or key:match("^doit%.") then
				package.loaded[key] = nil
			end
		end
		require("doit").setup({ modules = { todos = { enabled = true } } })
		state = require("doit.core").get_module("todos").state
		state.load_list("daily")
	end)

	after_each(function()
		vim.fn.stdpath = orig_stdpath
		vim.fn.delete(tmpdir, "rf")
	end)

	it("loads todos from disk", function()
		assert.are.equal(1, #state.todos)
		assert.are.equal("Loaded todo", state.todos[1].text)
		assert.is_false(state.todos[1].done)
	end)

	it("imports todos from a file into the current list", function()
		local import = tmpdir .. "/import.json"
		write_json(import, { { text = "Imported todo", done = false }, { text = "Already done", done = true, priorities = "urgent" } })

		local ok, message = state.import_todos(import)
		assert.is_true(ok, message)
		local disk = read_list("daily")
		assert.are.equal(3, #disk.todos)
		assert.are.equal("Imported todo", disk.todos[2].text)
		assert.are.equal("user", disk.todos[2].source)
		assert.is_true(disk.todos[3].done)
		assert.are.equal("urgent", disk.todos[3].priorities)
		assert.are.equal(3, #state.todos)
	end)

	it("imports into a new list and switches to it", function()
		local import = tmpdir .. "/import.json"
		write_json(import, { todos = { { text = "In the new list", done = false } }, _metadata = {} })

		local ok, message = state.import_todos(import, "imported")
		assert.is_true(ok, message)
		assert.are.equal(1, #read_list("imported").todos)
		assert.are.equal("imported", state.todo_lists.active)
	end)

	it("exports todos to a file", function()
		local out = tmpdir .. "/export.json"
		local ok = state.export_todos(out)
		assert.is_true(ok)
		local f = io.open(out, "r")
		local data = vim.fn.json_decode(f:read("*all"))
		f:close()
		assert.are.equal("Loaded todo", data.todos[1].text)
	end)
end)
