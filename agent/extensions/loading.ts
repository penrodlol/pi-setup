/**
 * loading — Claude Code-style working indicator for pi.
 *
 *   ✻ Pondering… (12s · ↓ 1.2k tokens · esc to interrupt)
 *
 * - Spinner: · ✢ ✳ ✶ ✻ ✽ pulsing back and forth in the theme's accent colour.
 * - Message: a random verb per request, with a lighter accent shimmer sweeping across it.
 * - Suffix: elapsed time, output tokens (live estimate while streaming,
 *   exact once each response finishes), and the interrupt key.
 *
 * /loading toggles between this and pi's default indicator.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";

const TICK_MS = 120;
/** How far the shimmer lightens the accent toward white (0–1). */
const SHIMMER_LIGHTEN = 0.4;

const RESET_FG = "\x1b[39m";
const BOLD_OFF = "\x1b[22m";

const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽"];
const PINGPONG = [...GLYPHS, ...GLYPHS.slice(1, -1).reverse()];

/** Accent colour from the active theme, plus a lighter variant for the shimmer. */
function accentColors(theme: Theme): { base: string; highlight: string } {
	const base = theme.getFgAnsi("accent");
	const m = base.match(/38;2;(\d+);(\d+);(\d+)/);
	if (!m) return { base, highlight: `${base}\x1b[1m` }; // 256-colour theme: bold instead
	const [r, g, b] = m.slice(1).map((v) => {
		const n = Number(v);
		return Math.round(n + (255 - n) * SHIMMER_LIGHTEN);
	});
	return { base, highlight: `\x1b[38;2;${r};${g};${b}m` };
}

const VERBS = [
	"Accomplishing", "Actualizing", "Baking", "Brewing", "Calculating", "Cerebrating", "Churning",
	"Clauding", "Coalescing", "Cogitating", "Computing", "Conjuring", "Considering", "Cooking",
	"Crafting", "Creating", "Crunching", "Deliberating", "Determining", "Finagling", "Forging",
	"Generating", "Hatching", "Herding", "Honking", "Hustling", "Ideating", "Inferring",
	"Manifesting", "Marinating", "Moseying", "Mulling", "Mustering", "Musing", "Noodling",
	"Percolating", "Pondering", "Processing", "Puttering", "Reticulating", "Ruminating",
	"Schlepping", "Shucking", "Simmering", "Smooshing", "Spinning", "Stewing", "Synthesizing",
	"Thinking", "Transmuting", "Vibing", "Working",
];

function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

/** Colour text in the accent colour with a 3-character highlight at `pos`. */
function shimmer(text: string, pos: number, theme: Theme): string {
	const { base, highlight } = accentColors(theme);
	const chars = [...text];
	let out = "";
	let current = "";
	for (let i = 0; i < chars.length; i++) {
		const color = Math.abs(i - pos) <= 1 ? highlight : base;
		if (color !== current) {
			out += color === base ? BOLD_OFF + base : color;
			current = color;
		}
		out += chars[i];
	}
	return out + BOLD_OFF + RESET_FG;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let ticker: ReturnType<typeof setInterval> | undefined;

	let verb = "Thinking";
	let startedAt = 0;
	let tick = 0;
	let finishedTokens = 0; // exact output tokens from completed responses
	let streamingChars = 0; // chars streamed in the current response (estimate)

	const stopTicker = () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	};

	const render = (ctx: ExtensionContext) => {
		const label = `${verb}…`;
		// Sweep the highlight across the text, then pause off-screen for a beat.
		const pos = (tick % (label.length + 8)) - 2;
		const seconds = Math.floor((Date.now() - startedAt) / 1000);
		const tokens = finishedTokens + Math.round(streamingChars / 4);

		const parts = [`${seconds}s`];
		if (tokens > 0) parts.push(`↓ ${formatTokens(tokens)} tokens`);
		parts.push(`${keyText("app.interrupt") || "esc"} to interrupt`);

		ctx.ui.setWorkingMessage(`${shimmer(label, pos, ctx.ui.theme)} ${ctx.ui.theme.fg("dim", `(${parts.join(" · ")})`)}`);
	};

	const setSpinner = (ctx: ExtensionContext) =>
		ctx.ui.setWorkingIndicator({
			frames: PINGPONG.map((g) => ctx.ui.theme.fg("accent", g)),
			intervalMs: TICK_MS,
		});

	const apply = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		if (enabled) {
			setSpinner(ctx);
		} else {
			stopTicker();
			ctx.ui.setWorkingIndicator(undefined);
			ctx.ui.setWorkingMessage(undefined);
		}
	};

	pi.on("session_start", (_event, ctx) => apply(ctx));
	pi.on("session_shutdown", () => stopTicker());

	pi.on("agent_start", (_event, ctx) => {
		if (!enabled || ctx.mode !== "tui") return;
		verb = VERBS[Math.floor(Math.random() * VERBS.length)]!;
		startedAt = Date.now();
		tick = 0;
		finishedTokens = 0;
		streamingChars = 0;
		setSpinner(ctx); // re-read the theme in case it changed
		render(ctx);
		stopTicker();
		ticker = setInterval(() => {
			tick++;
			render(ctx);
		}, TICK_MS);
		ticker.unref?.();
	});

	pi.on("message_update", (event) => {
		const e = event.assistantMessageEvent as any;
		if (typeof e?.delta === "string") streamingChars += e.delta.length;
	});

	pi.on("message_end", (event) => {
		const msg = event.message as any;
		if (msg?.role !== "assistant") return;
		finishedTokens += msg.usage?.output ?? Math.round(streamingChars / 4);
		streamingChars = 0;
	});

	pi.on("agent_end", () => stopTicker());

	pi.registerCommand("loading", {
		description: "Toggle the Claude Code-style working indicator",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			apply(ctx);
			ctx.ui.notify(enabled ? "Claude-style loading enabled" : "Default loading restored", "info");
		},
	});
}
