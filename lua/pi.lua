-- pi.lua: the Lua side of pi-lua.
--
-- Plugins `require("pi")` and register what they care about:
--
--   local pi = require("pi")
--   pi.on("turn_end", function(event, ctx) ... end)
--   pi.tool({ name = "...", description = "...", parameters = {...}, execute = function(params, ctx) ... end })
--   pi.command({ name = "...", description = "...", handler = function(args, ctx) ... end })
--   pi.every(1000, function(ctx) ... end)
--   pi.screen({ key = "...", on_resize = function(w, h, ctx), on_key = function(key, ctx), on_close = function(ctx) end })
--
-- Every callback gets a `ctx`:
--   ctx.cwd, ctx.model, ctx.has_ui
--   ctx.session_file   path of the session .jsonl (nil until pi first saves it)
--   ctx.context        { tokens, window, percent } or nil before the first turn
--   ctx.ui.notify(message, level)          level: "info" | "warning" | "error"
--   ctx.ui.set_status(key, line)           one line in the footer (nil clears)
--   ctx.ui.set_widget(key, lines)          lines above the editor (nil clears)
--
-- A "line" is a plain string or a list of { color, text } spans, where color
-- is a pi theme color: accent, muted, dim, text, success, warning, error,
-- toolTitle, ...
--
-- When run as a script, this file is the runtime that src/adapter.ts
-- talks to: it loads the plugin files given as argv, then answers JSON
-- lines on stdin and replies on fd 3 (stdout is left free for stray prints).

local here = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
package.path = here .. "?.lua;" .. package.path

local json = require("json")

local pi = {}

local handlers = {} -- event name -> list of { plugin, fn }
local tools = {} -- name -> spec
local commands = {} -- name -> spec
local timers = {} -- list of { plugin, ms, fn }
local screens = {} -- key -> full-screen spec
local loading -- plugin file currently being loaded

local channel

local function send(message)
	channel:write(json.encode(message), "\n")
	channel:flush()
end

-- Public API ---------------------------------------------------------------

function pi.on(event, fn)
	handlers[event] = handlers[event] or {}
	table.insert(handlers[event], { plugin = loading, fn = fn })
end

-- parameters: { name = { type = "string", description = "...", optional = true }, ... }
function pi.tool(spec)
	assert(spec.name and spec.description and spec.execute, "pi.tool needs name, description and execute")
	spec.plugin = loading
	tools[spec.name] = spec
end

function pi.command(spec)
	assert(spec.name and spec.handler, "pi.command needs name and handler")
	spec.plugin = loading
	commands[spec.name] = spec
end

function pi.every(ms, fn)
	table.insert(timers, { plugin = loading, ms = ms, fn = fn })
end

-- Open a full-screen surface. The adapter hands it the real terminal size
-- via on_resize(w, h, ctx); push frames with ctx.ui.set_screen(key, lines)
-- where lines are strings (raw ANSI allowed) or span lists. `on_key(key, ctx)`
-- fires for every key except escape/q, which the adapter uses to close.
function pi.screen(spec)
	assert(spec.key, "pi.screen needs a key")
	spec.plugin = loading
	screens[spec.key] = spec
	send({ type = "ui", op = "screen_open", key = spec.key, help = spec.help })
end

-- Runtime ------------------------------------------------------------------

local function make_ctx(data)
	local ctx = data or {}
	ctx.ui = {
		notify = function(message, level)
			send({ type = "ui", op = "notify", message = tostring(message), level = level or "info" })
		end,
		set_status = function(key, line)
			send({ type = "ui", op = "set_status", key = key, line = line })
		end,
		set_widget = function(key, lines)
			send({ type = "ui", op = "set_widget", key = key, lines = lines })
		end,
		set_screen = function(key, lines)
			send({ type = "ui", op = "screen_frame", key = key, lines = lines })
		end,
		close_screen = function(key)
			send({ type = "ui", op = "screen_close", key = key })
		end,
	}
	return ctx
