# Building pi-lua plugins

This guide builds one plugin from scratch: **focus**, a timer that counts down in pi's footer, counts turns while it runs, lets the model check how much time is left, and opens a full-screen view. Each step adds one feature of the plugin API.

The finished plugin is in [`focus.lua`](focus.lua). For a quick list of every function, see the [API section of the README](../README.md#api).

## Before you start

- pi-lua installed (`pi install npm:pi-lua`) and Lua on your PATH (`lua -v`).
- Plugins live in **`~/.pi/agent/lua/`**. Every `.lua` file there is loaded when pi starts or when you run `/reload`.

That's all. There's no TypeScript, no build step and no package.json.

```sh
mkdir -p ~/.pi/agent/lua
$EDITOR ~/.pi/agent/lua/focus.lua
```

## Step 1: a command

Every plugin starts by requiring the `pi` API and registering something:

```lua
local pi = require("pi")

pi.command({
	name = "focus",
	description = "Start a focus timer: /focus [minutes]",
	handler = function(args, ctx)
		local minutes = tonumber(args) or 25
		ctx.ui.notify("Focus for " .. minutes .. " minutes. Go!")
	end,
})
```

Run `/reload`, then type `/focus 10`.

- `args` is everything typed after the command name, as one string. Here it's `"10"`.
- `ctx` is passed to every callback. `ctx.ui` is how you draw, and `ctx.cwd` and `ctx.model` tell you about the session. The full list is in the [README](../README.md#api).
- `/pi-lua` now lists `focus` with `/focus` underneath, so users can switch the command off.

## Step 2: a timer that draws in the footer

Plugins keep state in ordinary local variables. `pi.every(ms, fn)` runs `fn` repeatedly while a session is open:

```lua
local KEY = "focus"
local ends_at -- os.time() when the session ends; nil when idle

local function clock(seconds)
	return string.format("%02d:%02d", math.floor(seconds / 60), seconds % 60)
end

-- in the /focus handler:  ends_at = os.time() + minutes * 60

pi.every(1000, function(ctx)
	if not ends_at then
		return
	end
	local left = math.max(0, ends_at - os.time())
	local color = left < 60 and "warning" or "accent"
	ctx.ui.set_status(KEY, {
		{ color, "◷ " .. clock(left) },
		{ "dim", "  focus" },
	})
end)
```

**Drawing.** There are three places a plugin can draw:

| Call | Where it shows |
|------|----------------|
| `ctx.ui.set_status(key, line)` | one line in the footer |
| `ctx.ui.set_widget(key, lines)` | lines above the editor (see `lua/plugins/dashboard.lua`) |
| `ctx.ui.notify(message, level)` | a one-off message (`"info"`, `"warning"`, `"error"`) |

The `key` lets you update or clear your own line later; pass `nil` to clear it. A **line** is a plain string or a list of `{ color, text }` spans. Colors are pi theme names, so your plugin matches whatever theme the user has: `accent`, `muted`, `dim`, `text`, `success`, `warning`, `error`, `toolTitle`, and the rest of pi's theme colors.

## Step 3: react to events

`pi.on(event, fn)` runs `fn(event, ctx)` whenever pi fires that event. Here we count finished turns and clean up on exit:

```lua
local turns = 0

pi.on("turn_end", function()
	if ends_at then
		turns = turns + 1
	end
end)

pi.on("session_shutdown", function(_, ctx)
	ctx.ui.set_status(KEY, nil)
end)
```

Some useful events and their payload fields:

| Event | Fires when | Payload |
|-------|------------|---------|
| `session_start` | pi starts, reloads, or switches session | `reason`: `"startup"`, `"reload"`, `"new"`, `"resume"` or `"fork"` |
| `session_shutdown` | before the session closes or reloads | `reason` |
| `input` | the user submits a prompt | `text` |
| `turn_start` / `turn_end` | one model reply plus its tool calls | `turnIndex`; `turn_end` also has `message` |
| `message_end` | any message is finished | `message` (`role`, `content`, `usage.output`, `stopReason`) |
| `tool_execution_start` / `_end` | a tool runs | `toolName`, `args`; `_end` also has `isError` |
| `agent_start` / `agent_end` | the model starts or stops working on a prompt | |
| `model_select` | the model changes | `model` |

Payloads are pi's own event objects decoded from JSON. The full list of events is in [pi's extension docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#events). Two limits:

- **Handlers can only watch events.** Return values are ignored, so a Lua plugin can't block or rewrite a tool call or an input.
- **Avoid `message_update`.** It fires for every streamed token and will keep the runtime busy.

## Step 4: a tool the model can call

Tools are how the model uses your plugin. Give it a clear `description`: that's what the model reads when deciding whether to call the tool.

```lua
pi.tool({
	name = "focus_status",
	label = "Focus",
	description = "Check the user's focus timer: whether one is running and how much time is left.",
	execute = function(params, ctx)
		if not ends_at then
			return "No focus session is running."
		end
		return clock(math.max(0, ends_at - os.time())) .. " left in the focus session."
	end,
})
```

Ask the model "how long is left on my focus timer?" and it will call `focus_status`.

- **Parameters.** Declare them as `name = { type, description, optional }`:
  ```lua
  parameters = {
  	minutes = { type = "number", description = "Length of the session" },
  	label = { type = "string", description = "What you're focusing on", optional = true },
  },
  ```
  `params.minutes` then holds what the model sent. Types are JSON Schema types: `string`, `number`, `integer`, `boolean`.
- **Return value.** Return a string. It's what the model sees.
- **Errors.** Call `error("message")` to fail the tool call. The model sees the message and can try again.
- **Optional extras.** `snippet` is a one-line summary for pi's system prompt, and `guidelines` is a list of usage hints. See `lua/plugins/lua-tool.lua`.

## Step 5: a full-screen view

`pi.screen` takes over the whole terminal until the user presses `q` or Esc. Open it from a command; pi-lua then reports the terminal size, and you push frames:

```lua
local SCREEN = "focus-screen"
local width, height = 80, 24

local function draw(ctx)
	local lines = {}
	for row = 1, height do
		lines[row] = ""
	end
	local text = "◷ " .. clock(math.max(0, (ends_at or os.time()) - os.time()))
	lines[math.floor(height / 2)] = { { "accent", string.rep(" ", math.floor((width - #text) / 2)) .. text } }
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
			on_resize = function(w, h, ctx) width, height = w, h; draw(ctx) end,
			on_key = function(key, ctx) end,  -- every key except q/Esc
			on_close = function() screen_open = false end,
		})
	end,
})

pi.every(1000, function(ctx)
	if screen_open then
		draw(ctx)
	end
end)
```

- Frames use the same line format as the rest of the UI. Plain strings may also contain raw ANSI escape codes if you want your own colors.
- Animate with `pi.every`. About 70 ms per frame is smooth enough without keeping the runtime busy.
- Close it yourself with `ctx.ui.close_screen(SCREEN)`.

## Keeping state

- **Local variables are lost on `/reload`**, and pi also reloads when the session changes. That's fine for a timer. For anything else, choose where the state lives:
  - **Per session:** read `ctx.session_file` (one JSON object per line) in `session_start`. That's how the dashboard rebuilds its stats; see `replay` in `lua/plugins/dashboard.lua`.
  - **Across sessions:** write your own file, for example `os.getenv("HOME") .. "/.pi/agent/focus.json"`, using the bundled JSON module:
    ```lua
    local json = require("json")
    local file = io.open(path, "w"); file:write(json.encode(data)); file:close()
    ```
- **The whole Lua standard library is available.** `io`, `os` and `io.popen` all work, so you can read files or run `git` from a plugin.

## Debugging

- **Errors show up as a notification** tagged with the plugin name, like `[focus] focus.lua:42: attempt to index a nil value`. Each distinct error is shown once, so a broken timer won't spam you. Fix the file and `/reload`.
- **`print` goes nowhere.** stdout is discarded. Use `ctx.ui.notify` while debugging.
- **Test your logic outside pi.** Keep the logic in plain functions and return them at the end of the file. pi-lua ignores a plugin's return value, but a test can use it:
  ```lua
  return { clock = clock }
  ```
  ```sh
  lua -e 'package.preload.pi = function() return setmetatable({}, { __index = function() return function() end end }) end
          local focus = dofile(os.getenv("HOME") .. "/.pi/agent/lua/focus.lua")
          assert(focus.clock(90) == "01:30"); print("ok")'
  ```
- **Check syntax** with `luac -p ~/.pi/agent/lua/*.lua`.

## Rules of thumb

- **All plugins share one Lua process** and run one callback at a time. A slow callback, like a long `io.popen` or a heavy loop, freezes every other plugin until it's done. Keep timers cheap and don't block.
- **Names are global.** Command and tool names must not clash with pi's own or other plugins'. Prefix them if in doubt.
- **Clean up on `session_shutdown`.** Clear your status lines and widgets there.
- **Replacing a bundled plugin.** A file in `~/.pi/agent/lua/` with the same name as a bundled plugin replaces it. Copy `dashboard.lua` there to customize it.

## Sharing your plugin

A plugin is a single file, so sharing is easy:

- **Gist or repo:** others download it into `~/.pi/agent/lua/` and run `/reload`.
- **Proposing a new bundled example:** open a pull request against [pi-lua](https://github.com/matheusbuniotto/pi-lua). The bundled set is kept small, so it has to show something the existing examples don't.
