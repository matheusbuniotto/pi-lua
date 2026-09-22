/**
 * Plugin manager
 *
 * A declarative, lazy.nvim-style front end for pi's built-in package
 * manager. Instead of hand-editing settings.json or running `pi install`
 * one at a time, list every package you want in plugins.lua and run
 * `/plugins sync`: it diffs the manifest against what's installed and
 * installs/removes packages via the real `pi install` / `pi remove` CLI
 * (which still does all the actual git clone / npm install / settings.json
 * work -- this extension only decides *what* to install or remove).
 *
 * Manifest resolution (project wins if present):
 *   .pi/plugins.lua              (project scope)
 *   ~/.pi/agent/plugins.lua      (global scope, fallback)
 *
 * State tracking, so `sync` only ever removes packages *it* installed and
 * never touches something you added by hand with `pi install`:
 *   .pi/.plugin-manager-state.json
 *   ~/.pi/agent/.plugin-manager-state.json
 *
 * Commands:
 *   /plugins sync   Install/remove packages to match plugins.lua
 *   /plugins list   Show installed packages (pi list)
 *   /plugins edit   Print the manifest path to edit
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { luaScript, runLuaJson } from "./adapter.ts";

const EMIT_SCRIPT = luaScript("plugins-emit.lua");

// Package identity: npm/git/https/ssh sources are opaque strings pi already
// treats as stable identities. Local paths are the exception -- pi rewrites
// them to be relative to settings.json on disk, so a manifest's absolute
// path and the stored path never compare equal as raw strings. Normalizing
// both sides to an absolute path here mirrors pi's own identity rule for
// local packages (see docs/packages.md "Scope and Deduplication").
const SCHEME_RE = /^(npm|git|https?|ssh):/;
function normalizeSource(source: string, baseDir: string): string {
	return SCHEME_RE.test(source) ? source : resolve(baseDir, source);
}

interface Spec {
	source: string;
}

interface ManagerScope {
	manifestPath: string;
	statePath: string;
	local: boolean;
}

function resolveScope(cwd: string): ManagerScope {
	const projectManifest = join(cwd, ".pi", "plugins.lua");
	if (existsSync(projectManifest)) {
		return {
			manifestPath: projectManifest,
			statePath: join(cwd, ".pi", ".plugin-manager-state.json"),
			local: true,
		};
	}
	const globalDir = join(homedir(), ".pi", "agent");
	return {
		manifestPath: join(globalDir, "plugins.lua"),
		statePath: join(globalDir, ".plugin-manager-state.json"),
		local: false,
	};
}

async function readManagedState(statePath: string): Promise<string[]> {
	try {
		const raw = await readFile(statePath, "utf8");
		const data = JSON.parse(raw);
		return Array.isArray(data.managed) ? data.managed : [];
	} catch {
		return [];
	}
}

async function writeManagedState(statePath: string, managed: string[]) {
	await mkdir(dirname(statePath), { recursive: true });
	await writeFile(statePath, `${JSON.stringify({ managed }, null, 2)}\n`, "utf8");
}

async function readInstalledSources(cwd: string, local: boolean): Promise<Set<string>> {
	const settingsPath = local ? join(cwd, ".pi", "settings.json") : join(homedir(), ".pi", "agent", "settings.json");
	try {
		const raw = await readFile(settingsPath, "utf8");
		const data = JSON.parse(raw);
		const packages = Array.isArray(data.packages) ? data.packages : [];
		const settingsDir = dirname(settingsPath);
		return new Set(
			packages
				.map((p: unknown) => (typeof p === "string" ? p : (p as { source?: string } | undefined)?.source))
				.filter((s: unknown): s is string => typeof s === "string")
				.map((s: string) => normalizeSource(s, settingsDir)),
		);
	} catch {
		return new Set();
	}
}

export default function (pi: ExtensionAPI) {
	async function loadManifest(manifestPath: string, cwd: string): Promise<Spec[]> {
		return (await runLuaJson<Spec[]>(pi, EMIT_SCRIPT, [manifestPath], { cwd, timeout: 10_000 })) ?? [];
	}

	pi.registerCommand("plugins", {
		description: "Manage pi packages declaratively from plugins.lua (sync/list/edit)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sub = args.trim().split(/\s+/)[0] || "sync";
			const scope = resolveScope(ctx.cwd);

			if (sub === "edit") {
				ctx.ui.notify(`Manifest: ${scope.manifestPath}`, "info");
				return;
			}

			if (sub === "list") {
				const result = await pi.exec("pi", ["list"], { cwd: ctx.cwd, timeout: 15_000 });
				ctx.ui.notify(result.stdout.trim() || "No packages installed.", "info");
				return;
			}

			if (sub !== "sync") {
				ctx.ui.notify(`Unknown /plugins subcommand "${sub}". Use sync, list, or edit.`, "error");
				return;
			}

			if (!existsSync(scope.manifestPath)) {
				ctx.ui.notify(`No manifest at ${scope.manifestPath}. Create it, then run /plugins sync.`, "warning");
				return;
			}

			let specs: Spec[];
			try {
				specs = await loadManifest(scope.manifestPath, ctx.cwd);
			} catch (err) {
				ctx.ui.notify(`Failed to read plugins.lua: ${(err as Error).message}`, "error");
				return;
			}

			const manifestDir = dirname(scope.manifestPath);
			const desired = new Set(specs.map((s) => normalizeSource(s.source, manifestDir)));
			const installed = await readInstalledSources(ctx.cwd, scope.local);
			const previouslyManaged = new Set(await readManagedState(scope.statePath));

			const toInstall = [...desired].filter((s) => !installed.has(s));
			// Only remove packages this manifest installed before and no longer
			// declares. Never touch a package the user added by hand.
			const toRemove = [...previouslyManaged].filter((s) => !desired.has(s) && installed.has(s));

			if (toInstall.length === 0 && toRemove.length === 0) {
				ctx.ui.notify("Plugins already in sync.", "info");
				await writeManagedState(scope.statePath, [...desired]);
				return;
			}

			const localFlag = scope.local ? ["-l"] : [];
			const errors: string[] = [];

			for (const source of toInstall) {
				ctx.ui.notify(`Installing ${source}...`, "info");
				const result = await pi.exec("pi", ["install", source, ...localFlag], { cwd: ctx.cwd, timeout: 120_000 });
				if (result.code !== 0) errors.push(`install ${source}: ${result.stderr.trim() || result.stdout.trim()}`);
			}

			for (const source of toRemove) {
				ctx.ui.notify(`Removing ${source}...`, "info");
				const result = await pi.exec("pi", ["remove", source, ...localFlag], { cwd: ctx.cwd, timeout: 30_000 });
				if (result.code !== 0) errors.push(`remove ${source}: ${result.stderr.trim() || result.stdout.trim()}`);
			}

			await writeManagedState(scope.statePath, [...desired]);

			if (errors.length > 0) {
				ctx.ui.notify(`Sync finished with errors:\n${errors.join("\n")}`, "error");
			} else {
				ctx.ui.notify(
					`Synced: +${toInstall.length} installed, -${toRemove.length} removed. Run /reload to activate.`,
					"info",
				);
			}
		},
	});
}
