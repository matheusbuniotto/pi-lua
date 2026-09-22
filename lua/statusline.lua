#!/usr/bin/env lua
-- pi cool statusline generator
--
-- Renders one line as pipe-delimited segments:
--   spinner|location|model|context-bar|elapsed|quip
--
-- The pi TypeScript extension (../src/statusline.ts) colorizes each
-- segment with the active theme and pushes it into the footer via
-- ctx.ui.setStatus(). Keeping the logic here means the "brain" of the
-- statusline is plain Lua you can hack on without touching TypeScript.
--
-- argv: frame cwd model tokens contextWindow elapsedSec
-- tokens/contextWindow are raw counts (not a pre-rounded percent) so this
-- script can show absolute progress even when the window is huge and the
-- percentage barely moves (e.g. 1.8k/262k is legible; round(0.7%) is not).

local frame = tonumber(arg[1]) or 0
local cwd = arg[2] or "."
local model = arg[3] or "?"
local tokens = tonumber(arg[4])
local context_window = tonumber(arg[5])
local elapsed = tonumber(arg[6]) or 0

-- 1. Spinner
local SPINNER = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" }
local spin = SPINNER[(frame % #SPINNER) + 1]

-- 2. Location: project dir name + git branch, if any
local function popen_trim(cmd)
	local handle = io.popen(cmd)
	if not handle then
		return nil
	end
	local out = handle:read("*a")
	handle:close()
	if not out then
		return nil
	end
	out = out:gsub("%s+$", "")
	return out ~= "" and out or nil
end

local project = cwd:match("([^/\\]+)[/\\]?$") or cwd
local branch = popen_trim('git -C "' .. cwd .. '" rev-parse --abbrev-ref HEAD 2>/dev/null')
local location = branch and (project .. " (" .. branch .. ")") or project

-- 3. Context usage: fine-grained bar (eighth-block resolution) + absolute
-- token count, so progress is visible long before the percentage rolls
-- over to the next whole point.
local BAR_WIDTH = 20
local EIGHTHS = { " ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█" }

local function fmt_count(n)
	if n >= 1e6 then
		return string.format("%.1fM", n / 1e6)
	elseif n >= 1e3 then
		return string.format("%.1fk", n / 1e3)
	end
	return tostring(math.floor(n))
end

local function make_bar(pct)
	pct = math.max(0, math.min(100, pct))
	local eighths = math.floor(pct / 100 * BAR_WIDTH * 8 + 0.5)
	local full = math.floor(eighths / 8)
	local remainder = eighths % 8
	local cells = string.rep("█", full)
	if remainder > 0 and full < BAR_WIDTH then
		cells = cells .. EIGHTHS[remainder + 1]
		full = full + 1
	end
	return cells .. string.rep(" ", BAR_WIDTH - full)
end

-- Note: use ⟦⟧ (not ASCII '|') to frame the bar -- the final line below is
-- itself pipe-delimited, so a literal '|' here would corrupt the parsing
-- done by the TypeScript side.
local context
if tokens and context_window and context_window > 0 then
	local pct = tokens / context_window * 100
	local pct_label = pct < 10 and string.format("%.1f%%", pct) or string.format("%d%%", math.floor(pct))
	context = string.format(
		"⟦%s⟧ %s/%s %s",
		make_bar(pct),
		fmt_count(tokens),
		fmt_count(context_window),
		pct_label
	)
else
	context = "⟦" .. string.rep(" ", BAR_WIDTH) .. "⟧ warming up"
end

-- 4. Elapsed session time
local function fmt_elapsed(sec)
	local h = math.floor(sec / 3600)
	local m = math.floor((sec % 3600) / 60)
	local s = math.floor(sec % 60)
	if h > 0 then
		return string.format("%dh%02dm", h, m)
	end
	return string.format("%dm%02ds", m, s)
end

-- 5. Rotating quip, changes roughly every 20 ticks
local QUIPS = {
	"shipping bytes",
	"herding tokens",
	"compiling vibes",
	"context: plenty",
	"lua says hi",
	"no bugs, only surprises",
	"grep never lies",
	"tabs vs spaces: yes",
}
local quip = QUIPS[(math.floor(frame / 20) % #QUIPS) + 1]

print(table.concat({ spin, location, model, context, fmt_elapsed(elapsed), quip }, "|"))
