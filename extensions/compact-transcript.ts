import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

// Older versions of this extension wrote a footer status under this key; it is
// kept only to clear that status once per session for users upgrading in place.
const STATUS_KEY = "compact-transcript";
const CONFIG_ENTRY_TYPE = "compact-transcript-config";
const SUMMARY_ENTRY_TYPE = "compact-transcript-summary";

const MIN_PREVIEW_WIDTH = 20;
const MAX_PREVIEW_WIDTH = 104;
// Leave room for pi's row gutter/padding so compact lines never wrap.
const PREVIEW_MARGIN = 6;
const BLINK_INTERVAL_MS = 400;
// Status marker is two cells wide ("◆ ").
const MARKER_WIDTH = 2;

type CompactTranscriptConfig = {
	enabled: boolean;
};

type ToolInfo = {
	id: string;
	name: string;
	args: any;
	preview: string;
	hidden?: boolean;
	running?: boolean;
	burstCount?: number;
	startedAt?: number;
	durationMs?: number;
	burstDurationMs?: number;
	result?: string;
	isError?: boolean;
	invalidate?: () => void;
};

type RunStats = {
	startedAt: number;
	toolCount: number;
	readFiles: Set<string>;
	editFiles: Set<string>;
	commandCount: number;
	otherCount: number;
	failedCount: number;
};

type SummaryData = {
	reads: number;
	edits: number;
	commands: number;
	others: number;
	failed: number;
	durationMs: number;
};

type RuntimeState = {
	config: CompactTranscriptConfig;
	toolsById: Map<string, ToolInfo>;
	currentBurst: ToolInfo[];
	hiddenToolIds: Set<string>;
	runningToolIds: Set<string>;
	agentActive: boolean;
	blinkOn: boolean;
	blinkTimer?: ReturnType<typeof setInterval>;
	runStats: RunStats;
	// Live transcript components, so toggling can re-render existing rows.
	toolComponents: Set<any>;
	assistantComponents: Set<any>;
	currentTheme?: Theme;
	thinkingHidden: boolean;
	currentThoughtHeading?: string;
	thoughtAnchorId?: string;
};

const DEFAULT_CONFIG: CompactTranscriptConfig = {
	enabled: true,
};

const STATE_KEY = Symbol.for("pi-compact-transcript.state");
const TOOL_PATCH_KEY = Symbol.for("pi-compact-transcript.tool-patch");
const ASSISTANT_PATCH_KEY = Symbol.for("pi-compact-transcript.assistant-patch");

function newRunStats(): RunStats {
	return {
		startedAt: Date.now(),
		toolCount: 0,
		readFiles: new Set(),
		editFiles: new Set(),
		commandCount: 0,
		otherCount: 0,
		failedCount: 0,
	};
}

function normalizeConfig(input: unknown): CompactTranscriptConfig {
	const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	let enabled = DEFAULT_CONFIG.enabled;
	if (typeof source.enabled === "boolean") {
		enabled = source.enabled;
	} else if (typeof source.mode === "string") {
		// Pre-0.5 config persisted a mode string instead of an enabled flag.
		enabled = source.mode !== "disabled" && source.mode !== "off";
	}
	return { enabled };
}

function getState(): RuntimeState {
	const globalWithState = globalThis as typeof globalThis & { [STATE_KEY]?: RuntimeState };
	globalWithState[STATE_KEY] ??= {
		config: { ...DEFAULT_CONFIG },
		toolsById: new Map(),
		currentBurst: [],
		hiddenToolIds: new Set(),
		runningToolIds: new Set(),
		agentActive: false,
		blinkOn: true,
		runStats: newRunStats(),
		toolComponents: new Set(),
		assistantComponents: new Set(),
		thinkingHidden: true,
	};
	const runtimeState = globalWithState[STATE_KEY]!;
	// /reload keeps the global object alive; initialize fields added by newer
	// versions when an older extension instance created the state object.
	runtimeState.thinkingHidden ??= true;
	return runtimeState;
}

const state = getState();

function isEnabled(): boolean {
	return state.config.enabled;
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
	return Math.max(MIN_PREVIEW_WIDTH, Math.min(MAX_PREVIEW_WIDTH, base - PREVIEW_MARGIN));
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

// Sub-second durations render as "" so fast tools stay clutter-free.
function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 1000) return "";
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
}

