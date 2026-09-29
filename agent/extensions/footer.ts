/**
 * footer — compact custom footer for pi.
 *
 * Shows (same formatting as the built-in footer):
 *   left:  $cost  context%/window [(auto)]
 *   right: [copilot N% · claude N%]  [(provider)] model • thinking
 *
 * Subscription usage (unofficial endpoints, may break without notice):
 *   copilot — premium requests used, from api.github.com/copilot_internal/user
 *   claude  — 5h/7d window utilization if reported, otherwise monthly spend,
 *             from api.anthropic.com/api/oauth/usage
 * Refreshed every 5 minutes and after each agent run (at most once a minute).
 * A provider is hidden if you're not logged in via OAuth; on a failed fetch the
 * last known value is kept.
 *
 * Provider logos need a Nerd Font v3.5.0+ as the terminal font (the Claude
 * glyph was added in 3.5.0). Set ICON_STYLE = "text" to use names instead.
 *
 * Extension statuses (ctx.ui.setStatus) are kept on a second line so other
 * extensions' indicators don't disappear.
 *
 * /footer toggles between this footer and the built-in one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const QUOTA_INTERVAL_MS = 5 * 60 * 1000;
const QUOTA_MIN_GAP_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;

/** "nerd" = Nerd Font logos, "text" = plain provider names. */
const ICON_STYLE: "nerd" | "text" = "nerd";

const PROVIDER_ICONS: Record<string, string> = {
	"github-copilot": "\uf4b8", // nf-oct-copilot
	anthropic: "\uec82", // nf-cod-claude
};

const providerIcon = (provider: string): string | undefined =>
	ICON_STYLE === "nerd" ? PROVIDER_ICONS[provider] : undefined;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function totalCost(ctx: ExtensionContext): number {
	let cost = 0;
	for (const entry of ctx.sessionManager.getEntries() as any[]) {
		if (entry.type === "usage") cost += entry.usage?.cost?.total ?? 0;
		else if (entry.type === "message" && entry.message.role === "assistant")
			cost += entry.message.usage?.cost?.total ?? 0;
		else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage)
			cost += entry.message.usage.cost?.total ?? 0;
		else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage)
			cost += entry.usage.cost?.total ?? 0;
	}
	return cost;
}

function isSubscription(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	if (model.provider === "kimi-coding") return true;
	const provider = ctx.modelRegistry.getProvider(model.provider) as any;
	return ctx.modelRegistry.isUsingOAuth(model) && provider?.auth?.oauth?.isSubscription === true;
}

// ---------------------------------------------------------------------------
// Subscription usage
// ---------------------------------------------------------------------------

function readAuthFile(): Record<string, any> {
	try {
		return JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8"));
	} catch {
		return {};
	}
}

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`${url} -> ${res.status}`);
	return res.json();
}

/** Percent of Copilot premium requests used, or undefined. */
async function fetchCopilotUsed(): Promise<number | undefined> {
	// copilot_internal/user needs the GitHub OAuth token (stored as `refresh`),
	// not the short-lived Copilot session token pi uses for model calls.
	const cred = readAuthFile()["github-copilot"];
	if (cred?.type !== "oauth" || !cred.refresh) return undefined;
	const domain = cred.enterpriseUrl ? `api.${new URL(cred.enterpriseUrl).hostname}` : "api.github.com";
	const data = await getJson(`https://${domain}/copilot_internal/user`, {
		Authorization: `token ${cred.refresh}`,
		Accept: "application/json",
		"User-Agent": "GitHubCopilotChat/0.26.7",
		"Editor-Version": "vscode/1.99.3",
	});
	const premium = data?.quota_snapshots?.premium_interactions;
	if (!premium || premium.unlimited || typeof premium.percent_remaining !== "number") return undefined;
	return Math.max(0, 100 - premium.percent_remaining);
}

/** Percent of Anthropic subscription used, or undefined. */
async function fetchClaudeUsed(ctx: ExtensionContext): Promise<number | undefined> {
	if (readAuthFile().anthropic?.type !== "oauth") return undefined;
	// Goes through pi's auth, so an expired access token is refreshed.
	const token = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
	if (!token) return undefined;
	const data = await getJson("https://api.anthropic.com/api/oauth/usage", {
		Authorization: `Bearer ${token}`,
		"anthropic-beta": "oauth-2025-04-20",
		// Anthropic rate-limits (429) unknown UAs on this endpoint; claude-code/* is accepted.
		"User-Agent": "claude-code/2.1.0",
	});
	// Plans with rolling limits report 5h/7d windows; show the tighter one.
	const windows = [data?.five_hour, data?.seven_day]
		.map((w) => w?.utilization)
		.filter((u): u is number => typeof u === "number");
	if (windows.length > 0) return Math.max(...windows);
	// Otherwise fall back to the monthly spend limit.
	if (data?.extra_usage?.is_enabled && typeof data.extra_usage.utilization === "number")
		return data.extra_usage.utilization;
	if (typeof data?.spend?.percent === "number") return data.spend.percent;
	return undefined;
}

// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let settings: SettingsManager | undefined;
	let requestRender: (() => void) | undefined;

	const quota: { copilot?: number; claude?: number } = {};
	let quotaLastFetch = 0;
	let quotaInFlight = false;
	let quotaTimer: ReturnType<typeof setInterval> | undefined;

	const refreshQuota = async (ctx: ExtensionContext, force = false) => {
		if (quotaInFlight) return;
		if (!force && Date.now() - quotaLastFetch < QUOTA_MIN_GAP_MS) return;
		quotaInFlight = true;
		quotaLastFetch = Date.now();
		try {
			const [copilot, claude] = await Promise.allSettled([fetchCopilotUsed(), fetchClaudeUsed(ctx)]);
			// On a transient failure (429, timeout, ...) keep the last known value
			// instead of hiding the provider. A fulfilled `undefined` (logged out) clears it.
			if (copilot.status === "fulfilled") quota.copilot = copilot.value;
			if (claude.status === "fulfilled") quota.claude = claude.value;
			requestRender?.();
		} finally {
			quotaInFlight = false;
		}
	};

	const stopQuotaTimer = () => {
		if (quotaTimer) clearInterval(quotaTimer);
		quotaTimer = undefined;
	};

	const install = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		if (!enabled) {
			ctx.ui.setFooter(undefined);
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			const colorPct = (value: number, text: string) =>
				value > 90 ? theme.fg("error", text) : value > 70 ? theme.fg("warning", text) : theme.fg("dim", text);

			return {
				dispose() {
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const model = ctx.model;
					const minPad = 2;

					// ---- Left: cost + context usage + auto-compact mode
					const sub = isSubscription(ctx);
					const cost = totalCost(ctx);
					const parts: string[] = [];
					if (cost || sub) parts.push(`$${cost.toFixed(3)}`);

					const usage = ctx.getContextUsage();
					const window = usage?.contextWindow ?? model?.contextWindow ?? 0;
					const pctValue = usage?.percent ?? 0;
					const pct = usage && usage.percent !== null ? `${pctValue.toFixed(1)}%` : "?";
					const auto = (settings?.getCompactionEnabled() ?? true) ? " (auto)" : "";
					const ctxText = `${pct}/${formatTokens(window)}${auto}`;

					const leftPlain = [...parts, ctxText].join(" ");
					const left = [...parts.map((p) => theme.fg("dim", p)), colorPct(pctValue, ctxText)].join(
						theme.fg("dim", " "),
					);
					const leftWidth = visibleWidth(leftPlain);

					if (leftWidth >= width) return [truncateToWidth(left, width, "..."), ...statusLines(width)];

					// ---- Right: subscription usage, then model + thinking
					const modelName = model?.id || "no-model";
					let modelText = modelName;
					if (model?.reasoning) {
						const level = pi.getThinkingLevel() || "off";
						modelText = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
					}

					const quotaParts: { plain: string; colored: string }[] = [];
					for (const [provider, name, value] of [
						["github-copilot", "copilot", quota.copilot],
						["anthropic", "claude", quota.claude],
					] as const) {
						if (value === undefined) continue;
						const text = `${providerIcon(provider) ?? name} ${Math.round(value)}%`;
						quotaParts.push({ plain: text, colored: colorPct(value, text) });
					}
					const quotaPlain = quotaParts.map((q) => q.plain).join(" · ");
					const quotaColored = quotaParts.map((q) => q.colored).join(theme.fg("dim", " · "));

					const fits = (s: string) => leftWidth + minPad + visibleWidth(s) <= width;

					// Drop extras in order of importance until it fits: provider, then quota.
					const icon = model ? providerIcon(model.provider) : undefined;
					const withProvider =
						footerData.getAvailableProviderCount() > 1 && model
							? `${icon ?? `(${model.provider})`} ${modelText}`
							: modelText;
					const candidates: { plain: string; colored: string }[] = [];
					if (quotaPlain) {
						candidates.push({
							plain: `${quotaPlain}  ${withProvider}`,
							colored: `${quotaColored}${theme.fg("dim", `  ${withProvider}`)}`,
						});
						candidates.push({
							plain: `${quotaPlain}  ${modelText}`,
							colored: `${quotaColored}${theme.fg("dim", `  ${modelText}`)}`,
						});
					}
					candidates.push({ plain: withProvider, colored: theme.fg("dim", withProvider) });

					let right = candidates.find((c) => fits(c.plain));
					if (!right) {
						const room = width - leftWidth - minPad;
						right = room > 0 ? { plain: truncateToWidth(modelText, room, ""), colored: "" } : undefined;
						if (right) right.colored = theme.fg("dim", right.plain);
					}

					const rightWidth = right ? visibleWidth(right.plain) : 0;
					const pad = " ".repeat(Math.max(0, width - leftWidth - rightWidth));
					return [left + pad + (right?.colored ?? ""), ...statusLines(width)];
				},
			};

			// Keep other extensions' status texts visible
			function statusLines(width: number): string[] {
				const statuses = footerData.getExtensionStatuses();
				if (statuses.size === 0) return [];
				const text = [...statuses.entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, t]) => t.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
					.join(" ");
				return [truncateToWidth(text, width, theme.fg("dim", "..."))];
			}
		});
	};

	pi.on("session_start", (_event, ctx) => {
		settings = SettingsManager.create(ctx.cwd);
		install(ctx);
		if (ctx.mode !== "tui") return;
		stopQuotaTimer();
		void refreshQuota(ctx, true);
		quotaTimer = setInterval(() => void refreshQuota(ctx, true), QUOTA_INTERVAL_MS);
		quotaTimer.unref?.();
	});

	pi.on("session_shutdown", () => stopQuotaTimer());

	// Pick up /settings changes (e.g. auto-compact toggled) and refresh usage.
	pi.on("agent_end", async (_event, ctx) => {
		await settings?.reload();
		requestRender?.();
		if (ctx.mode === "tui") void refreshQuota(ctx);
	});
	pi.on("model_select", () => requestRender?.());
	pi.on("thinking_level_select", () => requestRender?.());

	pi.registerCommand("footer", {
		description: "Toggle the custom footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			install(ctx);
			ctx.ui.notify(enabled ? "Custom footer enabled" : "Default footer restored", "info");
		},
	});
}
