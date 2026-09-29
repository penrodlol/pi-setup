/**
 * header — custom startup header for pi.
 *
 *   ╭─ π pi v0.87.1 ─────────────────────────────╮
 *   │     ▄▄▀▀▀▀▀▀▄▄                              │
 *   │  ▄▀▀▀▀▀▀▀▀▀▀▀▀▀▀▄                           │
 *   │ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀   model     …          │
 *   │ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀   thinking  high       │
 *   │  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀    provider  …          │
 *   │     ▀▀▀▀▀▀▀▀▀▀                              │
 *   ╰─────────────────────────────────────────────╯
 *
 * A spinning, lit 3D orb (half-block pixels) next to the current model,
 * thinking level and provider.
 *
 * All colours are derived from the active theme (accent + semantic tokens),
 * so the header follows theme switches.
 *
 * The orb only animates while the header is inside the terminal viewport:
 * changing lines that have scrolled into scrollback forces a full redraw.
 *
 * /header toggles between this header and the built-in one.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const ORB_COLS = 24; // orb width in terminal columns (> 2 × ORB_ROWS stretches it horizontally)
const ORB_ROWS = 10; // orb height in terminal rows (2 pixels each via half blocks)
const ORB_RX = ORB_COLS / 2 - 0.3; // horizontal radius, in pixels
const ORB_RY = ORB_ROWS - 0.3; // vertical radius, in pixels
const STAR_MARGIN_X = 7; // columns of starry space left/right of the orb
const STAR_MARGIN_Y = 1; // rows of starry space above/below the orb
const CANVAS_COLS = ORB_COLS + 2 * STAR_MARGIN_X;
const CANVAS_ROWS = ORB_ROWS + 2 * STAR_MARGIN_Y;
const ORBIT_STARS = 7;
const FIELD_STARS = 9; // static background stars that just twinkle
const TICK_MS = 80;
const REVOLUTION_MS = 7000;
const TILT = 0.42; // radians the spin axis leans toward the viewer
const INFO_LABEL_W = 10; // info label width
const INFO_MAX_W = 36;
const PAD_X = 5; // columns between the left border and the star canvas
const PAD_RIGHT = 2; // minimum columns kept free before the right border
const PAD_Y = 1; // blank rows between the box border and the star canvas
const ORB_GAP = 4; // columns between the star canvas and the info text

// ---------------------------------------------------------------------------
// Colour helpers (theme → RGB → ANSI)
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

const CUBE = [0, 95, 135, 175, 215, 255];
const BASE16: RGB[] = [
	[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
	[128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

function xtermToRgb(n: number): RGB {
	if (n < 16) return BASE16[n]!;
	if (n < 232) {
		const i = n - 16;
		return [CUBE[Math.floor(i / 36)]!, CUBE[Math.floor(i / 6) % 6]!, CUBE[i % 6]!];
	}
	const g = 8 + (n - 232) * 10;
	return [g, g, g];
}

function rgbToXterm([r, g, b]: RGB): number {
	const idx = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
	const [ri, gi, bi] = [idx(r), idx(g), idx(b)];
	const cube: RGB = [CUBE[ri]!, CUBE[gi]!, CUBE[bi]!];
	const avg = (r + g + b) / 3;
	const gi2 = avg > 238 ? 23 : Math.max(0, Math.round((avg - 8) / 10));
	const gray = 8 + gi2 * 10;
	const d = (c: RGB) => (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
	return d(cube) <= d([gray, gray, gray]) ? 16 + ri * 36 + gi * 6 + bi : 232 + gi2;
}

function themeRgb(theme: Theme, token: Parameters<Theme["getFgAnsi"]>[0], fallback: RGB): RGB {
	const ansi = theme.getFgAnsi(token);
	const tc = ansi.match(/38;2;(\d+);(\d+);(\d+)/);
	if (tc) return [Number(tc[1]), Number(tc[2]), Number(tc[3])];
	const x = ansi.match(/38;5;(\d+)/);
	if (x) return xtermToRgb(Number(x[1]));
	return fallback;
}

const mix = (a: RGB, b: RGB, t: number): RGB => [
	a[0] + (b[0] - a[0]) * t,
	a[1] + (b[1] - a[1]) * t,
	a[2] + (b[2] - a[2]) * t,
];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

interface Palette {
	shadow: RGB;
	mid: RGB;
	light: RGB;
	line: RGB;
	spec: RGB;
	truecolor: boolean;
}

function paletteFor(theme: Theme): Palette {
	const accent = themeRgb(theme, "accent", [95, 135, 135]);
	const white: RGB = [255, 255, 255];
	const black: RGB = [0, 0, 0];
	return {
		shadow: mix(accent, black, 0.85),
		mid: accent,
		light: mix(accent, white, 0.45),
		line: mix(accent, white, 0.7),
		spec: mix(accent, white, 0.92),
		truecolor: theme.getColorMode() === "truecolor",
	};
}

function ramp(p: Palette, t: number): RGB {
	t = clamp01(t);
	return t < 0.55 ? mix(p.shadow, p.mid, t / 0.55) : mix(p.mid, p.light, (t - 0.55) / 0.45);
}

function sgr(rgb: RGB, bg: boolean, truecolor: boolean): string {
	const [r, g, b] = rgb.map((v) => Math.round(Math.max(0, Math.min(255, v)))) as RGB;
	if (truecolor) return `\x1b[${bg ? 48 : 38};2;${r};${g};${b}m`;
	return `\x1b[${bg ? 48 : 38};5;${rgbToXterm([r, g, b])}m`;
}

// ---------------------------------------------------------------------------
// The orb
// ---------------------------------------------------------------------------

const norm = (v: number[]): RGB => {
	const l = Math.hypot(v[0]!, v[1]!, v[2]!);
	return [v[0]! / l, v[1]! / l, v[2]! / l];
};
const LIGHT = norm([-0.55, -0.7, 0.55]); // upper-left, toward viewer (y points down)
const HALF = norm([LIGHT[0], LIGHT[1], LIGHT[2] + 1]); // Blinn half vector (view = +z)
const COS_T = Math.cos(TILT);
const SIN_T = Math.sin(TILT);

function shade(p: Palette, x: number, y: number, z: number, angle: number): RGB {
	const diffuse = Math.max(0, x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2]);

	// Undo the tilt to get surface coordinates, then spin around the axis.
	const oy = y * COS_T + z * SIN_T;
	const oz = -y * SIN_T + z * COS_T;
	const lon = Math.atan2(x, oz) + angle;
	const lat = Math.asin(Math.max(-1, Math.min(1, oy)));

	// Wavy latitude bands (dark troughs, bright crests) + faint meridians.
	const wave = Math.sin(lat * 5 + 1.3 * Math.sin(lon * 2));
	const crest = clamp01((wave - 0.35) / 0.5);
	const trough = clamp01((-wave - 0.2) / 0.6);
	const meridian = clamp01(1 - Math.abs(Math.sin(lon * 2)) / 0.12) * 0.35;

	let c = ramp(p, (0.06 + 0.9 * diffuse) * (1 - 0.45 * trough));
	c = mix(c, p.line, Math.max(crest, meridian) * (0.25 + 0.75 * diffuse) * 0.9);
	const spec = Math.max(0, x * HALF[0] + y * HALF[1] + z * HALF[2]) ** 28;
	c = mix(c, p.spec, spec * 0.85);
	const rim = (1 - z) ** 3;
	return mix(c, p.mid, rim * 0.55);
}

// ---------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------

/** Tiny deterministic PRNG (mulberry32) so the star field is identical every frame. */
function prng(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
	};
}