// Checked in order; earlier keys are more likely to be the argument a human
// would recognize the call by.
const PREFERRED_ARG_KEYS = [
	"command",
	"code",
	"query",
	"pattern",
	"path",
	"file_path",
	"filePath",
	"file",
	"url",
	"prompt",
	"text",
	"description",
	"name",
];
const PATH_ARG_KEYS = new Set(["path", "file_path", "filePath", "file"]);

function previewFor(name: string, args: any): string {
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
		default: {
			// Unknown tools: show the most meaningful string argument instead of
			// dumping the whole args object as JSON.
			if (args && typeof args === "object") {
				for (const key of PREFERRED_ARG_KEYS) {
					const value = (args as Record<string, unknown>)[key];
					if (isNonEmptyString(value)) {
						const rendered = PATH_ARG_KEYS.has(key) ? shortenPath(value) : oneLine(value);
						return `${name} ${rendered}`;
					}
				}
				const firstString = Object.values(args).find(isNonEmptyString);
				if (firstString) return `${name} ${oneLine(firstString)}`;
			}
			return `${name} ${safeJson(args ?? {})}`;
		}
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

function resetToolRun() {
	state.toolsById = new Map();
	state.currentBurst = [];
	state.hiddenToolIds = new Set();
	state.runningToolIds = new Set();
	state.currentThoughtHeading = undefined;
	state.thoughtAnchorId = undefined;
	stopBlinkTimer();
}

function captureTheme(ctx: ExtensionContext) {
	state.currentTheme = ctx.ui.theme;
}

function setToolHidden(info: ToolInfo, hidden: boolean) {
	info.hidden = hidden;
	if (hidden) state.hiddenToolIds.add(info.id);
	else state.hiddenToolIds.delete(info.id);
}

function applyResult(info: ToolInfo, result: any, isError: boolean, isPartial: boolean) {
	const suffix = resultPreview(result, isPartial);
	if (suffix) info.result = suffix;
	if (isError) {
		info.isError = true;
		// A failed tool always gets its own visible row, even if a burst had
		// hidden it; render it as itself rather than as a burst summary.
		info.burstCount = 1;
		setToolHidden(info, false);
	}
}

function ensureBlinkTimer() {
	if (state.blinkTimer || state.runningToolIds.size === 0) return;
	state.blinkTimer = setInterval(() => {
		if (state.runningToolIds.size === 0) {
			stopBlinkTimer();
			return;
		}
		state.blinkOn = !state.blinkOn;
		for (const id of state.runningToolIds) state.toolsById.get(id)?.invalidate?.();
	}, BLINK_INTERVAL_MS);
	state.blinkTimer.unref?.();
}

function stopBlinkTimer() {
	if (state.blinkTimer) clearInterval(state.blinkTimer);
	state.blinkTimer = undefined;
	state.blinkOn = true;
}

function statusMarker(theme: Theme, opts: { running?: boolean; isError?: boolean; hasResult?: boolean }): string {
	if (opts.isError) return theme.fg("error", "◆ ");
	if (opts.running) return theme.fg("dim", state.blinkOn ? "◆ " : "◇ ");
	if (opts.hasResult) return theme.fg("success", "◆ ");
	return theme.fg("dim", "◆ ");
}

function textSignalHasVisibleContent(assistantMessageEvent: any): boolean {
	const type = assistantMessageEvent?.type;
	if (type === "text_delta") {
		return typeof assistantMessageEvent.delta === "string" && assistantMessageEvent.delta.trim().length > 0;
	}
	if (type === "text_end") {
		return typeof assistantMessageEvent.content === "string" && assistantMessageEvent.content.trim().length > 0;
	}
	return false;
}

function thoughtTickerEnabled(): boolean {
	// The ticker is a compact replacement for hidden thinking. When thinking is
	// fully visible, showing the same headline under a tool would be duplicate.
	return isEnabled() && state.thinkingHidden;
}

function cleanThoughtHeading(line: string): string {
	let clean = oneLine(line)
		.replace(/^#{1,6}\s+/, "")
		.replace(/^[-*]\s+/, "")
		.trim();
	clean = clean
		.replace(/^\*\*(.+)\*\*$/, "$1")
		.replace(/^__(.+)__$/, "$1")
		.replace(/^`(.+)`$/, "$1");
	return clean.trim();
}

function extractThoughtHeading(text: unknown): string {
	if (typeof text !== "string") return "";
	const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0);
	return firstLine ? cleanThoughtHeading(firstLine) : "";
}

function latestThoughtHeading(message: any): string {
	if (!Array.isArray(message?.content)) return "";
	for (let i = message.content.length - 1; i >= 0; i--) {
		const content = message.content[i];
		if (content?.type === "thinking") return extractThoughtHeading(content.thinking);
	}
	return "";
}

function invalidateToolById(id: string | undefined) {
	if (!id) return;
	state.toolsById.get(id)?.invalidate?.();
}

function latestVisibleTool(): ToolInfo | undefined {
	return Array.from(state.toolsById.values())
		.reverse()
		.find((tool) => !tool.hidden);
}

function clearCurrentThought() {
	if (!state.currentThoughtHeading && !state.thoughtAnchorId) return;
	const previousAnchorId = state.thoughtAnchorId;
	state.currentThoughtHeading = undefined;
	state.thoughtAnchorId = undefined;
	invalidateToolById(previousAnchorId);
}

function setCurrentThought(heading: string) {
	const nextHeading = oneLine(heading);
	if (!thoughtTickerEnabled() || !nextHeading) {
		clearCurrentThought();
		return;
	}

	const previousAnchorId = state.thoughtAnchorId;
	const nextAnchorId = latestVisibleTool()?.id;
	const changed = state.currentThoughtHeading !== nextHeading || previousAnchorId !== nextAnchorId;
	state.currentThoughtHeading = nextHeading;
	state.thoughtAnchorId = nextAnchorId;
	if (!changed) return;

	invalidateToolById(previousAnchorId);
	if (nextAnchorId !== previousAnchorId) invalidateToolById(nextAnchorId);
}

function updateCurrentThoughtFromMessage(message: any) {
	const heading = latestThoughtHeading(message);
	// A new thinking block starts empty; keep showing the previous heading until
	// the replacement has real text so the ticker does not blink off/on between
	// tool completion and the next streamed thought.
	if (heading) setCurrentThought(heading);
}

function anchorCurrentThoughtTo(info: ToolInfo) {
	if (!thoughtTickerEnabled() || !state.currentThoughtHeading || state.thoughtAnchorId === info.id) return;
	const previousAnchorId = state.thoughtAnchorId;
	state.thoughtAnchorId = info.id;
	invalidateToolById(previousAnchorId);
	info.invalidate?.();
}

function currentThoughtLine(toolCallId: string, theme: Theme): string {
	if (!thoughtTickerEnabled() || state.thoughtAnchorId !== toolCallId || !state.currentThoughtHeading) return "";
	const prefix = "  ↳ ";
	const budget = previewWidth((process.stdout.columns || 100) - prefix.length);
	return theme.fg("dim", prefix) + theme.fg("thinkingText", limitPlain(state.currentThoughtHeading, budget));
}

function upsertToolInfo(id: string, name: string, args: any, invalidate?: () => void): ToolInfo {
	let info = state.toolsById.get(id);
	if (!info) {
		info = { id, name, args, preview: previewFor(name, args) };
		state.toolsById.set(id, info);
	}
	info.name = name;
	info.args = args;
	info.preview = previewFor(name, args);
	if (invalidate) info.invalidate = invalidate;
	return info;
}

function recordToolStart(name: string, args: any) {
	const base = name.split(".").pop() ?? name;
	state.runStats.toolCount++;
	if (base === "read") {
		if (isNonEmptyString(args?.path)) state.runStats.readFiles.add(args.path);
	} else if (base === "edit" || base === "write") {
		if (isNonEmptyString(args?.path)) state.runStats.editFiles.add(args.path);
	} else if (base === "bash") {
		state.runStats.commandCount++;
	} else {
		state.runStats.otherCount++;
	}
}

function joinBurst(info: ToolInfo) {
	const previous = state.currentBurst[state.currentBurst.length - 1];

	if (!isEnabled()) {
		state.currentBurst = [];
		return;
	}

	// Bursts only group repeats of the same tool; a different tool starts a
	// fresh row (and leaves the previous row visible with its count).
	if (state.currentBurst.length && state.currentBurst[state.currentBurst.length - 1].name !== info.name) {
		state.currentBurst = [];
	}

	if (!state.currentBurst.some((tool) => tool.id === info.id)) state.currentBurst.push(info);
	for (const tool of state.currentBurst.slice(0, -1)) setToolHidden(tool, true);
	info.burstCount = state.currentBurst.length;
	previous?.invalidate?.();
}

function beginTool(id: string, name: string, args: any) {
	const info = upsertToolInfo(id, name, args);
	setToolHidden(info, false);
	info.burstCount = 1;
	info.running = true;
	info.isError = false;
	info.startedAt = Date.now();
	state.runningToolIds.add(id);
	ensureBlinkTimer();
	recordToolStart(name, args);
	joinBurst(info);
	anchorCurrentThoughtTo(info);
	// The component may already be on screen from argument streaming; repaint
	// now so the running marker, burst count, and thought ticker appear
	// immediately instead of waiting for the next result event or blink tick.
	info.invalidate?.();
}

// A tool row rendered without a live tool_execution_start event — pi is
// rebuilding chat history after resume/reload. Reconstruct burst grouping so
// scrollback coalesces the same way the live view did, but skip timers,
// stats, and running state.
function hydrateTool(id: string, name: string, args: any, isError: boolean): ToolInfo {
	const info = upsertToolInfo(id, name, args);
	setToolHidden(info, false);
	info.burstCount = 1;
	if (isError) {
		info.isError = true;
		state.currentBurst = [];
		return info;
	}
	joinBurst(info);
	return info;
}

function updateToolResult(toolCallId: string, result: any, isError = false, isPartial = false) {
	if (!isPartial) {
		state.runningToolIds.delete(toolCallId);
		if (state.runningToolIds.size === 0) stopBlinkTimer();
	}
	const info = state.toolsById.get(toolCallId);
	if (!info) return;
	if (!isPartial) {
		info.running = false;
		if (info.startedAt) info.durationMs = Date.now() - info.startedAt;
		if (state.currentBurst.includes(info) && state.currentBurst.length > 1) {
			info.burstDurationMs = state.currentBurst.reduce((total, tool) => total + (tool.durationMs ?? 0), 0);
		}
		if (isError) state.runStats.failedCount++;
	}
	applyResult(info, result, isError, isPartial);
	// A failure ends the current burst so the red row stays visible and the
	// next tool starts a fresh count.
	if (isError) state.currentBurst = [];
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
	if (!state.toolsById.has(toolCallId)) hydrateTool(toolCallId, name, args, isError);
	const info = upsertToolInfo(toolCallId, name, args, invalidate);
	applyResult(info, result, isError, isPartial);
	if (info.hidden) return "";

	const isBurst = (info.burstCount ?? 1) > 1;
	const durationText = formatDuration((isBurst ? (info.burstDurationMs ?? info.durationMs) : info.durationMs) ?? 0);
	const inner = [info.result ? oneLine(info.result) : "", durationText].filter(Boolean).join(" · ");
	const status = inner ? ` {${inner}}` : info.running ? " {running}" : "";
	const details = `${info.preview}${status}`;
	const marker = statusMarker(theme, {
		running: info.running,
		isError: info.isError,
		hasResult: result != null || !!info.result,
	});
	if (!isBurst) {
		return marker + theme.fg("muted", limitPlain(details));
	}

	const prefix = `${info.burstCount}× `;
	const budget = previewWidth((process.stdout.columns || 100) - prefix.length - MARKER_WIDTH);
	return marker + theme.fg("muted", prefix + limitPlain(details, budget));
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
			this.__compactTranscriptHidden = false;
			return originalUpdateDisplay.call(this);
		}
		state.toolComponents.add(this);

		const invalidate = () => {
			this.invalidate();
			this.ui?.requestRender?.();
		};
		// Must run before upsertToolInfo, which would make the row look
		// already-known and skip burst reconstruction for rehydrated history.
		if (!state.toolsById.has(this.toolCallId)) {
			hydrateTool(this.toolCallId, this.toolName, this.args, this.result?.isError ?? false);
		}
		const info = upsertToolInfo(this.toolCallId, this.toolName, this.args, invalidate);
		applyResult(info, this.result, this.result?.isError ?? false, this.isPartial);

		if (!isEnabled() || this.expanded) {
			setToolHidden(info, false);
			this.__compactTranscriptForceSelf = false;
			this.__compactTranscriptHidden = false;
			return originalUpdateDisplay.call(this);
		}

		this.__compactTranscriptForceSelf = true;
		this.__compactTranscriptHidden = false;
		this.selfRenderContainer.clear();
		for (const image of this.imageComponents ?? []) this.removeChild?.(image);
		for (const spacer of this.imageSpacers ?? []) this.removeChild?.(spacer);
		this.imageComponents = [];
		this.imageSpacers = [];

		const theme = state.currentTheme;
		if (!theme) {
			this.__compactTranscriptForceSelf = false;
			this.__compactTranscriptHidden = false;
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
			this.__compactTranscriptHidden = true;
			return;
		}

		this.selfRenderContainer.addChild(new Text(line, 0, 0));
		const thoughtLine = currentThoughtLine(this.toolCallId, theme);
		if (thoughtLine) this.selfRenderContainer.addChild(new Text(thoughtLine, 0, 0));
	};

	proto.render = function patchedRender(width: number) {
		if (this.hideComponent || this.__compactTranscriptHidden) return [];
		if (this.__compactTranscriptForceSelf) return this.selfRenderContainer.render(width);
		return originalRender.call(this, width);
	};

	proto[TOOL_PATCH_KEY] = { originalUpdateDisplay, originalRender };
}

