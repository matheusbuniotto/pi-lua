-- focus.lua: a focus timer for pi, built step by step in docs/plugins.md.
--
--   /focus 25     start a 25-minute focus session (default 25)
--   /focus        stop it
--
-- While it runs, the footer counts down, finished turns are counted, and
-- the model can check the time left with the `focus_status` tool.
--
-- Install: copy to ~/.pi/agent/lua/focus.lua and run /reload.

local pi = require("pi")

local KEY = "focus"

local ends_at -- os.time() when the session ends; nil when idle
local turns = 0 -- turns finished during this session

local function remaining()
	return ends_at and math.max(0, ends_at - os.time()) or 0
end

local function clock(seconds)
	return string.format("%02d:%02d", math.floor(seconds / 60), seconds % 60)
end

local function stop(ctx, message)
	ends_at = nil
	ctx.ui.set_status(KEY, nil)
	ctx.ui.notify(message)
end

-- Step 1: a command -----------------------------------------------------------

pi.command({
	name = "focus",
	description = "Start a focus timer: /focus [minutes]. Run it again to stop.",
	handler = function(args, ctx)
		if ends_at then
			return stop(ctx, "Focus stopped.")
		end
		local minutes = tonumber(args) or 25
		ends_at = os.time() + minutes * 60
		turns = 0
		ctx.ui.notify(string.format("Focus for %d minutes. Go!", minutes))
	end,
})

-- Step 2: a timer that draws in the footer ----------------------------------

pi.every(1000, function(ctx)
	if not ends_at then
		return
	end

	local left = remaining()
	if left == 0 then
		return stop(ctx, string.format("Focus done after %d turns. Take a break.", turns))
	end

	local color = left < 60 and "warning" or "accent"
	ctx.ui.set_status(KEY, {
		{ color, "◷ " .. clock(left) },
		{ "dim", "  focus · " .. turns .. " turns" },
	})
end)

-- Step 3: react to events -------------------------------------------------------

pi.on("turn_end", function()
	if ends_at then
		turns = turns + 1
	end
end)

pi.on("session_shutdown", function(_, ctx)
	ctx.ui.set_status(KEY, nil)
end)

-- Step 4: a tool the model can call -------------------------------------------

pi.tool({
	name = "focus_status",
	label = "Focus",
	description = "Check the user's focus timer: whether one is running and how much time is left.",
	execute = function()
		if not ends_at then
			return "No focus session is running."
		end
		return string.format("%s left in the focus session, %d turns so far.", clock(remaining()), turns)
	end,
})

-- Step 5: a full-screen view ---------------------------------------------------

local SCREEN = "focus-screen"
local width, height = 80, 24

local function draw(ctx)
	local lines = {}
	for row = 1, height do
		lines[row] = ""
	end

	local text = ends_at and ("◷ " .. clock(remaining())) or "no focus session"
	local hint = "q to close"
	local middle = math.floor(height / 2)
	lines[middle] = { { "accent", string.rep(" ", math.floor((width - #text) / 2)) .. text } }
	lines[middle + 2] = { { "dim", string.rep(" ", math.floor((width - #hint) / 2)) .. hint } }

	ctx.ui.set_screen(SCREEN, lines)
end

local screen_open = false

pi.command({
	name = "focus-view",
	description = "Show the focus timer full screen",
	handler = function()
		screen_open = true
		pi.screen({
			key = SCREEN,
			on_resize = function(w, h, ctx)
				width, height = w, h
				draw(ctx)
			end,
			on_close = function()
				screen_open = false
			end,
		})
	end,
})

pi.every(1000, function(ctx)
	if screen_open then
		draw(ctx)
	end
end)

-- pi-lua ignores the return value; tests can use it (see "Debugging" in plugins.md)
return { clock = clock, remaining = remaining }
