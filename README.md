# pi-lua

Lua-powered extensions for [pi](https://pi.dev). TypeScript does the wiring; the logic lives in plain Lua you can hack on without touching TypeScript.

| Extension | What it does |
|-----------|--------------|
| `src/lua-tool.ts` | `lua` tool: the model runs Lua snippets directly |
| `src/statusline.ts` | Footer statusline rendered by `lua/statusline.lua` |
| `src/plugin-manager.ts` | `/plugins sync\|list\|edit`: declarative packages from `plugins.lua` |

## Install

Requires Lua on PATH (`brew install lua`). Set `LUA_BIN=luajit` to use another interpreter.

```sh
pi install npm:pi-lua
```

Or drop this folder into `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project) and run `/reload`.

## Layout

```
src/adapter.ts   the only code that spawns Lua -- use it, don't call pi.exec yourself
src/*.ts         one pi extension per file, listed in package.json "pi.extensions"
lua/*.lua        the scripts; each is runnable standalone from a terminal
```

## The TS <-> Lua contract

Every script follows the same rules, so each side can be worked on independently:

- **Input** is argv (`arg[1]`, `arg[2]`, ...). Document the order in the script's header comment.
- **Output** is stdout: either a single JSON value (read with `runLuaJson`) or a simple line format (read with `runLua`).
- **Errors** go to stderr with a non-zero exit (`os.exit(1)`). The adapter turns that into a thrown `Error` with the stderr text.
- **No dependencies.** Stock Lua 5.1+/LuaJIT only, so a fresh `brew install lua` is enough.

```ts
import { luaScript, runLua, runLuaJson } from "./adapter.ts";

const { stdout } = await runLua(pi, luaScript("statusline.lua"), [String(frame), cwd], { timeout: 2000 });
const specs = await runLuaJson<Spec[]>(pi, luaScript("plugins-emit.lua"), [manifestPath]);
```

The adapter also resolves `LUA_BIN`, reports a missing interpreter clearly, and surfaces timeouts.

## Contributing

Adding a Lua-backed feature:

1. Write `lua/<name>.lua` following the contract above, and test it by hand:
   ```sh
   lua lua/statusline.lua 3 "$PWD" sonnet 4200 262000 194
   lua lua/plugins-emit.lua ~/.pi/agent/plugins.lua
   ```
2. Write `src/<name>.ts` that calls it through `adapter.ts`.
3. Add the entry to `package.json` under `pi.extensions`.
4. Run `npm run check` (syntax-checks every Lua script), then `/reload` in pi and try it.

Changing an existing script's argv or output format? Update its header comment and the TS caller in the same change.
