import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, getSettingsListTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Input, Markdown, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

const PATCH_VERSION = "0.4.0";
const LABEL = "Thinking...";
const STATUS_KEY = "compact-transcript";
const CONFIG_ENTRY_TYPE = "compact-transcript-config";

const BUILT_INS = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);

type Mode = "disabled" | "off" | "balanced" | "aggressive" | "debug";
type ToolKind = "always" | "mutation" | "noise";

type CompactTranscriptConfig = {
	mode: Mode;
	compactCustomTools: boolean;
	showFailedTools: boolean;
	showBashMutations: boolean;
	status: boolean;
	alwaysShowTools: string[];
	mutationTools: string[];
	previewTemplates: Record<string, string>;
};

type ToolInfo = {
	id: string;
	name: string;
	args: any;
	preview: string;
	kind: ToolKind;
	hidden?: boolean;
	burstCount?: number;
	burstSummary?: string;
	result?: string;
	isError?: boolean;
	invalidate?: () => void;
};

type RuntimeState = {
	config: CompactTranscriptConfig;
	toolsById: Map<string, ToolInfo>;
	currentNoiseBurst: ToolInfo[];
	hiddenToolIds: Set<string>;
	agentActive: boolean;
	lastThinkingSignalComponent?: any;
	thinkingSignalCount: number;
	consecutiveThinking: number;
	ui?: ExtensionContext["ui"];
	currentTheme?: Theme;
};

const DEFAULT_CONFIG: CompactTranscriptConfig = {
	mode: "balanced",
	compactCustomTools: true,
	showFailedTools: true,
	showBashMutations: true,
	status: false,
	alwaysShowTools: [],
	mutationTools: [],
	previewTemplates: {},
};

const STATE_KEY = Symbol.for("pi-compact-transcript.state");
const TOOL_PATCH_KEY = Symbol.for("pi-compact-transcript.tool-patch");
const ASSISTANT_PATCH_KEY = Symbol.for("pi-compact-transcript.assistant-patch");

function cloneConfig(config: CompactTranscriptConfig): CompactTranscriptConfig {
	return {
		mode: config.mode,
		compactCustomTools: config.compactCustomTools,
		showFailedTools: config.showFailedTools,
		showBashMutations: config.showBashMutations,
		status: config.status,
		alwaysShowTools: [...config.alwaysShowTools],
		mutationTools: [...config.mutationTools],
		previewTemplates: { ...config.previewTemplates },
	};
}

function normalizeConfig(input: unknown): CompactTranscriptConfig {
	const source = (input && typeof input === "object" ? input : {}) as Partial<CompactTranscriptConfig>;
	const rawMode = source.mode;
	const mode =
		rawMode === "off" || rawMode === "disabled"
			? "disabled"
			: rawMode === "aggressive" || rawMode === "debug"
				? rawMode
				: "balanced";
	return {
		...cloneConfig(DEFAULT_CONFIG),
		...source,
		mode,
		compactCustomTools: source.compactCustomTools ?? DEFAULT_CONFIG.compactCustomTools,
		showFailedTools: source.showFailedTools ?? DEFAULT_CONFIG.showFailedTools,
		showBashMutations: source.showBashMutations ?? DEFAULT_CONFIG.showBashMutations,
		status: source.status ?? DEFAULT_CONFIG.status,
		alwaysShowTools: Array.isArray(source.alwaysShowTools) ? source.alwaysShowTools.filter(isNonEmptyString) : [],
		mutationTools: Array.isArray(source.mutationTools) ? source.mutationTools.filter(isNonEmptyString) : [],
		previewTemplates:
			source.previewTemplates && typeof source.previewTemplates === "object" && !Array.isArray(source.previewTemplates)
				? Object.fromEntries(
						Object.entries(source.previewTemplates).filter(
							([key, value]) => isNonEmptyString(key) && typeof value === "string",
						),
					)
				: {},
	};
}

function getState(): RuntimeState {
	const globalWithState = globalThis as typeof globalThis & { [STATE_KEY]?: RuntimeState };
	globalWithState[STATE_KEY] ??= {
		config: cloneConfig(DEFAULT_CONFIG),
		toolsById: new Map(),
		currentNoiseBurst: [],
		hiddenToolIds: new Set(),
		agentActive: false,
		thinkingSignalCount: 0,
		consecutiveThinking: 0,
	};
	return globalWithState[STATE_KEY]!;
}

const state = getState();

function isEnabled(): boolean {
	return state.config.mode !== "disabled" && state.config.mode !== "off";
}