end

-- "/path/to/dashboard.lua" -> "dashboard"
local function plugin_name(path)
	return path and path:match("([^/]+)%.lua$") or "pi-lua"
end

-- Run fn(...), tagging any error with the plugin it came from.
local function call(plugin, fn, ...)
	local ok, result = pcall(fn, ...)
	if ok then
		return true, result
	end
	return false, "[" .. plugin_name(plugin) .. "] " .. tostring(result)
end

local function report(ok, err)
	if not ok then
		send({ type = "error", message = err })
	end
end

local dispatch = {}

function dispatch.event(message, ctx)
	for _, handler in ipairs(handlers[message.name] or {}) do
		report(call(handler.plugin, handler.fn, message.event or {}, ctx))
	end
end

function dispatch.timer(message, ctx)
	local timer = timers[message.timer]
	report(call(timer.plugin, timer.fn, ctx))
end

function dispatch.tool(message, ctx)
	local tool = tools[message.name]
	local ok, result = call(tool.plugin, tool.execute, message.params or {}, ctx)
	if not ok then
		error(result, 0)
	end
	return result ~= nil and tostring(result) or ""
end

function dispatch.command(message, ctx)
	local command = commands[message.name]
	report(call(command.plugin, command.handler, message.args or "", ctx))
end

function dispatch.screen(message, ctx)
	local spec = screens[message.screen]
	if not spec then
		return
	end
	if message.op == "resize" then
		if spec.on_resize then
			report(call(spec.plugin, spec.on_resize, message.width, message.height, ctx))
		end
	elseif message.op == "key" then
		if spec.on_key then
			report(call(spec.plugin, spec.on_key, message.key, ctx))
		end
	elseif message.op == "closed" then
		if spec.on_close then
			report(call(spec.plugin, spec.on_close, ctx))
		end
	end
end

local function manifest()
	local tool_list, command_list, event_list, timer_list = {}, {}, {}, {}

	for _, tool in pairs(tools) do
		local params = {}
		for name, param in pairs(tool.parameters or {}) do
			table.insert(params, {
				name = name,
				type = param.type or "string",
				description = param.description,
				optional = param.optional == true,
			})
		end
		table.insert(tool_list, {
			name = tool.name,
			plugin = plugin_name(tool.plugin),
			label = tool.label,
			description = tool.description,
			snippet = tool.snippet,
			guidelines = tool.guidelines,
			parameters = params,
		})
	end
	for _, command in pairs(commands) do
		table.insert(command_list, {
			name = command.name,
			plugin = plugin_name(command.plugin),
			description = command.description,
		})
	end
	for event in pairs(handlers) do
		table.insert(event_list, event)
	end
	for _, timer in ipairs(timers) do
		table.insert(timer_list, timer.ms)
	end

	return { type = "ready", tools = tool_list, commands = command_list, events = event_list, timers = timer_list }
end

local function run(plugin_paths)
	channel = assert(io.open("/dev/fd/3", "w"), "pi-lua runtime must be started by src/adapter.ts")

	for _, path in ipairs(plugin_paths) do
		loading = path
		local chunk, err = loadfile(path)
		if chunk then
			report(call(path, chunk))
		else
			report(false, err)
		end
	end
	loading = nil

	send(manifest())

	for line in io.lines() do
		local message = json.decode(line)
		local ok, result = pcall(dispatch[message.type], message, make_ctx(message.ctx))
		if ok then
			send({ type = "done", id = message.id, result = result })
		else
			send({ type = "done", id = message.id, error = result })
		end
	end
end

-- `lua pi.lua plugin.lua ...` runs the runtime; `require("pi")` just gets the API.
if arg and arg[0] and arg[0]:match("pi%.lua$") and not package.loaded.pi then
	package.loaded.pi = pi
	run(arg)
end

return pi
