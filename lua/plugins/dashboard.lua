-- Dashboard: a widget above the editor with a sparkline of output tokens
-- per turn and bars for the most-used tools.
--
--   ▁▂▂▃▅▇▆▃▂▅▇█  out/turn  last 1.2k · avg 840 · total 10.1k
--   bash ████████ 12   read █████ 7   edit ███ 4   lua █ 1
--
-- Stats are rebuilt from the session file on start, so /reload and
-- resuming a session pick up where you left off. `/dashboard` shows or
-- hides it.

local pi = require("pi")
local json = require("json")

local KEY = "lua-dashboard"
local SPARK = { "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█" }
local SPARK_WIDTH = 32 -- most recent turns shown
local BAR_WIDTH = 8
local MAX_TOOLS = 5

local turns = {} -- output tokens per assistant turn, oldest first
local tool_counts = {} -- tool name -> calls
local hidden = false

-- Count one assistant reply: its output tokens and the tools it called.
-- Aborted or failed replies report zero usage and would show as fake dips.
local function record(message)
	if message.role ~= "assistant" or message.stopReason == "aborted" or message.stopReason == "error" then
		return
	end
	table.insert(turns, message.usage and message.usage.output or 0)
	for _, part in ipairs(message.content or {}) do
		if part.type == "toolCall" then
			tool_counts[part.name] = (tool_counts[part.name] or 0) + 1
		end
	end
end

local function replay(session_file)
	local file = session_file and io.open(session_file)
	if not file then
		return
	end
	for line in file:lines() do
		local ok, entry = pcall(json.decode, line)
		if ok and entry.type == "message" and entry.message then
			record(entry.message)
		end
	end
	file:close()
end

local function fmt_count(n)
	if n >= 1e6 then
		return string.format("%.1fM", n / 1e6)
	elseif n >= 1e3 then
		return string.format("%.1fk", n / 1e3)
	end
	return tostring(math.floor(n))
end

local function sparkline(values)
	local first = math.max(1, #values - SPARK_WIDTH + 1)
	local peak = 0
	for i = first, #values do
		peak = math.max(peak, values[i])
	end

	local cells = {}
	for i = first, #values do
		local level = peak > 0 and math.floor(values[i] / peak * (#SPARK - 1) + 0.5) or 0
		table.insert(cells, SPARK[level + 1])
	end
	return table.concat(cells)
end

local function token_line()
	if #turns == 0 then
		return { { "dim", "waiting for the first turn..." } }
	end

	local total = 0
	for _, n in ipairs(turns) do
		total = total + n
	end

	return {
		{ "accent", sparkline(turns) },
		{ "dim", "  out/turn  " },
		{ "muted", string.format(
			"last %s · avg %s · total %s",
			fmt_count(turns[#turns]),
			fmt_count(total / #turns),
			fmt_count(total)
		) },
	}
end

local function tool_line()
	local tools = {}
	for name, count in pairs(tool_counts) do
		table.insert(tools, { name = name, count = count })
	end
	if #tools == 0 then
		return { { "dim", "no tool calls yet" } }
	end
	table.sort(tools, function(a, b)
		return a.count > b.count or (a.count == b.count and a.name < b.name)
	end)

	local peak = tools[1].count
	local spans = {}
	for i = 1, math.min(#tools, MAX_TOOLS) do
		local tool = tools[i]
		local filled = math.max(1, math.floor(tool.count / peak * BAR_WIDTH + 0.5))
		if i > 1 then
			table.insert(spans, { "dim", "   " })
		end
		table.insert(spans, { "toolTitle", tool.name .. " " })
		table.insert(spans, { "success", string.rep("█", filled) })
		table.insert(spans, { "muted", " " .. tool.count })
	end
	return spans
end

local function render(ctx)
	ctx.ui.set_widget(KEY, not hidden and { token_line(), tool_line() } or nil)
end

pi.on("session_start", function(_, ctx)
	turns, tool_counts = {}, {}
	replay(ctx.session_file)
	render(ctx)
end)

pi.on("message_end", function(event)
	record(event.message)
end)

pi.on("turn_end", function(_, ctx)
	render(ctx)
end)

pi.command({
	name = "dashboard",
	description = "Show or hide the Lua dashboard",
	handler = function(_, ctx)
		hidden = not hidden
		render(ctx)
	end,
})

pi.on("session_shutdown", function(_, ctx)
	ctx.ui.set_widget(KEY, nil)
end)