function patchAssistantMessageComponent() {
	const proto = AssistantMessageComponent.prototype as any;
	if (typeof proto.updateContent !== "function") return;
	const existing = proto[ASSISTANT_PATCH_KEY] as { originalUpdateContent: (...args: any[]) => any } | undefined;
	const originalUpdateContent = existing?.originalUpdateContent ?? proto.updateContent;

	proto.updateContent = function patchedUpdateContent(message: any) {
		state.assistantComponents.add(this);
		state.thinkingHidden = !!this.hideThinkingBlock;
		if (!state.thinkingHidden) clearCurrentThought();
		if (!isEnabled() || !this.hideThinkingBlock || !Array.isArray(message?.content)) {
			return originalUpdateContent.call(this, message);
		}
		if (!this.contentContainer || typeof this.contentContainer.clear !== "function") {
			return originalUpdateContent.call(this, message);
		}

		this.lastMessage = message;
		this.contentContainer.clear();
		this.hasToolCalls = message.content.some((c: any) => c.type === "toolCall");

		// Thinking blocks are suppressed entirely; only real text is rendered.
		const texts = message.content.filter((c: any) => c.type === "text" && c.text?.trim());
		if (texts.length === 0) return;

		clearCurrentThought();
		// Assistant text ends a tool burst. The live path also does this via
		// message_update events; doing it here too keeps hydrated history from
		// grouping tool rows across turn boundaries.
		state.currentBurst = [];

		this.contentContainer.addChild(new Spacer(1));
		for (const content of texts) {
			this.contentContainer.addChild(new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme));
		}
	};

	proto[ASSISTANT_PATCH_KEY] = { originalUpdateContent };
}

