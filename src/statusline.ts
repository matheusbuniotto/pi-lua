/**
 * Lua statusline
 *
 * Renders a "cool" footer statusline whose content is computed by a Lua
 * script (lua/statusline.lua) instead of TypeScript. Every second the
 * extension gathers session state (frame counter, cwd, model, context
 * usage, elapsed time), hands it to the Lua interpreter as argv, and
 * themes the pipe-delimited segments it prints back:
 *
 *   ⠋ pi-mono (main) · sonnet-4.5 · ⟦████████▌           ⟧ 4.2k/262k 1.6% · 3m14s · lua says hi

 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { luaScript, runLua } from "./adapter.ts";

const SCRIPT = luaScript("statusline.lua");
const TICK_MS = 1000;
const STATUS_ID = "lua-statusline";

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frame = 0;
	let startedAt = Date.now();

	async function tick(ctx: ExtensionContext) {
		frame++;
		const usage = ctx.getContextUsage();
		// Pass raw counts, not a pre-rounded percent: for large context windows
		// (200k+) a whole-number percent barely moves for dozens of turns and
		// looks frozen. Lua formats an absolute token count instead, which is
		// always visibly increasing.
		const tokens = usage?.tokens != null ? String(usage.tokens) : "";
		const contextWindow = usage?.contextWindow != null ? String(usage.contextWindow) : "";
		const elapsedSec = String(Math.round((Date.now() - startedAt) / 1000));
		const model = ctx.model?.name ?? ctx.model?.id ?? "no-model";

		try {
			const { stdout } = await runLua(
				pi,
				SCRIPT,
				[String(frame), ctx.cwd, model, tokens, contextWindow, elapsedSec],
				{ cwd: ctx.cwd, timeout: 2000 },
			);

			const [spin, location, modelSeg, contextSeg, elapsedSeg, quip] = stdout.trim().split("|");
			if (!spin) return;

			const theme = ctx.ui.theme;
			// Traffic-light the context segment as it fills up. Computed here
			// (not in Lua) since only the extension has the theme's color names.
			const percent = usage?.percent ?? 0;
			const contextColor = percent >= 80 ? "error" : percent >= 50 ? "warning" : "success";

			const line = [
				theme.fg("accent", spin),
				theme.fg("toolTitle", location),
				theme.fg("muted", modelSeg),
				theme.fg(contextColor, contextSeg),
				theme.fg("dim", elapsedSeg),
				theme.fg("warning", quip),
			].join(theme.fg("dim", " · "));

			ctx.ui.setStatus(STATUS_ID, line);
		} catch {
			// Lua missing/erroring shouldn't spam the UI; skip this tick silently.
		}
	}

	function stop() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		startedAt = Date.now();
		frame = 0;
		stop();
		tick(ctx);
		timer = setInterval(() => tick(ctx), TICK_MS);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stop();
		ctx.ui.setStatus(STATUS_ID, undefined);
	});
}
