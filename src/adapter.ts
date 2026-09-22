/**
 * pi-lua adapter: the only TypeScript in this package.
 *
 * Starts one long-lived Lua process (lua/pi.lua) with every plugin file,
 * then bridges pi to it over JSON lines:
 *
 *   pi -> Lua (stdin)   events, tool calls, commands, timer ticks
 *   Lua -> pi (fd 3)    registrations, UI updates, errors, replies
 *
 * All behaviour lives in Lua plugins. This file never needs to change to
 * add a feature -- see README.md for the plugin API.
 *
 * Plugins are loaded from:
 *   <package>/lua/plugins/*.lua   (bundled)
 *   ~/.pi/agent/lua/*.lua         (your own; same name overrides a bundled one)
 *
 * `/pi-lua` opens a menu to enable/disable plugins, and each plugin's commands
 * and tools individually, saved in ~/.pi/agent/lua-pi.json.
 */

import { Type } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getSettingsListTheme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, type SettingItem, SettingsList, Text, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const LUA_BIN = process.env.LUA_BIN || "lua";
const LUA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "lua");
const RUNTIME = join(LUA_DIR, "pi.lua");
const BUNDLED_DIR = join(LUA_DIR, "plugins");
const USER_DIR = join(homedir(), ".pi", "agent", "lua");
const CONFIG_PATH = join(homedir(), ".pi", "agent", "lua-pi.json");

// Messages Lua sends back -----------------------------------------------------

type Span = [color: ThemeColor, text: string];
type Line = string | Span[];

interface ScreenState {
	lines: string[];
	tui?: TUI;
	done?: (value: unknown) => void;
	width?: number;
	height?: number;
}

/** Clamp a rendered line to exactly `width` visible columns. */
function fit(line: string, width: number): string {
	const w = visibleWidth(line);
	if (w > width) return truncateToWidth(line, width, "");
	if (w < width) return line + " ".repeat(width - w);
	return line;
}

interface ToolSpec {
	name: string;
	plugin: string;
	label?: string;
	description: string;
	snippet?: string;
	guidelines?: string[];
	parameters: { name: string; type: string; description?: string; optional: boolean }[];
}

interface Manifest {
	type: "ready";
	tools: ToolSpec[];
	commands: { name: string; plugin: string; description?: string }[];
	events: string[];
	timers: number[];
}

type LuaMessage =
	| Manifest
	| { type: "done"; id: number; result?: string; error?: string }
	| { type: "error"; message: string }
	| { type: "ui"; op: "notify"; message: string; level: "info" | "warning" | "error" }
	| { type: "ui"; op: "set_status"; key: string; line?: Line }
	| { type: "ui"; op: "set_widget"; key: string; lines?: Line[] }
	| { type: "ui"; op: "screen_open"; key: string; help?: string }
	| { type: "ui"; op: "screen_frame"; key: string; lines?: Line[] }
	| { type: "ui"; op: "screen_close"; key: string }
	| { type: "send"; text: string };

// The Lua process -------------------------------------------------------------

interface Pending {
	ctx: ExtensionContext;
	resolve: (result: string) => void;
	reject: (error: Error) => void;
}

class LuaRuntime {
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private reported = new Set<string>();
	private screens = new Map<string, ScreenState>();
	private lastCtx?: ExtensionContext;
	private stopped = false;
	private child: ChildProcess;
	private sendUserMessage: ExtensionAPI["sendUserMessage"];
	readonly ready: Promise<Manifest>;

	private constructor(child: ChildProcess, sendUserMessage: ExtensionAPI["sendUserMessage"]) {
		this.child = child;
		this.sendUserMessage = sendUserMessage;
		this.ready = new Promise((resolve, reject) => {
			const stderr: string[] = [];
			child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
			child.on("error", (err: NodeJS.ErrnoException) => {
				reject(
					err.code === "ENOENT"
						? new Error(`Lua interpreter "${LUA_BIN}" not found. Install it (brew install lua) or set LUA_BIN.`)
						: err,
				);
			});
			child.on("exit", (code) => {
				const reason = new Error(stderr.join("").trim() || `lua runtime exited with code ${code}`);
				reject(reason);
				if (!this.stopped && this.lastCtx?.hasUI) this.lastCtx.ui.notify(`pi-lua stopped: ${reason.message}`, "error");
				for (const request of this.pending.values()) request.reject(reason);
				this.pending.clear();
			});

			const lines = createInterface({ input: child.stdio[3] as Readable });
			lines.on("line", (line) => {
				let message: LuaMessage;
				try {
					message = JSON.parse(line);
				} catch {
					return; // not ours; the protocol only ever writes whole JSON lines
				}
				if (message.type === "ready") resolve(message);
				else this.handle(message);
			});
		});
	}

