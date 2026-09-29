/**
 * collapse-expand
 *
 * Collapses every tool call block (edit, write, bash, read, extension tools, ...)
 * to at most N lines (default 3, including the "more lines" hint) while tool output
 * is collapsed. Expand with the normal controls:
 *   - ctrl+o (app.tools.expand)  → toggle all tool blocks
 *   - left click on a block      → toggle that block
 *
 * Command:
 *   /collapse-expand            → show current status
 *   /collapse-expand on|off     → enable / disable clamping
 *   /collapse-expand <n>        → set max collapsed lines (>= 1)
 *
 * How it works: pi has no setting for this, so the extension patches
 * ToolExecutionComponent.prototype.render. While a block is collapsed, the block's
 * children are temporarily wrapped in a Clamp component that keeps the first
 * lines and replaces the rest with a hint. Box/Text padding and backgrounds
 * (e.g. the edit tool's self-rendered box) are preserved.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	MouseRegion,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const DEFAULT_MAX_LINES = 3;
const STATE_KEY = Symbol.for("pi.extensions.collapse-expand");

interface CollapseState {
	enabled: boolean;
	maxLines: number;
	theme?: () => Theme | undefined;
	patched?: boolean;
}

function getState(): CollapseState {
	const g = globalThis as Record<symbol, CollapseState | undefined>;
	g[STATE_KEY] ??= { enabled: true, maxLines: DEFAULT_MAX_LINES };
	return g[STATE_KEY]!;
}

// ---------------------------------------------------------------------------
// Clamp component
// ---------------------------------------------------------------------------

interface Segment {
	top: string[];
	body: string[];
	bottom: string[];
	styleLine: (line: string, width: number) => string;
}

function unwrap(component: Component): any {
	let current: any = component;
	while (current instanceof MouseRegion) current = (current as any).child;
	return current;
}

function isBlank(line: string): boolean {
	return stripTerminalSequences(line).trim() === "";
}

/** Matches pi's own truncation hints, e.g. "... (12 more lines, ctrl+o to expand)". */
const BUILTIN_HINT = /^\s*\.\.\. \((\d+) (?:more|earlier) lines?,/;

function toSegment(child: Component, width: number): Segment {
	const lines = child.render(width);
	const inner = unwrap(child);
	const framed = inner instanceof Box || inner instanceof Text;
	const padY: number = framed && typeof inner.paddingY === "number" ? inner.paddingY : 0;
	const padX: number = framed && typeof inner.paddingX === "number" ? inner.paddingX : 0;
	const bgFn: ((s: string) => string) | undefined = framed ? (inner.bgFn ?? inner.customBgFn) : undefined;

	const styleLine = (line: string, w: number): string => {
		const content = " ".repeat(padX) + truncateToWidth(line, Math.max(1, w - padX * 2));
		if (inner instanceof Box && typeof (inner as any).applyBg === "function") {
			return (inner as any).applyBg(content, w);
		}
		const padded = content + " ".repeat(Math.max(0, w - visibleWidth(content)));
		return bgFn ? bgFn(padded) : truncateToWidth(content, w);
	};

	if (padY > 0 && lines.length >= padY * 2) {
		return {
			top: lines.slice(0, padY),
			body: lines.slice(padY, lines.length - padY),
			bottom: lines.slice(lines.length - padY),
			styleLine,
		};
	}
	return { top: [], body: lines, bottom: [], styleLine };
}

function flatten(segments: Segment[]): string[] {
	return segments.flatMap((s) => [...s.top, ...s.body, ...s.bottom]);
}

function hintText(hidden: number): string {
	const theme = getState().theme?.();
	const count = `… ${hidden} more line${hidden === 1 ? "" : "s"} · `;
	return (theme ? theme.fg("muted", count) : count) + keyHint("app.tools.expand", "to expand");
}

class Clamp implements Component {
	constructor(
		private readonly children: Component[],
		private readonly owner: any,
	) {}

	render(width: number): string[] {
		const max = Math.max(1, Math.floor(getState().maxLines));
		const segments = this.children.map((child) => toSegment(child, width));
		const count = () => segments.reduce((n, s) => n + s.body.length, 0);

		if (count() <= max) return flatten(segments);

		// Over budget: drop blank spacer lines and pi's own truncation hints (their
		// counts are folded into ours), then truncate.
		let alreadyHidden = 0;
		for (const s of segments) {
			s.body = s.body.filter((line) => {
				if (isBlank(line)) return false;
				const match = BUILTIN_HINT.exec(stripTerminalSequences(line));
				if (match) {
					alreadyHidden += Number(match[1]);
					return false;
				}
				return true;
			});
		}
		const total = count();
		if (total <= max && alreadyHidden === 0) return flatten(segments);

		const keep = Math.min(total, max - 1); // last line is reserved for the hint
		const hint = (w: number, s: Segment) => s.styleLine(hintText(total - keep + alreadyHidden), w);
		let remaining = keep;
		let placed = false;
		const out: string[] = [];
		for (const s of segments) {
			if (s.body.length <= remaining) {
				out.push(...s.top, ...s.body, ...s.bottom);
				remaining -= s.body.length;
				continue;
			}
			out.push(...s.top, ...s.body.slice(0, remaining), hint(width, s), ...s.bottom);
			placed = true;
			break;
		}
		if (!placed && segments.length > 0) {
			// Every segment fit; append the hint inside the last segment.
			const last = segments[segments.length - 1];
			out.splice(out.length - last.bottom.length, 0, hint(width, last));
		}
		return out;
	}

	handleMouse(event: any) {
		if (event.type !== "click" || event.button !== "left" || !this.owner.result) return undefined;
		this.owner.setExpanded(!this.owner.expanded);
		return { handled: true };
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate?.();
	}
}

// ---------------------------------------------------------------------------
// Patch ToolExecutionComponent
// ---------------------------------------------------------------------------

function patchToolExecution(): void {
	const state = getState();
	if (state.patched) return; // survive /reload without double-patching
	state.patched = true;

	const proto = (ToolExecutionComponent as any).prototype;
	const originalRender: (width: number) => string[] = proto.render;

	proto.render = function (this: any, width: number): string[] {
		const st = getState();
		if (!st.enabled || this.expanded) return originalRender.call(this, width);

		try {
			if (this.toolDefinition !== undefined) {
				// Renderer-based tools: default boxed shell or self-rendered shell.
				const container = (this.toolDefinition.renderShell ?? "default") === "self"
					? this.selfRenderContainer
					: this.contentBox;
				const saved: Component[] = container.children;
				if (saved.length === 0) return originalRender.call(this, width);
				container.children = [new Clamp(saved, this)];
				try {
					return originalRender.call(this, width);
				} finally {
					container.children = saved;
				}
			}

			// Generic fallback (tool without a definition): wrap the text region.
			const region = this.contentTextRegion;
			const index = this.children.indexOf(region);
			if (index === -1) return originalRender.call(this, width);
			const saved: Component[] = this.children;
			this.children = saved.slice();
			this.children[index] = new Clamp([region], this);
			try {
				return originalRender.call(this, width);
			} finally {
				this.children = saved;
			}
		} catch {
			return originalRender.call(this, width);
		}
	};
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

function refresh(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	const expanded = ctx.ui.getToolsExpanded();
	// Toggle twice to force every tool block to rebuild and re-render.
	ctx.ui.setToolsExpanded(!expanded);
	ctx.ui.setToolsExpanded(expanded);
}

export default function (pi: ExtensionAPI) {
	patchToolExecution();

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui") getState().theme = () => ctx.ui.theme;
	});

	pi.registerCommand("collapse-expand", {
		description: "Collapse tool blocks: on | off | <max lines>",
		handler: async (args, ctx) => {
			const state = getState();
			const arg = (args ?? "").trim().toLowerCase();

			if (arg === "on" || arg === "off") {
				state.enabled = arg === "on";
			} else if (arg) {
				const n = Number.parseInt(arg, 10);
				if (!Number.isFinite(n) || n < 1) {
					ctx.ui.notify("Usage: /collapse-expand [on|off|<max lines ≥ 1>]", "warning");
					return;
				}
				state.maxLines = n;
				state.enabled = true;
			}

			refresh(ctx);
			ctx.ui.notify(
				`collapse-expand: ${state.enabled ? "on" : "off"}, max ${state.maxLines} line(s) when collapsed`,
				"info",
			);
		},
	});
}