function patchRenderers() {
	patchToolExecutionComponent();
	patchAssistantMessageComponent();
}

// Re-render every transcript row we have touched so toggling applies to the
// visible transcript immediately instead of only to future rows.
function refreshTranscript() {
	let ui: any;
	for (const component of state.toolComponents) {
		try {
			// ToolExecutionComponent.invalidate() re-runs updateDisplay.
			component.invalidate?.();
			ui ??= component.ui;
		} catch {
			state.toolComponents.delete(component);
		}
	}
	for (const component of state.assistantComponents) {
		try {
			if (component.lastMessage) component.updateContent?.(component.lastMessage);
			component.invalidate?.();
		} catch {
			state.assistantComponents.delete(component);
		}
	}
	ui?.requestRender?.();
}

function summaryLine(data: SummaryData): string {
	const plural = (count: number) => (count === 1 ? "" : "s");
	const parts: string[] = [];
	if (data.reads) parts.push(`read ${data.reads} file${plural(data.reads)}`);
	if (data.edits) parts.push(`edited ${data.edits} file${plural(data.edits)}`);
	if (data.commands) parts.push(`ran ${data.commands} command${plural(data.commands)}`);
	if (data.others) parts.push(`${data.others} other tool${plural(data.others)}`);
	if (data.failed) parts.push(`${data.failed} failed`);
	if (parts.length === 0) return "";
	const text = parts.join(", ");
	const capitalized = text[0].toUpperCase() + text.slice(1);
	const duration = formatDuration(data.durationMs);
	return duration ? `${capitalized} · ${duration}` : capitalized;
}