	static start(plugins: string[], sendUserMessage: ExtensionAPI["sendUserMessage"]): LuaRuntime {
		const child = spawn(LUA_BIN, [RUNTIME, ...plugins], { stdio: ["pipe", "ignore", "pipe", "pipe"] });
		return new LuaRuntime(child, sendUserMessage);
	}

	/** Send a message and wait for the Lua side to finish handling it. */
	request(ctx: ExtensionContext, message: Record<string, unknown>): Promise<string> {
		const id = this.nextId++;
		this.lastCtx = ctx;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { ctx, resolve, reject });
			(this.child.stdin as Writable).write(`${JSON.stringify({ ...message, id, ctx: snapshot(ctx) })}\n`);
		});
	}

	stop() {
		this.stopped = true;
		this.child.kill();
	}

	private handle(message: Exclude<LuaMessage, Manifest>) {
		if (message.type === "done") {
			const request = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) request?.reject(new Error(message.error));
			else request?.resolve(message.result ?? "");
			return;
		}

		// Lua handles one message at a time, so UI updates belong to the
		// oldest request still in flight.
		const ctx = this.pending.values().next().value?.ctx ?? this.lastCtx;

		if (message.type === "send") {
			// Lua is mid-callback, so the agent is often busy: queue behind it.
			const idle = ctx?.isIdle() ?? true;
			this.sendUserMessage(message.text, idle ? undefined : { deliverAs: "followUp" });
			return;
		}

		if (!ctx?.hasUI) return;

		if (message.type === "error") {
			// Timers would repeat the same error every tick; show it once.
			if (this.reported.has(message.message)) return;
			this.reported.add(message.message);
			ctx.ui.notify(message.message, "error");
		} else if (message.op === "notify") {
			ctx.ui.notify(message.message, message.level);
		} else if (message.op === "set_status") {
			ctx.ui.setStatus(message.key, message.line === undefined ? undefined : paint(ctx, message.line));
		} else if (message.op === "set_widget") {
			ctx.ui.setWidget(message.key, message.lines?.map((line) => paint(ctx, line)));
		} else if (message.op === "screen_open") {
			this.openScreen(message.key, ctx);
		} else if (message.op === "screen_frame") {
			const state = this.screens.get(message.key);
			if (state) {
				state.lines = (message.lines ?? []).map((line) => paint(ctx, line));
				state.tui?.requestRender();
			}
		} else if (message.op === "screen_close") {
			this.screens.get(message.key)?.done?.(undefined);
		}
	}

	/**
	 * Open a full-screen surface on behalf of a Lua plugin. The TUI component
	 * only stores frames pushed from Lua; animation timing lives in the plugin.
	 * Rendered lines may contain raw ANSI, so Lua can paint its own palette.
	 */
	private openScreen(key: string, ctx: ExtensionContext): void {
		if (this.screens.has(key)) return;
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Full-screen Lua UI needs the interactive TUI", "error");
			return;
		}

		const state: ScreenState = { lines: [] };
		this.screens.set(key, state);

		void ctx.ui
			.custom<void>((tui, _theme, _keybindings, done) => {
				state.tui = tui;
				state.done = done;
				return {
					render: (width: number) => {
						const cols = tui.terminal ? tui.terminal.columns : width;
						const rows = tui.terminal ? tui.terminal.rows : state.lines.length;
						if (state.width !== cols || state.height !== rows) {
							state.width = cols;
							state.height = rows;
							void this.request(ctx, { type: "screen", op: "resize", screen: key, width: cols, height: rows }).catch(() => {});
						}
						return state.lines.map((line) => fit(line, width));
					},
					handleInput: (data: string) => {
						if (matchesKey(data, "escape") || data === "q" || data === "Q") {
							done(undefined);
							return;
						}
						void this.request(ctx, { type: "screen", op: "key", screen: key, key: data }).catch(() => {});
					},
					invalidate: () => {},
				};
			})
			.then(() => {
				this.screens.delete(key);
				void this.request(ctx, { type: "screen", op: "closed", screen: key }).catch(() => {});
			})
			.catch(() => {
				this.screens.delete(key);
			});
	}
}