function isDebugMode(): boolean {
	return state.config.mode === "debug";
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function shortenPath(path: unknown): string {
	if (typeof path !== "string" || !path) return "";
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function oneLine(value: unknown): string {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function previewWidth(base = process.stdout.columns || 100): number {
	const modeMax = state.config.mode === "aggressive" ? 72 : state.config.mode === "debug" ? 140 : 104;
	return Math.max(20, Math.min(modeMax, base - 6));
}

function limitPlain(text: string, max = previewWidth()): string {
	const clean = oneLine(text);
	if (clean.length <= max) return clean;
	return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function quote(s: string): string {
	return JSON.stringify(s);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return String(value);
	}
}

function matchRule(rule: string, toolName: string): boolean {
	const trimmed = rule.trim();
	if (!trimmed) return false;
	if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) {
		const lastSlash = trimmed.lastIndexOf("/");
		const pattern = trimmed.slice(1, lastSlash);
		const flags = trimmed.slice(lastSlash + 1);
		try {
			return new RegExp(pattern, flags).test(toolName);
		} catch {
			return false;
		}
	}
	if (trimmed.includes("*")) {
		const pattern = `^${trimmed.split("*").map(escapeRegExp).join(".*")}$`;
		return new RegExp(pattern).test(toolName);
	}
	return toolName === trimmed || toolName.endsWith(`.${trimmed}`);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesAnyRule(rules: string[], toolName: string): boolean {
	return rules.some((rule) => matchRule(rule, toolName));
}

function isMutatingBash(command: unknown): boolean {
	if (typeof command !== "string") return false;
	const compact = command.replace(/#[^\n]*/g, "").trim();
	if (!compact) return false;

	// Obvious file/process mutations and package/install actions. This is intentionally
	// conservative enough to keep anchors for risky commands without treating every
	// shell pipeline as destructive.
	return /(^|[;&|]\s*)(rm\b|mv\b|cp\b|mkdir\b|rmdir\b|touch\b|chmod\b|chown\b|ln\b|truncate\b|tee\b|npm\s+(i|install|uninstall|remove|publish)\b|pnpm\s+(i|install|add|remove)\b|yarn\s+(add|remove|install|publish)\b|bun\s+(add|remove|install)\b|pip\s+(install|uninstall)\b|git\s+(add|apply|commit|checkout|clean|merge|mv|pull|push|rebase|reset|restore|stash|switch)\b)/.test(
		compact,
	) || /(^|[^2])>>?\s*[^&\s]/.test(compact);
}

function classifyTool(name: string, args: any): ToolKind {
	if (matchesAnyRule(state.config.alwaysShowTools, name)) return "always";
	if (!BUILT_INS.has(name) && !state.config.compactCustomTools) return "always";
	if (name === "edit" || name === "write" || name.endsWith(".edit") || name.endsWith(".write")) return "mutation";
	if (matchesAnyRule(state.config.mutationTools, name)) return "mutation";
	if (state.config.showBashMutations && (name === "bash" || name.endsWith(".bash")) && isMutatingBash(args?.command)) {
		return "mutation";
	}
	return "noise";
}

function findTemplate(name: string): string | undefined {
	if (state.config.previewTemplates[name]) return state.config.previewTemplates[name];
	for (const [rule, template] of Object.entries(state.config.previewTemplates)) {
		if (matchRule(rule, name)) return template;
	}
	return undefined;
}

function getByPath(value: any, path: string): unknown {
	let current = value;
	for (const part of path.split(".")) {
		if (!part) continue;
		if (current == null || typeof current !== "object") return undefined;
		current = current[part];
	}
	return current;
}

function renderTemplate(template: string, name: string, args: any): string {
	return template.replace(/\{(?:arg\.)?([a-zA-Z0-9_.-]+)\}/g, (_match, key: string) => {
		if (key === "name") return name;
		if (key === "args") return safeJson(args);
		const value = getByPath(args, key);
		if (value === undefined || value === null) return "";
		if (typeof value === "string") return value;
		return safeJson(value);
	});
}

function previewFor(name: string, args: any): string {
	const template = findTemplate(name);
	if (template) return renderTemplate(template, name, args);

	switch (name) {
		case "bash":
			return `$ ${oneLine(args?.command || "...")}`;
		case "read": {
			let out = `read ${shortenPath(args?.path) || "..."}`;
			if (args?.offset !== undefined || args?.limit !== undefined) {
				const start = args.offset ?? 1;
				const end = args.limit !== undefined ? start + args.limit - 1 : "";
				out += `:${start}${end ? `-${end}` : ""}`;
			}
			return out;
		}
		case "write": {
			const lines = typeof args?.content === "string" ? args.content.split("\n").length : 0;
			return `write ${shortenPath(args?.path) || "..."}${lines ? ` (${lines} lines)` : ""}`;
		}
		case "edit": {
			const edits = Array.isArray(args?.edits) ? args.edits.length : 0;
			return `edit ${shortenPath(args?.path) || "..."}${edits > 1 ? ` (${edits} edits)` : ""}`;
		}
		case "grep": {
			const pattern = args?.pattern ? quote(String(args.pattern)) : "...";
			const path = shortenPath(args?.path) || ".";
			return `grep ${pattern} ${path}${args?.glob ? ` (${args.glob})` : ""}`;
		}
		case "find":
			return `find ${args?.pattern ? quote(String(args.pattern)) : "..."} ${shortenPath(args?.path) || "."}`;
		case "ls":
			return `ls ${shortenPath(args?.path) || "."}`;
		default:
			return `${name} ${safeJson(args ?? {})}`;
	}
}

function resultPreview(result: any, isPartial = false): string {
	const text = Array.isArray(result?.content)
		? result.content.find((c: any) => c?.type === "text" && typeof c.text === "string")?.text
		: undefined;
	if (!text) return isPartial ? "running" : "";
	const lines = String(text).trim().split("\n").filter(Boolean);
	if (lines.length === 0) return isPartial ? "running" : "";
	if (lines.length === 1) return lines[0];
	return `${lines.length} lines`;
}

function summarizeBurst(tools: ToolInfo[]): string {
	const counts = new Map<string, number>();
	for (const tool of tools) {
		counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([name, count]) => `${count} ${name}`)
		.join(", ");
}

function resetToolRun() {
	state.toolsById = new Map();
	state.currentNoiseBurst = [];
	state.hiddenToolIds = new Set();
	updateStatus();
}

function resetThinkingSignals() {
	state.lastThinkingSignalComponent = undefined;
	state.thinkingSignalCount = 0;
}

function updateStatus(ctx?: ExtensionContext) {
	if (ctx) {
		state.ui = ctx.ui;
		state.currentTheme = ctx.ui.theme;
	}
	// Compact transcript no longer occupies Pi's footer/status line. Keep this
	// helper as a centralized cleanup point for users who have older persisted
	// config entries with status enabled.
	state.ui?.setStatus(STATUS_KEY, undefined);
}

function setToolHidden(info: ToolInfo, hidden: boolean) {
	info.hidden = hidden;
	if (hidden) state.hiddenToolIds.add(info.id);
	else state.hiddenToolIds.delete(info.id);
	updateStatus();
}

function upsertToolInfo(id: string, name: string, args: any, invalidate?: () => void): ToolInfo {
	let info = state.toolsById.get(id);
	if (!info) {
		info = { id, name, args, preview: previewFor(name, args), kind: classifyTool(name, args) };
		state.toolsById.set(id, info);
	}
	info.name = name;
	info.args = args;
	info.preview = previewFor(name, args);
	info.kind = classifyTool(name, args);
	if (invalidate) info.invalidate = invalidate;
	return info;
}

function beginTool(id: string, name: string, args: any) {
	const previousNoise = state.currentNoiseBurst[state.currentNoiseBurst.length - 1];
	const info = upsertToolInfo(id, name, args);
	setToolHidden(info, false);
	info.burstCount = 1;
	info.burstSummary = undefined;

	if (!isEnabled() || info.kind !== "noise") {
		state.currentNoiseBurst = [];
		return;
	}

	if (!state.currentNoiseBurst.some((tool) => tool.id === id)) state.currentNoiseBurst.push(info);
	const summary = summarizeBurst(state.currentNoiseBurst);
	for (const tool of state.currentNoiseBurst) tool.burstSummary = summary;

	if (!isDebugMode()) {
		for (const tool of state.currentNoiseBurst.slice(0, -1)) setToolHidden(tool, true);
	}
	info.burstCount = state.currentNoiseBurst.length;
	previousNoise?.invalidate?.();
}

function updateToolResult(toolCallId: string, result: any, isError = false, isPartial = false) {
	const info = state.toolsById.get(toolCallId);
	if (!info) return;
	const suffix = resultPreview(result, isPartial);
	if (suffix) info.result = suffix;
	if (isError) {
		info.isError = true;
		setToolHidden(info, false);
	}
	info.invalidate?.();
}

function compactToolLine(
	toolCallId: string,
	name: string,
	args: any,
	theme: Theme,
	invalidate?: () => void,
	result?: any,
	isError = false,
	isPartial = false,
): string {
	let info = state.toolsById.get(toolCallId);

	// Hydration/resume path: compact the individual row, but do not mutate burst
	// state or invalidate older rows while pi is rebuilding chat history.
	if (!state.agentActive && !info) {
		const suffix = resultPreview(result, isPartial);
		const preview = previewFor(name, args);
		const details = suffix ? `${preview} {${oneLine(suffix)}}` : preview;
		return theme.fg("muted", limitPlain(details));
	}

	info = upsertToolInfo(toolCallId, name, args, invalidate);
	const suffix = resultPreview(result, isPartial);
	if (suffix) info.result = suffix;
	if (isError) {
		info.isError = true;
		setToolHidden(info, false);
	}
	if (info.hidden) return "";

	const status = info.result ? ` {${oneLine(info.result)}}` : isPartial ? " {running}" : "";
	const details = `${info.preview}${status}`;
	if (info.kind !== "noise" || (info.burstCount ?? 1) <= 1 || isDebugMode()) {
		const marker = info.kind === "mutation" ? theme.fg("warning", "◆ ") : isDebugMode() ? theme.fg("dim", "· ") : "";
		return marker + theme.fg("muted", limitPlain(details));
	}

	const summary = info.burstSummary || summarizeBurst(state.currentNoiseBurst);
	const prefix = `Used ${info.burstCount} tools`;
	const middle = summary ? `: ${summary} · latest ` : " ";
	const prefixText = `${prefix}${middle}`;
	return (
		theme.fg("toolTitle", prefixText) +
		theme.fg("muted", limitPlain(details, previewWidth((process.stdout.columns || 100) - prefixText.length)))
	);
}

function shouldUseOriginalToolRow(row: any, info: ToolInfo): boolean {
	if (!isEnabled()) return true;
	if (row.expanded) return true;
	if (info.kind === "always") return true;
	if (info.isError && state.config.showFailedTools) return true;
	return false;
}

function patchToolExecutionComponent() {
	const proto = ToolExecutionComponent.prototype as any;
	if (typeof proto.updateDisplay !== "function" || typeof proto.render !== "function") return;
	const existing = proto[TOOL_PATCH_KEY] as
		| { originalUpdateDisplay: (...args: any[]) => any; originalRender: (...args: any[]) => any }
		| undefined;
	const originalUpdateDisplay = existing?.originalUpdateDisplay ?? proto.updateDisplay;
	const originalRender = existing?.originalRender ?? proto.render;

	proto.updateDisplay = function patchedUpdateDisplay() {
		if (!this.toolCallId || !this.toolName || !this.selfRenderContainer || typeof this.selfRenderContainer.clear !== "function") {
			this.__compactTranscriptForceSelf = false;
			return originalUpdateDisplay.call(this);
		}

		const invalidate = () => {
			this.invalidate();
			this.ui?.requestRender?.();
		};
		const info = upsertToolInfo(this.toolCallId, this.toolName, this.args, invalidate);
		if (this.result?.isError) {
			info.isError = true;
			setToolHidden(info, false);
		}

		if (shouldUseOriginalToolRow(this, info)) {
			setToolHidden(info, false);
			this.__compactTranscriptForceSelf = false;
			return originalUpdateDisplay.call(this);
		}

		this.__compactTranscriptForceSelf = true;
		this.hideComponent = false;
		this.selfRenderContainer.clear();
		for (const image of this.imageComponents ?? []) this.removeChild?.(image);
		for (const spacer of this.imageSpacers ?? []) this.removeChild?.(spacer);
		this.imageComponents = [];
		this.imageSpacers = [];

		const theme = state.currentTheme;
		if (!theme) {
			this.__compactTranscriptForceSelf = false;
			return originalUpdateDisplay.call(this);
		}

		const line = compactToolLine(
			this.toolCallId,
			this.toolName,
			this.args,
			theme,
			invalidate,
			this.result,
			this.result?.isError ?? false,
			this.isPartial,
		);

		if (!line) {
			this.hideComponent = true;
			return;
		}

		this.selfRenderContainer.addChild(new Text(line, 0, 0));
	};

	proto.render = function patchedRender(width: number) {
		if (this.hideComponent) return [];
		if (this.__compactTranscriptForceSelf) return this.selfRenderContainer.render(width);
		return originalRender.call(this, width);
	};

	proto[TOOL_PATCH_KEY] = { version: PATCH_VERSION, originalUpdateDisplay, originalRender };
}

function patchAssistantMessageComponent() {
	const proto = AssistantMessageComponent.prototype as any;
	if (typeof proto.updateContent !== "function") return;
	const existing = proto[ASSISTANT_PATCH_KEY] as { originalUpdateContent: (...args: any[]) => any } | undefined;
	const originalUpdateContent = existing?.originalUpdateContent ?? proto.updateContent;

	proto.updateContent = function patchedUpdateContent(message: any) {
		if (!isEnabled() || !this.hideThinkingBlock || !Array.isArray(message?.content)) {
			this.__compactTranscriptHiddenThinkingSignal = false;
			return originalUpdateContent.call(this, message);
		}
		if (!this.contentContainer || typeof this.contentContainer.clear !== "function") {
			this.__compactTranscriptHiddenThinkingSignal = false;
			return originalUpdateContent.call(this, message);
		}

		this.lastMessage = message;
		this.contentContainer.clear();

		const hasText = message.content.some((c: any) => c.type === "text" && c.text?.trim());
		const hasThinking = message.content.some((c: any) => c.type === "thinking" && c.thinking?.trim());
		this.hasToolCalls = message.content.some((c: any) => c.type === "toolCall");

		// Only aggressive mode coalesces thinking-only assistant messages across
		// tool turns. Balanced mode should preserve normal hidden-thinking markers
		// so users can still see where the model thought before tool use.
		const thinkingSignal = state.agentActive && hasThinking && !hasText;
		const coalesceThinkingSignals = state.config.mode === "aggressive";
		if (!coalesceThinkingSignals) {
			this.__compactTranscriptHiddenThinkingSignal = false;
			if (!thinkingSignal && hasText) resetThinkingSignals();
		} else {
			if (this.__compactTranscriptHiddenThinkingSignal) return;
			if (thinkingSignal && state.lastThinkingSignalComponent !== this) {
				if (state.lastThinkingSignalComponent) {
					state.lastThinkingSignalComponent.__compactTranscriptHiddenThinkingSignal = true;
					state.lastThinkingSignalComponent.invalidate?.();
				}
				state.lastThinkingSignalComponent = this;
				state.thinkingSignalCount++;
			} else if (!thinkingSignal && hasText) {
				resetThinkingSignals();
			}
		}

		const visible = message.content.filter(
			(c: any) => (c.type === "text" && c.text?.trim()) || (c.type === "thinking" && c.thinking?.trim()),
		);
		if (visible.length) this.contentContainer.addChild(new Spacer(1));

		let renderedThinkingSignal = false;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text?.trim()) {
				this.contentContainer.addChild(new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme));
				continue;
			}
			if (content.type !== "thinking" || !content.thinking?.trim()) continue;

			let count = 1;
			while (message.content[i + count]?.type === "thinking" && message.content[i + count]?.thinking?.trim()) {
				count++;
			}
			i += count - 1;

			if (coalesceThinkingSignals && thinkingSignal) {
				if (renderedThinkingSignal) continue;
				count = Math.max(count, state.thinkingSignalCount);
				renderedThinkingSignal = true;
			}

			const label = count > 1 ? `${LABEL} (${count}x)` : LABEL;
			const theme = state.currentTheme;
			if (theme) {
				this.contentContainer.addChild(new Text(theme.italic(theme.fg("thinkingText", label)), this.outputPad, 0));
			} else {
				this.contentContainer.addChild(new Text(label, this.outputPad, 0));
			}

			const hasVisibleAfter = message.content
				.slice(i + 1)
				.some((c: any) => (c.type === "text" && c.text?.trim()) || (c.type === "thinking" && c.thinking?.trim()));
			if (hasVisibleAfter) this.contentContainer.addChild(new Spacer(1));
		}
	};

	proto[ASSISTANT_PATCH_KEY] = { version: PATCH_VERSION, originalUpdateContent };
}

function patchRenderers() {
	patchToolExecutionComponent();
	patchAssistantMessageComponent();
}

function thinkingLabel() {
	return state.consecutiveThinking > 1 ? `${LABEL} (${state.consecutiveThinking}x)` : LABEL;
}

function applyThinkingLabel(ctx: ExtensionContext) {
	if (!isEnabled()) {
		ctx.ui.setHiddenThinkingLabel();
		return;
	}
	ctx.ui.setHiddenThinkingLabel(thinkingLabel());
}

function restoreConfigFromBranch(ctx: ExtensionContext) {
	let nextConfig = cloneConfig(DEFAULT_CONFIG);
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === CONFIG_ENTRY_TYPE) {
			nextConfig = normalizeConfig(entry.data);
		}
	}
	state.config = nextConfig;
}