function normalizeSummary(input: unknown): SummaryData {
	const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
	return {
		reads: num(source.reads),
		edits: num(source.edits),
		commands: num(source.commands),
		others: num(source.others),
		failed: num(source.failed),
		durationMs: num(source.durationMs),
	};
}

function appendRunSummary(pi: ExtensionAPI) {
	const stats = state.runStats;
	// Single-tool runs are self-evident from the transcript; a summary line
	// would just repeat the row above it.
	if (!isEnabled() || stats.toolCount < 2) return;
	const data: SummaryData = {
		reads: stats.readFiles.size,
		edits: stats.editFiles.size,
		commands: stats.commandCount,
		others: stats.otherCount,
		failed: stats.failedCount,
		durationMs: Date.now() - stats.startedAt,
	};
	pi.appendEntry(SUMMARY_ENTRY_TYPE, data);
}

function restoreConfigFromBranch(ctx: ExtensionContext) {
	let nextConfig = { ...DEFAULT_CONFIG };
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === CONFIG_ENTRY_TYPE) {
			nextConfig = normalizeConfig(entry.data);
		}
	}
	state.config = nextConfig;
}

function setEnabled(enabled: boolean, pi: ExtensionAPI, ctx: ExtensionContext) {
	state.config.enabled = enabled;
	pi.appendEntry(CONFIG_ENTRY_TYPE, { ...state.config });
	refreshTranscript();
	ctx.ui.notify(`Compact transcript: ${enabled ? "on" : "off"}`, "info");
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["on", "true", "yes", "1", "enabled"].includes(normalized)) return true;
	if (["off", "false", "no", "0", "disabled"].includes(normalized)) return false;
	return undefined;
}