// What Lua sees as `ctx`.
function snapshot(ctx: ExtensionContext) {
	const usage = ctx.getContextUsage();
	return {
		cwd: ctx.cwd,
		session_file: ctx.sessionManager.getSessionFile(),
		model: ctx.model?.name ?? ctx.model?.id,
		has_ui: ctx.hasUI,
		context: usage && { tokens: usage.tokens, window: usage.contextWindow, percent: usage.percent },
	};
}

function paint(ctx: ExtensionContext, line: Line): string {
	if (typeof line === "string") return line;
	return line.map(([color, text]) => ctx.ui.theme.fg(color, text)).join("");
}

function toSchema(parameters: ToolSpec["parameters"]) {
	const properties: Record<string, unknown> = {};
	for (const { name, type, description } of parameters) properties[name] = { type, description };
	const required = parameters.filter((p) => !p.optional).map((p) => p.name);
	return Type.Unsafe<Record<string, unknown>>({ type: "object", properties, required });
}

// Plugins and the /pi-lua menu ---------------------------------------------------

interface Plugin {
	name: string;
	path: string;
	bundled: boolean;
}

async function findPlugins(): Promise<Plugin[]> {
	const byName = new Map<string, Plugin>();
	for (const [dir, bundled] of [
		[BUNDLED_DIR, true],
		[USER_DIR, false],
	] as const) {
		if (!existsSync(dir)) continue;
		for (const file of (await readdir(dir)).filter((f) => f.endsWith(".lua")).sort()) {
			const name = basename(file, ".lua");
			byName.set(name, { name, path: join(dir, file), bundled }); // yours override bundled ones
		}
	}
	return [...byName.values()];
}

// What the user switched off. Commands and tools can be disabled on their
// own, e.g. keep a plugin's widget but drop its slash command.
interface Config {
	disabled: string[];
	disabledCommands: string[];
	disabledTools: string[];
}

async function readConfig(): Promise<Config> {
	let raw: Partial<Config> = {};
	try {
		raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
	} catch {
		// no config yet: everything is on
	}
	const list = (value: unknown) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
	return {
		disabled: list(raw.disabled),
		disabledCommands: list(raw.disabledCommands),
		disabledTools: list(raw.disabledTools),
	};
}

async function writeConfig(config: Config) {
	const sorted = {
		disabled: [...config.disabled].sort(),
		disabledCommands: [...config.disabledCommands].sort(),
		disabledTools: [...config.disabledTools].sort(),
	};
	await writeFile(CONFIG_PATH, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

// The menu tracks everything as one set of ids: "plugin:x", "command:x", "tool:x".
function toIds(config: Config): Set<string> {
	return new Set([
		...config.disabled.map((n) => `plugin:${n}`),
		...config.disabledCommands.map((n) => `command:${n}`),
		...config.disabledTools.map((n) => `tool:${n}`),
	]);
}

function fromIds(ids: Set<string>): Config {
	const pick = (kind: string) => [...ids].filter((id) => id.startsWith(`${kind}:`)).map((id) => id.slice(kind.length + 1));
	return { disabled: pick("plugin"), disabledCommands: pick("command"), disabledTools: pick("tool") };
}

// Each plugin, with the commands and tools it registered indented below it.
// Plugins that aren't loaded can't report theirs; enable one to see them.
// `parentOf` maps each command/tool row to its plugin row.
function menuItems(plugins: Plugin[], manifest: Manifest | undefined, off: Set<string>) {
	const parentOf = new Map<string, string>();
	const toggle = (id: string, label: string, description: string, parent?: string): SettingItem => {
		if (parent) parentOf.set(id, parent);
		const isOff = off.has(id) || (parent !== undefined && off.has(parent));
		return { id, label, description, currentValue: isOff ? "off" : "on", values: ["on", "off"] };
	};

	const items = plugins.flatMap((plugin) => {
		const id = `plugin:${plugin.name}`;
		const source = plugin.bundled ? "bundled" : `yours: ${plugin.path}`;
		const commands = manifest?.commands.filter((c) => c.plugin === plugin.name) ?? [];
		const tools = manifest?.tools.filter((t) => t.plugin === plugin.name) ?? [];
		return [
			toggle(id, plugin.name, source),
			...commands.map((c) => toggle(`command:${c.name}`, `  /${c.name}`, c.description || "command", id)),
			...tools.map((t) => toggle(`tool:${t.name}`, `  ${t.name} (tool)`, t.description, id)),
		];
	});

	return { items, parentOf };
}

// One dialog that toggles in place (reopening a select per toggle makes the
// screen blink). Closing it saves and reloads, but only if something changed.
//
// Turning a plugin off shows its commands and tools as off too, since they
// go away with it. Their own settings are kept, so turning the plugin back
// on restores them as they were.
async function openMenu(plugins: Plugin[], manifest: Manifest | undefined, ctx: ExtensionCommandContext) {
	const off = toIds(await readConfig());
	const initial = [...off].sort().join();

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const { items, parentOf } = menuItems(plugins, manifest, off);
		const childrenOf = (parent: string) => [...parentOf].filter(([, p]) => p === parent).map(([child]) => child);

		const list = new SettingsList(
			items,
			Math.min(items.length + 2, 20),
			getSettingsListTheme(),
			(id, value) => {
				const parent = parentOf.get(id);
				if (parent && off.has(parent)) {
					list.updateValue(id, "off"); // can't turn on a command whose plugin is off
					return;
				}

				if (value === "off") off.add(id);
				else off.delete(id);

				for (const child of childrenOf(id)) {
					list.updateValue(child, value === "off" || off.has(child) ? "off" : "on");
				}
			},
			() => done(),
		);

		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Lua plugins")), 1, 1));
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "changes apply when you close (pi reloads)"), 1, 1));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput?.(data);
				tui.requestRender();
			},
		};
	});

	if ([...off].sort().join() === initial) return;
	await writeConfig(fromIds(off));
	await ctx.reload();
}