function persistConfig(pi: ExtensionAPI) {
	pi.appendEntry(CONFIG_ENTRY_TYPE, cloneConfig(state.config));
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["on", "true", "yes", "1", "enabled"].includes(normalized)) return true;
	if (["off", "false", "no", "0", "disabled"].includes(normalized)) return false;
	return undefined;
}

function splitList(value: string): string[] {
	return value
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function formatList(values: string[]): string {
	return values.length ? values.join(", ") : "(none)";
}

function formatTemplatesInput(templates = state.config.previewTemplates): string {
	return Object.entries(templates)
		.map(([tool, template]) => `${tool}=${template}`)
		.join("; ");
}

function formatTemplatesDisplay(): string {
	const keys = Object.keys(state.config.previewTemplates);
	return keys.length ? keys.join(", ") : "(none)";
}

function parseTemplatesInput(value: string): Record<string, string> {
	const trimmed = value.trim();
	if (!trimmed || trimmed === "clear") return {};
	const entries: Record<string, string> = {};
	for (const part of trimmed.split(/;\s*/)) {
		const index = part.indexOf("=");
		if (index <= 0) continue;
		const key = part.slice(0, index).trim();
		const template = part.slice(index + 1).trim();
		if (key && template) entries[key] = template;
	}
	return entries;
}

function describeConfig(): string {
	return [
		`mode: ${state.config.mode}`,
		`custom tools: ${state.config.compactCustomTools ? "on" : "off"}`,
		`failed tools visible: ${state.config.showFailedTools ? "on" : "off"}`,
		`bash mutation anchors: ${state.config.showBashMutations ? "on" : "off"}`,
		`always show: ${formatList(state.config.alwaysShowTools)}`,
		`mutation tools: ${formatList(state.config.mutationTools)}`,
		`templates: ${formatTemplatesDisplay()}`,
	].join("\n");
}

function commandHelp(): string {
	return [
		"/compact-transcript [status]",
		"/compact-transcript disabled|balanced|aggressive|debug",
		"/compact-transcript custom-tools on|off",
		"/compact-transcript failed on|off",
		"/compact-transcript bash-mutations on|off",
		"/compact-transcript always-show <tool[,tool]|/regex/|clear>",
		"/compact-transcript mutation-tools <tool[,tool]|/regex/|clear>",
		"/compact-transcript template <tool|/regex/> <template|clear>",
		"  template placeholders: {name}, {args}, {path}, {command}, {arg.foo}",
	].join("\n");
}

function setMode(mode: Mode) {
	state.config.mode = mode === "off" ? "disabled" : mode;
	if (mode === "aggressive") {
		state.config.compactCustomTools = true;
		state.config.showFailedTools = true;
		state.config.showBashMutations = true;
	}
	if (mode === "debug") {
		state.config.compactCustomTools = true;
		state.config.showFailedTools = true;
	}
}

function onOff(value: boolean): "on" | "off" {
	return value ? "on" : "off";
}

function createInputSubmenu(
	title: string,
	prefill: string,
	done: (selectedValue?: string) => void,
	help: string,
): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void } {
	const input = new Input();
	input.setValue(prefill);
	// Input intentionally keeps cursor position when setValue() is called; for
	// edit-in-place settings, start at the end like a normal command-line field.
	(input as any).cursor = prefill.length;
	input.onSubmit = (value) => done(value.trim());
	input.onEscape = () => done(undefined);
	return {
		render(width: number) {
			const theme = state.currentTheme;
			const container = new Container();
			container.addChild(new Text(theme ? theme.fg("accent", theme.bold(title)) : title, 0, 0));
			container.addChild(new Text(theme ? theme.fg("dim", help) : help, 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(input);
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme ? theme.fg("dim", "Enter saves · Esc cancels") : "Enter saves · Esc cancels", 0, 0));
			return container.render(width);
		},
		handleInput(data: string) {
			input.handleInput(data);
		},
		invalidate() {
			input.invalidate();
		},
	};
}

