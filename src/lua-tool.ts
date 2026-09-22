/**
 * Lua tool
 *
 * Adds a `lua` tool so the model can write and run Lua scripts directly,
 * without shelling out through `bash` + heredocs. Useful for quick
 * prototyping, calculations, or testing Lua snippets/algorithms.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLua } from "./adapter.ts";

const TIMEOUT_MS = 30_000;

export default function (pi: ExtensionAPI) {
	const luaTool = defineTool({
		name: "lua",
		label: "Lua",
		description:
			"Run a Lua script with the system Lua interpreter and return its stdout/stderr. " +
			"Use this for quick Lua prototyping, calculations, or testing snippets instead of " +
			"writing a throwaway .lua file and invoking bash yourself.",
		promptSnippet: "Execute a Lua script and return its output",
		promptGuidelines: [
			"Use lua to run standalone Lua code snippets directly instead of writing a temp file and calling bash.",
		],
		parameters: Type.Object({
			code: Type.String({ description: "Lua source code to execute" }),
		}),

		async execute(_toolCallId, params, signal) {
			const dir = await mkdtemp(join(tmpdir(), "pi-lua-"));
			const scriptPath = join(dir, "script.lua");

			try {
				await writeFile(scriptPath, params.code, "utf8");
				const { stdout, stderr } = await runLua(pi, scriptPath, [], { signal, timeout: TIMEOUT_MS });
				const output = [stdout, stderr].filter(Boolean).join("\n").trim();

				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: { stdout, stderr },
				};
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	});

	pi.registerTool(luaTool);
}