interface OrbitStar {
	a: number; // orbit radius, in orb radii
	inc: number; // orbit inclination (how open the ellipse looks)
	roll: number; // tilt of the ellipse on screen
	phase: number;
	speed: number; // rad/s
	twinkle: number; // rad/s
	twPhase: number;
}

interface FieldStar {
	col: number;
	row: number;
	twinkle: number;
	twPhase: number;
}

const ORBITERS: OrbitStar[] = (() => {
	const rand = prng(42);
	return Array.from({ length: ORBIT_STARS }, () => {
		const a = 1.2 + rand() * 0.42;
		return {
			a,
			inc: (0.18 + rand() * 0.3) * (rand() < 0.5 ? -1 : 1),
			roll: (rand() - 0.5) * 0.6,
			phase: rand() * Math.PI * 2,
			speed: 1.6 * a ** -1.5, // inner stars move faster
			twinkle: 2 + rand() * 4,
			twPhase: rand() * Math.PI * 2,
		};
	});
})();

const FIELD: FieldStar[] = (() => {
	const rand = prng(7);
	const cx = CANVAS_COLS / 2;
	const cy = CANVAS_ROWS; // in pixel units (2 per row)
	const stars: FieldStar[] = [];
	for (let tries = 0; stars.length < FIELD_STARS && tries < 500; tries++) {
		const col = Math.floor(rand() * CANVAS_COLS);
		const row = Math.floor(rand() * CANVAS_ROWS);
		const dx = col + 0.5 - cx;
		const dy = row * 2 + 1 - cy;
		if (Math.hypot(dx / (ORB_RX + 2.5), dy / (ORB_RY + 2.5)) < 1) continue; // keep clear of the orb
		if (stars.some((s) => Math.abs(s.col - col) + Math.abs(s.row - row) < 3)) continue;
		stars.push({ col, row, twinkle: 0.8 + rand() * 1.8, twPhase: rand() * Math.PI * 2 });
	}
	return stars;
})();