function buildSettingsItems(): SettingItem[] {
	return [
		{
			id: "mode",
			label: "Mode",
			currentValue: state.config.mode,
			values: ["balanced", "aggressive", "debug", "disabled"],
			description:
				"balanced compacts normal tool bursts; aggressive uses shorter previews; debug keeps rows visible while tuning; disabled turns compact-transcript rendering and footer status off.",
		},
		{
			id: "customTools",
			label: "Custom tools",
			currentValue: onOff(state.config.compactCustomTools),
			values: ["on", "off"],
			description: "When on, compact custom/external tools added by extensions. When off, only built-in tools are compacted.",
		},
		{
			id: "failedTools",
			label: "Show failures",
			currentValue: onOff(state.config.showFailedTools),
			values: ["on", "off"],
			description: "Keep failed tools visible even when they are part of an otherwise compacted burst.",
		},
		{
			id: "bashMutations",
			label: "Bash anchors",
			currentValue: onOff(state.config.showBashMutations),
			values: ["on", "off"],
			description: "Keep destructive-looking bash commands visible as anchors and break compact tool bursts around them.",
		},
		{
			id: "alwaysShowTools",
			label: "Always show",
			currentValue: formatList(state.config.alwaysShowTools),
			description: "Press Enter to edit comma-separated tool names, wildcards, or /regex/ rules that should always stay visible.",
			submenu: (_currentValue, done) =>
				createInputSubmenu(
					"Always show tools",
					state.config.alwaysShowTools.join(", "),
					done,
					"Comma-separated names, wildcards, or /regex/. Empty input clears the list.",
				),
		},
		{
			id: "mutationTools",
			label: "Mutation tools",
			currentValue: formatList(state.config.mutationTools),
			description: "Press Enter to edit comma-separated tool names, wildcards, or /regex/ rules that act as mutation anchors.",
			submenu: (_currentValue, done) =>
				createInputSubmenu(
					"Mutation tools",
					state.config.mutationTools.join(", "),
					done,
					"Comma-separated names, wildcards, or /regex/. Empty input clears the list.",
				),
		},
		{
			id: "templates",
			label: "Templates",
			currentValue: formatTemplatesDisplay(),
			description: "Press Enter to edit preview templates as semicolon-separated tool=template pairs.",
			submenu: (_currentValue, done) =>
				createInputSubmenu(
					"Preview templates",
					formatTemplatesInput(),
					done,
					"Use tool=template; /regex/=template. Placeholders: {name}, {args}, {path}, {command}, {arg.foo}.",
				),
		},
		{
			id: "reset",
			label: "Reset defaults",
			currentValue: "press enter",
			values: ["press enter"],
			description: "Restore the default compact-transcript configuration.",
		},
	];
}

