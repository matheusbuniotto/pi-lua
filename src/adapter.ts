/**
 * Lua adapter: the single place where TypeScript talks to Lua.
 *
 * Every extension in this package runs Lua the same way: spawn the
 * interpreter on a script, pass input as argv, read stdout back. Keeping
 * that here means extensions stay thin and the Lua scripts stay plain,
 * dependency-free Lua you can run by hand from a terminal.
 *
 * Interpreter: `lua` on PATH, overridable with LUA_BIN (e.g. LUA_BIN=luajit).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LUA_BIN = process.env.LUA_BIN || "lua";

const LUA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "lua");

export interface LuaOutput {
	stdout: string;
	stderr: string;
}

export interface RunLuaOptions {
	cwd?: string;
	timeout?: number;
	signal?: AbortSignal;
}

/** Absolute path to a script in this package's lua/ directory. */
export function luaScript(name: string): string {
	return join(LUA_DIR, name);
}

/**
 * Run a Lua script and return what it printed.
 *
 * Throws with a readable message when the interpreter is missing, the
 * script times out, or it exits non-zero (stderr becomes the message).
 */
export async function runLua(
	pi: ExtensionAPI,
	script: string,
	args: string[] = [],
	options: RunLuaOptions = {},
): Promise<LuaOutput> {
	await ensureInterpreter(pi);

	const result = await pi.exec(LUA_BIN, [script, ...args], options);

	if (result.killed) {
		throw new Error(`${LUA_BIN} was stopped (timeout or abort) while running ${script}`);
	}
	if (result.code !== 0) {
		const output = [result.stderr, result.stdout].map((s) => s.trim()).find(Boolean);
		throw new Error(output || `${LUA_BIN} exited with code ${result.code}`);
	}
	return { stdout: result.stdout, stderr: result.stderr };
}

/** Run a Lua script that prints a single JSON value, and parse it. */
export async function runLuaJson<T>(
	pi: ExtensionAPI,
	script: string,
	args: string[] = [],
	options: RunLuaOptions = {},
): Promise<T> {
	const { stdout } = await runLua(pi, script, args, options);
	return JSON.parse(stdout.trim() || "null");
}

// pi.exec never throws: a missing binary just looks like "exit 1, no
// output", which is indistinguishable from a silently failing script.
// Probe once with `lua -v` so we can give an actionable error instead.
let interpreterCheck: Promise<void> | undefined;

function ensureInterpreter(pi: ExtensionAPI): Promise<void> {
	interpreterCheck ??= pi.exec(LUA_BIN, ["-v"], { timeout: 5_000 }).then((result) => {
		if (result.code !== 0) {
			interpreterCheck = undefined; // allow a retry after the user installs Lua
			throw new Error(
				`Lua interpreter "${LUA_BIN}" not found. Install it with \`brew install lua\` ` +
					"or set LUA_BIN (e.g. LUA_BIN=luajit).",
			);
		}
	});
	return interpreterCheck;
}