function starGlyph(b: number): string {
	if (b > 0.85) return "✦";
	if (b > 0.62) return "+";
	if (b > 0.38) return "·";
	return "˙";
}

// ---------------------------------------------------------------------------
// Scene: orb + stars
// ---------------------------------------------------------------------------

interface Star {
	glyph: string;
	color: RGB;
	b: number;
}

/** Render the orb + stars. `marginX` (≤ STAR_MARGIN_X) shrinks the canvas on narrow terminals. */
function renderScene(p: Palette, time: number, marginX = STAR_MARGIN_X): string[] {
	const w = ORB_COLS + 2 * marginX;
	const shiftX = marginX - STAR_MARGIN_X; // field stars are laid out for the full canvas
	const h = CANVAS_ROWS * 2;
	const cx = w / 2;
	const cy = h / 2;
	const angle = (time * 2 * Math.PI * 1000) / REVOLUTION_MS;
	const offsets = [0.25, 0.75];

	// Orb pixels (2 per cell vertically), supersampled 2×2.
	const pixels: (RGB | null)[][] = [];
	for (let py = 0; py < h; py++) {
		const row: (RGB | null)[] = [];
		for (let px = 0; px < w; px++) {
			let acc: RGB = [0, 0, 0];
			let n = 0;
			for (const sy of offsets) {
				for (const sx of offsets) {
					const x = (px + sx - cx) / ORB_RX;
					const y = (py + sy - cy) / ORB_RY;
					const r2 = x * x + y * y;
					if (r2 > 1) continue;
					const c = shade(p, x, y, Math.sqrt(1 - r2), angle);
					acc = [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]];
					n++;
				}
			}
			if (n < 2) row.push(null);
			else {
				const k = (n === 4 ? 1 : 0.7) / n; // soften the silhouette edge
				row.push([acc[0] * k, acc[1] * k, acc[2] * k]);
			}
		}
		pixels.push(row);
	}

	// Stars, one per cell (brightest wins).
	const stars: (Star | undefined)[][] = Array.from({ length: CANVAS_ROWS }, () => []);
	const place = (col: number, row: number, b: number) => {
		if (col < 0 || col >= w || row < 0 || row >= CANVAS_ROWS) return;
		const cur = stars[row]![col];
		if (cur && cur.b >= b) return;
		stars[row]![col] = { glyph: starGlyph(b), color: mix(p.shadow, p.spec, 0.25 + 0.75 * b), b };
	};

	const twinkle = (rate: number, phase: number) => {
		const s = 0.5 + 0.5 * Math.sin(time * rate + phase);
		return s * s; // mostly dim, with brief sparkles
	};

	for (const s of FIELD) {
		const b = twinkle(s.twinkle, s.twPhase) * 0.8;
		if (b > 0.08) place(s.col + shiftX, s.row, b);
	}

	for (const s of ORBITERS) {
		const th = s.phase + s.speed * time;
		// Circle in the orbit plane, tipped toward the viewer, then rolled on screen.
		const ox = s.a * Math.cos(th);
		const oz0 = s.a * Math.sin(th);
		const oy = oz0 * Math.sin(s.inc);
		const oz = oz0 * Math.cos(s.inc);
		const x = ox * Math.cos(s.roll) - oy * Math.sin(s.roll);
		const y = ox * Math.sin(s.roll) + oy * Math.cos(s.roll);
		if (oz < 0 && x * x + y * y < 1.05) continue; // hidden behind the orb
		const depth = oz < 0 ? 0.55 : 1; // dimmer when on the far side
		const b = (0.5 + 0.5 * twinkle(s.twinkle, s.twPhase)) * depth;
		place(Math.floor(cx + x * ORB_RX), Math.floor((cy + y * ORB_RY) / 2), b);
	}

	// Emit half-block cells, with star glyphs drawn over their cell background.
	const lines: string[] = [];
	for (let row = 0; row < CANVAS_ROWS; row++) {
		let out = "";
		for (let col = 0; col < w; col++) {
			const top = pixels[row * 2]![col];
			const bot = pixels[row * 2 + 1]![col];
			const star = stars[row]![col];
			if (star) {
				const bg = top && bot ? mix(top, bot, 0.5) : (top ?? bot);
				out += `${bg ? sgr(bg, true, p.truecolor) : "\x1b[49m"}${sgr(star.color, false, p.truecolor)}${star.glyph}`;
			} else if (!top && !bot) out += "\x1b[39;49m ";
			else if (top && !bot) out += `\x1b[49m${sgr(top, false, p.truecolor)}▀`;
			else if (!top && bot) out += `\x1b[49m${sgr(bot, false, p.truecolor)}▄`;
			else out += `${sgr(top!, false, p.truecolor)}${sgr(bot!, true, p.truecolor)}▀`;
		}
		lines.push(`${out}\x1b[39;49m`);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Header component
// ---------------------------------------------------------------------------

function fit(s: string, w: number): string {
	if (w <= 0) return "";
	const t = visibleWidth(s) > w ? truncateToWidth(s, w, "…") : s;
	return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
}

type ThinkingToken =
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax";

class OrbHeader {
	private frame = 0; // advances only while visible, so the scene freezes offscreen
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly fallbackTheme: Theme,
		private readonly getCtx: () => ExtensionContext | undefined,
		private readonly pi: ExtensionAPI,
	) {
		this.timer = setInterval(() => this.tick(), TICK_MS);
		this.timer.unref?.();
	}

	private get theme(): Theme {
		try {
			return this.getCtx()?.ui.theme ?? this.fallbackTheme;
		} catch {
			return this.fallbackTheme;
		}
	}

	/** Header sits at the top of the document; only animate while it's on screen. */
	private headerOnScreen(): boolean {
		if (this.tui.mode === "fullscreen") return true;
		const top = (this.tui as unknown as { previousViewportTop?: number }).previousViewportTop;
		return typeof top !== "number" || top === 0;
	}

	private tick(): void {
		if (!this.headerOnScreen()) return; // freeze: keeps the frame identical, no full redraw
		this.frame++;
		this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private infoLines(width: number): string[] {
		const theme = this.theme;
		const model = this.getCtx()?.model;
		const label = (s: string) => theme.fg("muted", s.padEnd(INFO_LABEL_W));
		const valueW = Math.max(1, width - INFO_LABEL_W);
		const val = (s: string) => truncateToWidth(s, valueW, "…");

		let thinking: string;
		if (!model) thinking = theme.fg("dim", "—");
		else if (!model.reasoning) thinking = theme.fg("dim", "n/a");
		else {
			const level = this.pi.getThinkingLevel() || "off";
			const token = `thinking${level.charAt(0).toUpperCase()}${level.slice(1)}` as ThinkingToken;
			try {
				thinking = theme.fg(token, val(level));
			} catch {
				thinking = theme.fg("text", val(level));
			}
		}

		let providerName = model?.provider ?? "—";
		try {
			const p = model ? (this.getCtx()?.modelRegistry.getProvider(model.provider) as { name?: string } | undefined) : undefined;
			if (p?.name) providerName = p.name;
		} catch {}

		return [
			label("model") + theme.bold(theme.fg("text", val(model ? model.name || model.id : "no model"))),
			label("thinking") + thinking,
			label("provider") + theme.fg("text", val(providerName)),
		];
	}

	render(width: number): string[] {
		const theme = this.theme;
		const b = (s: string) => theme.fg("border", s);

		if (width < 24) {
			return [truncateToWidth(`${theme.fg("accent", "π")} pi v${VERSION}`, width, "")];
		}

		const maxInner = width - 2 - PAD_X - PAD_RIGHT; // "│" + pad + content + pad + "│"
		const INFO_MIN_W = 20;
		const showOrb = maxInner >= ORB_COLS + ORB_GAP + INFO_MIN_W;
		// Info keeps its natural width; stars get whatever side margin is left (up to STAR_MARGIN_X).
		const naturalInfoW = Math.max(...this.infoLines(INFO_MAX_W).map(visibleWidth));
		const infoTarget = Math.min(naturalInfoW, maxInner - ORB_COLS - ORB_GAP);
		const marginX = showOrb
			? Math.max(0, Math.min(STAR_MARGIN_X, Math.floor((maxInner - ORB_COLS - ORB_GAP - infoTarget) / 2)))
			: 0;
		const sceneW = ORB_COLS + 2 * marginX;
		const infoW = Math.min(INFO_MAX_W, showOrb ? maxInner - sceneW - ORB_GAP : maxInner);
		const info = this.infoLines(infoW);

		const title = ` ${theme.fg("accent", "π")} ${theme.bold(theme.fg("text", "pi"))} ${theme.fg("dim", `v${VERSION}`)} `;
		const titleW = visibleWidth(title);

		// Box spans the full terminal width.
		const inner = maxInner;
		const boxW = width;

		const top = b("╭─") + title + b(`${"─".repeat(Math.max(0, boxW - 3 - titleW))}╮`);
		const bottom = b(`╰${"─".repeat(boxW - 2)}╯`);
		const padL = " ".repeat(PAD_X);
		const padR = " ".repeat(PAD_RIGHT);
		const row = (content: string) => `${b("│")}${padL}${fit(content, inner)}${padR}${b("│")}`;

		const orb = showOrb ? renderScene(paletteFor(theme), (this.frame * TICK_MS) / 1000, marginX) : [];
		const height = Math.max(orb.length, info.length);
		const infoPad = Math.floor((height - info.length) / 2);

		const lines = ["", top];
		for (let i = 0; i < PAD_Y; i++) lines.push(row(""));
		for (let i = 0; i < height; i++) {
			const orbLine = showOrb ? `${orb[i] ?? " ".repeat(sceneW)}${" ".repeat(ORB_GAP)}` : "";
			lines.push(row(orbLine + (info[i - infoPad] ?? "")));
		}
		for (let i = 0; i < PAD_Y; i++) lines.push(row(""));
		lines.push(bottom, "");
		return lines.map((l) => truncateToWidth(l, width, ""));
	}
}

// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let current: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;

	const install = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		if (!enabled) {
			ctx.ui.setHeader(undefined);
			return;
		}
		ctx.ui.setHeader((tui, theme) => {
			requestRender = () => tui.requestRender();
			return new OrbHeader(tui, theme, () => current, pi);
		});
	};

	pi.on("session_start", (_event, ctx) => {
		current = ctx;
		install(ctx);
	});

	pi.on("session_shutdown", () => {
		requestRender = undefined;
	});

	const rerender = (_e: unknown, ctx: ExtensionContext) => {
		current = ctx;
		requestRender?.();
	};
	pi.on("model_select", rerender);
	pi.on("thinking_level_select", rerender);

	pi.registerCommand("header", {
		description: "Toggle the custom orb header",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			current = ctx;
			install(ctx);
			ctx.ui.notify(enabled ? "Custom header enabled" : "Built-in header restored", "info");
		},
	});
}
