-- lua tool: lets the model run Lua snippets directly instead of writing a
-- temp file and shelling out through bash.
--
-- Snippets run in a fresh environment inside the runtime: print/io.write
-- are captured, os.exit is disabled, and runaway loops stop after TIMEOUT
-- seconds of CPU time.

local pi = require("pi")

local TIMEOUT = 10

local function sandbox(output)
	local function write(...)
		for i = 1, select("#", ...) do
			table.insert(output, tostring((select(i, ...))))
		end
	end

	local function print(...)
		local parts = {}
		for i = 1, select("#", ...) do
			parts[i] = tostring((select(i, ...)))
		end
		write(table.concat(parts, "\t"), "\n")
	end

	local function exit()
		error("os.exit is disabled inside the lua tool", 2)
	end

	return setmetatable({
		print = print,
		io = setmetatable({ write = write }, { __index = io }),
		os = setmetatable({ exit = exit }, { __index = os }),
	}, { __index = _G })
end

local function run(code)
	local output = {}
	local chunk, err = load(code, "=snippet", "t", sandbox(output))
	if not chunk then
		error(err, 0)
	end

	local deadline = os.clock() + TIMEOUT
	debug.sethook(function()
		if os.clock() > deadline then
			error("timed out after " .. TIMEOUT .. "s of CPU time", 2)
		end
	end, "", 100000)
	local ok, result = pcall(chunk)
	debug.sethook()

	local text = table.concat(output)
	if not ok then
		error(text .. tostring(result), 0)
	end
	if result ~= nil then
		text = text .. tostring(result)
	end
	return text
end

pi.tool({
	name = "lua",
	label = "Lua",
	description = "Run a Lua snippet and return what it printed (plus its return value, if any). "
		.. "Use this for quick Lua prototyping, calculations, or testing snippets instead of "
		.. "writing a throwaway .lua file and invoking bash yourself.",
	snippet = "Execute a Lua script and return its output",
	guidelines = {
		"Use lua to run standalone Lua code snippets directly instead of writing a temp file and calling bash.",
	},
	parameters = {
		code = { type = "string", description = "Lua source code to execute" },
	},
	execute = function(params)
		return run(params.code)
	end,
})