// pi extension ------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	const plugins = await findPlugins();
	const config = await readConfig();
	let manifest: Manifest | undefined;

	pi.registerCommand("pi-lua", {
		description: "Enable or disable Lua plugins and their commands and tools",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") ctx.ui.notify("/pi-lua needs the interactive TUI", "error");
			else if (plugins.length === 0) ctx.ui.notify(`No Lua plugins found. Add some to ${USER_DIR}.`, "info");
			else await openMenu(plugins, manifest, ctx);
		},
	});

	const lua = LuaRuntime.start(
		plugins.filter((p) => !config.disabled.includes(p.name)).map((p) => p.path),
		(content, options) => pi.sendUserMessage(content, options),
	);

	try {
		manifest = await lua.ready;
	} catch (err) {
		pi.on("session_start", async (_event, ctx) => ctx.ui.notify(`pi-lua: ${(err as Error).message}`, "error"));
		return;
	}

	for (const tool of manifest.tools) {
		if (config.disabledTools.includes(tool.name)) continue;
		pi.registerTool({
			name: tool.name,
			label: tool.label ?? tool.name,
			description: tool.description,
			promptSnippet: tool.snippet,
			promptGuidelines: tool.guidelines,
			parameters: toSchema(tool.parameters),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const text = await lua.request(ctx, { type: "tool", name: tool.name, params });
				return { content: [{ type: "text", text: text || "(no output)" }], details: {} };
			},
		});
	}

	for (const command of manifest.commands) {
		if (config.disabledCommands.includes(command.name)) continue;
		pi.registerCommand(command.name, {
			description: command.description ?? "",
			handler: async (args, ctx) => {
				await lua.request(ctx, { type: "command", name: command.name, args });
			},
		});
	}

	for (const name of manifest.events) {
		pi.on(name as "turn_end", async (event, ctx) => {
			// Plugin errors are reported by Lua itself; this only fails if the runtime is gone.
			await lua.request(ctx, { type: "event", name, event }).catch(() => {});
		});
	}

	const intervals: ReturnType<typeof setInterval>[] = [];

	const { timers } = manifest;
	pi.on("session_start", async (_event, ctx) => {
		timers.forEach((ms, index) => {
			let busy = false;
			intervals.push(
				setInterval(async () => {
					if (busy) return; // never queue ticks behind a slow one
					busy = true;
					await lua.request(ctx, { type: "timer", timer: index + 1 }).catch(() => {});
					busy = false;
				}, ms),
			);
		});
	});

	pi.on("session_shutdown", async () => {
		for (const interval of intervals) clearInterval(interval);
		lua.stop();
	});
}