function registerCommand(pi: ExtensionAPI) {
	pi.registerCommand("compact-transcript", {
		description: "Toggle compact transcript rendering (on/off).",
		getArgumentCompletions(prefix: string) {
			return ["on", "off", "status"]
				.filter((value) => value.startsWith(prefix.trimStart()))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			captureTheme(ctx);
			const trimmed = args.trim().toLowerCase();
			if (trimmed === "status") {
				ctx.ui.notify(`Compact transcript: ${isEnabled() ? "on" : "off"}`, "info");
				return;
			}
			if (!trimmed) {
				setEnabled(!isEnabled(), pi, ctx);
				return;
			}
			// on/off, plus pre-0.5 mode names as legacy aliases.
			const legacyOn = ["balanced", "aggressive", "debug"].includes(trimmed);
			const parsed = legacyOn ? true : parseBoolean(trimmed);
			if (parsed !== undefined) {
				setEnabled(parsed, pi, ctx);
				return;
			}
			ctx.ui.notify(`Unknown option "${trimmed}". Usage: /compact-transcript [on|off|status]`, "error");
		},
	});
}

export default function compactTranscript(pi: ExtensionAPI) {
	patchRenderers();
	registerCommand(pi);

	pi.registerEntryRenderer<SummaryData>(SUMMARY_ENTRY_TYPE, (entry, _options, theme) => {
		const line = summaryLine(normalizeSummary(entry.data));
		if (!line) return undefined;
		return new Text(theme.fg("muted", line), 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreConfigFromBranch(ctx);
		captureTheme(ctx);
		// Drop all per-tool state and component registries from the previous
		// session; stale burst counts otherwise corrupt the rebuilt transcript
		// after resume or /reload.
		resetToolRun();
		state.runStats = newRunStats();
		state.toolComponents = new Set();
		state.assistantComponents = new Set();
		ctx.ui.setWorkingMessage();
		// Clear any footer status left behind by pre-0.4 versions of this extension.
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopBlinkTimer();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWorkingMessage();
	});

	pi.on("agent_start", (_event, ctx) => {
		state.agentActive = true;
		captureTheme(ctx);
		resetToolRun();
		state.runStats = newRunStats();
	});

	pi.on("agent_end", (_event, _ctx) => {
		state.agentActive = false;
		state.currentBurst = [];
		clearCurrentThought();
		state.runningToolIds.clear();
		stopBlinkTimer();
		appendRunSummary(pi);
	});

	pi.on("turn_start", (_event, ctx) => {
		captureTheme(ctx);
	});

	pi.on("message_update", (event, ctx) => {
		captureTheme(ctx);
		const type = event.assistantMessageEvent?.type;
		if (typeof type === "string" && type.startsWith("thinking_")) {
			updateCurrentThoughtFromMessage(event.message);
		}
		if (textSignalHasVisibleContent(event.assistantMessageEvent)) {
			clearCurrentThought();
			// Visible assistant text ends the current tool burst. Do not split on
			// text_start alone: some providers create empty text blocks before a
			// tool-only turn, and those blocks are hidden from the transcript.
			state.currentBurst = [];
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		captureTheme(ctx);
		beginTool(event.toolCallId, event.toolName, event.args);
	});

	pi.on("tool_execution_update", (event, ctx) => {
		captureTheme(ctx);
		updateToolResult(event.toolCallId, event.partialResult, false, true);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		captureTheme(ctx);
		updateToolResult(event.toolCallId, event.result, event.isError, false);
	});
}