function applySettingsItem(id: string, value: string, pi: ExtensionAPI, ctx: ExtensionContext) {
	switch (id) {
		case "mode":
			setMode(value as Mode);
			break;
		case "customTools":
			state.config.compactCustomTools = value === "on";
			break;
		case "failedTools":
			state.config.showFailedTools = value === "on";
			break;
		case "bashMutations":
			state.config.showBashMutations = value === "on";
			break;
		case "alwaysShowTools":
			state.config.alwaysShowTools = splitList(value);
			break;
		case "mutationTools":
			state.config.mutationTools = splitList(value);
			break;
		case "templates":
			state.config.previewTemplates = parseTemplatesInput(value);
			break;
		case "reset":
			state.config = cloneConfig(DEFAULT_CONFIG);
			break;
		default:
			return;
	}
	persistConfig(pi);
	applyThinkingLabel(ctx);
	updateStatus(ctx);
}

async function showSettingsPanel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(describeConfig(), "info");
		return;
	}
	state.currentTheme = ctx.ui.theme;

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let settingsList: SettingsList;
		const refreshValues = () => {
			for (const item of buildSettingsItems()) {
				settingsList.updateValue(item.id, item.currentValue);
			}
		};

		settingsList = new SettingsList(
			buildSettingsItems(),
			9,
			getSettingsListTheme(),
			(id, value) => {
				applySettingsItem(id, value, pi, ctx);
				refreshValues();
				tui.requestRender();
			},
			() => done(undefined),
		);

		return {
			render(width: number) {
				state.currentTheme = theme;
				const title = theme.fg("accent", theme.bold("Compact Transcript"));
				const subtitle = theme.fg("dim", "Configure transcript compaction. Enter/Space changes selected item; Esc closes.");
				const container = new Container();
				container.addChild(new Text(title, 0, 0));
				container.addChild(new Text(subtitle, 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(settingsList);
				return container.render(width);
			},
			invalidate() {
				settingsList.invalidate();
			},
			handleInput(data: string) {
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

function registerCommand(pi: ExtensionAPI) {
	pi.registerCommand("compact-transcript", {
		description: "Configure compact transcript rendering: disabled, balanced, aggressive, debug, and tool rules.",
		getArgumentCompletions(prefix: string) {
			const commands = [
				"status",
				"help",
				"reset",
				"disabled",
				"off",
				"balanced",
				"aggressive",
				"debug",
				"custom-tools on",
				"custom-tools off",
				"failed on",
				"failed off",
				"bash-mutations on",
				"bash-mutations off",
				"always-show clear",
				"mutation-tools clear",
				"template ",
			];
			return commands
				.filter((value) => value.startsWith(prefix.trimStart()))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed || trimmed === "status" || trimmed === "help") {
				updateStatus(ctx);
				await showSettingsPanel(pi, ctx);
				return;
			}
			if (trimmed === "reset") {
				state.config = cloneConfig(DEFAULT_CONFIG);
				persistConfig(pi);
				applyThinkingLabel(ctx);
				updateStatus(ctx);
				await showSettingsPanel(pi, ctx);
				return;
			}
			if (["disabled", "off", "balanced", "aggressive", "debug"].includes(trimmed)) {
				setMode(trimmed as Mode);
				persistConfig(pi);
				applyThinkingLabel(ctx);
				updateStatus(ctx);
				await showSettingsPanel(pi, ctx);
				return;
			}

			const [command, ...rest] = trimmed.split(/\s+/);
			const restText = rest.join(" ").trim();
			if (command === "custom-tools" || command === "failed" || command === "bash-mutations") {
				const value = parseBoolean(rest[0]);
				if (value === undefined) {
					ctx.ui.notify(`Usage: /compact-transcript ${command} on|off`, "error");
					return;
				}
				if (command === "custom-tools") state.config.compactCustomTools = value;
				if (command === "failed") state.config.showFailedTools = value;
				if (command === "bash-mutations") state.config.showBashMutations = value;
				persistConfig(pi);
				updateStatus(ctx);
				await showSettingsPanel(pi, ctx);
				return;
			}

			if (command === "always-show" || command === "mutation-tools") {
				if (!restText) {
					await showSettingsPanel(pi, ctx);
					return;
				}
				const values = restText === "clear" ? [] : splitList(restText);
				if (command === "always-show") state.config.alwaysShowTools = values;
				else state.config.mutationTools = values;
				persistConfig(pi);
				updateStatus(ctx);
				await showSettingsPanel(pi, ctx);
				return;
			}

			if (command === "template") {
				const [tool, ...templateParts] = rest;
				if (!tool) {
					await showSettingsPanel(pi, ctx);
					return;
				}
				const template = templateParts.join(" ").trim();
				if (!template) {
					await showSettingsPanel(pi, ctx);
					return;
				}
				if (template === "clear") delete state.config.previewTemplates[tool];
				else state.config.previewTemplates[tool] = template;
				persistConfig(pi);
				updateStatus(ctx);
				await showSettingsPanel(pi, ctx);
				return;
			}

			if (ctx.mode === "tui") await showSettingsPanel(pi, ctx);
			else ctx.ui.notify(commandHelp(), "error");
		},
	});
}

export default function compactTranscript(pi: ExtensionAPI) {
	patchRenderers();
	registerCommand(pi);

	pi.on("session_start", async (_event, ctx) => {
		restoreConfigFromBranch(ctx);
		state.ui = ctx.ui;
		state.currentTheme = ctx.ui.theme;
		applyThinkingLabel(ctx);
		ctx.ui.setWorkingMessage();
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setHiddenThinkingLabel();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWorkingMessage();
	});

	pi.on("agent_start", (_event, ctx) => {
		state.agentActive = true;
		state.currentTheme = ctx.ui.theme;
		resetToolRun();
		resetThinkingSignals();
		state.consecutiveThinking = 0;
		applyThinkingLabel(ctx);
		updateStatus(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		state.agentActive = false;
		state.currentNoiseBurst = [];
		resetThinkingSignals();
		updateStatus(ctx);
	});

	pi.on("turn_start", (_event, ctx) => {
		state.consecutiveThinking = 0;
		state.currentTheme = ctx.ui.theme;
		applyThinkingLabel(ctx);
		updateStatus(ctx);
	});

	pi.on("message_update", (event, ctx) => {
		state.currentTheme = ctx.ui.theme;
		const type = event.assistantMessageEvent?.type;
		if (type === "thinking_start") {
			state.consecutiveThinking++;
			applyThinkingLabel(ctx);
			return;
		}
		if (type && !type.startsWith("thinking_")) {
			state.consecutiveThinking = 0;
			applyThinkingLabel(ctx);
			if (type === "text_delta" || type === "text_start") {
				resetToolRun();
				resetThinkingSignals();
			}
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		state.currentTheme = ctx.ui.theme;
		beginTool(event.toolCallId, event.toolName, event.args);
		updateStatus(ctx);
	});

	pi.on("tool_execution_update", (event, ctx) => {
		state.currentTheme = ctx.ui.theme;
		updateToolResult(event.toolCallId, event.partialResult, false, true);
		updateStatus(ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		state.currentTheme = ctx.ui.theme;
		updateToolResult(event.toolCallId, event.result, event.isError, false);
		updateStatus(ctx);
	});
}
