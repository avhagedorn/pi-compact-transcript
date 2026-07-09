import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

type BuiltInName = "bash" | "read" | "write" | "edit" | "grep" | "find" | "ls";

type ToolKind = "noise" | "mutation";

type ToolInfo = {
	id: string;
	name: string;
	args: any;
	preview: string;
	kind: ToolKind;
	hidden?: boolean;
	burstCount?: number;
	result?: string;
	invalidate?: () => void;
};

const BUILT_INS: BuiltInName[] = ["bash", "read", "write", "edit", "grep", "find", "ls"];
const LABEL = "Thinking...";

let toolsById = new Map<string, ToolInfo>();
let currentNoiseBurst: ToolInfo[] = [];
let agentActive = false;
let lastThinkingSignalComponent: any | undefined;
let thinkingSignalCount = 0;

const toolCache = new Map<string, ReturnType<typeof createBuiltInTools>>();

function createBuiltInTools(cwd: string) {
	return {
		bash: createBashTool(cwd),
		read: createReadTool(cwd),
		write: createWriteTool(cwd),
		edit: createEditTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
	};
}

function getBuiltInTools(cwd: string) {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
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

function limitPlain(text: string, max = Math.max(20, (process.stdout.columns || 100) - 6)): string {
	const clean = oneLine(text);
	if (clean.length <= max) return clean;
	return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function quote(s: string): string {
	return JSON.stringify(s);
}

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
		default:
			return `${name} ${oneLine(JSON.stringify(args ?? {}))}`;
	}
}

function resultPreview(result: any): string {
	const text = Array.isArray(result?.content)
		? result.content.find((c: any) => c?.type === "text" && typeof c.text === "string")?.text
		: undefined;
	if (!text) return "";
	const lines = String(text).trim().split("\n").filter(Boolean);
	if (lines.length === 0) return "";
	if (lines.length === 1) return lines[0];
	return `${lines.length} lines`;
}

function isMutationTool(name: string): boolean {
	return name === "edit" || name === "write" || name.endsWith(".edit") || name.endsWith(".write");
}

function resetToolRun() {
	toolsById = new Map();
	currentNoiseBurst = [];
}

function resetThinkingSignals() {
	lastThinkingSignalComponent = undefined;
	thinkingSignalCount = 0;
}

function upsertToolInfo(id: string, name: string, args: any, invalidate?: () => void): ToolInfo {
	let info = toolsById.get(id);
	if (!info) {
		info = { id, name, args, preview: previewFor(name, args), kind: isMutationTool(name) ? "mutation" : "noise" };
		toolsById.set(id, info);
	}
	info.name = name;
	info.args = args;
	info.preview = previewFor(name, args);
	info.kind = isMutationTool(name) ? "mutation" : "noise";
	if (invalidate) info.invalidate = invalidate;
	return info;
}

function beginTool(id: string, name: string, args: any) {
	const previousNoise = currentNoiseBurst[currentNoiseBurst.length - 1];
	const info = upsertToolInfo(id, name, args);
	info.hidden = false;
	info.burstCount = 1;

	if (info.kind === "mutation") {
		currentNoiseBurst = [];
		return;
	}

	if (!currentNoiseBurst.some((tool) => tool.id === id)) currentNoiseBurst.push(info);
	for (const tool of currentNoiseBurst.slice(0, -1)) tool.hidden = true;
	info.burstCount = currentNoiseBurst.length;
	previousNoise?.invalidate?.();
}

function compactToolLine(toolCallId: string, name: string, args: any, theme: any, invalidate?: () => void, result?: any): string {
	let info = toolsById.get(toolCallId);

	// Hydration/resume path: compact the individual row, but do not mutate burst
	// state or invalidate older rows while pi is rebuilding chat history.
	if (!agentActive && !info) {
		const suffix = resultPreview(result);
		const preview = previewFor(name, args);
		const details = suffix ? `${preview} {${oneLine(suffix)}}` : preview;
		return theme.fg("muted", limitPlain(details));
	}

	info = upsertToolInfo(toolCallId, name, args, invalidate);
	const suffix = resultPreview(result);
	if (suffix) info.result = suffix;
	if (info.hidden) return "";

	const details = info.result ? `${info.preview} {${oneLine(info.result)}}` : info.preview;
	if (info.kind === "mutation" || (info.burstCount ?? 1) <= 1) return theme.fg("muted", limitPlain(details));
	const prefix = `Used ${info.burstCount} tools `;
	return theme.fg("toolTitle", prefix) + theme.fg("muted", limitPlain(details, Math.max(20, (process.stdout.columns || 100) - prefix.length - 6)));
}

async function patchInternalRenderers() {
	try {
		const require = createRequire(import.meta.url);
		const piMain = require.resolve("@earendil-works/pi-coding-agent");
		const distDir = dirname(piMain);
		const assistantModule = await import(
			pathToFileURL(join(distDir, "modes/interactive/components/assistant-message.js")).href
		);
		const toolExecutionModule = await import(
			pathToFileURL(join(distDir, "modes/interactive/components/tool-execution.js")).href
		);
		const themeModule = await import(pathToFileURL(join(distDir, "modes/interactive/theme/theme.js")).href);

		const ToolExecutionComponent = toolExecutionModule.ToolExecutionComponent;
		if (ToolExecutionComponent?.prototype && !ToolExecutionComponent.prototype.__compactTranscriptPatched) {
			const originalRender = ToolExecutionComponent.prototype.render;
			ToolExecutionComponent.prototype.updateDisplay = function () {
				this.__compactTranscriptForceSelf = true;
				this.hideComponent = false;
				this.selfRenderContainer.clear();
				this.imageComponents = [];
				this.imageSpacers = [];

				const line = compactToolLine(
					this.toolCallId,
					this.toolName,
					this.args,
					themeModule.theme,
					() => {
						this.invalidate();
						this.ui?.requestRender?.();
					},
					this.result,
				);

				if (!line) {
					this.hideComponent = true;
					return;
				}

				this.selfRenderContainer.addChild(new Text(line, 0, 0));
			};
			ToolExecutionComponent.prototype.render = function (width: number) {
				if (this.hideComponent) return [];
				if (this.__compactTranscriptForceSelf) return this.selfRenderContainer.render(width);
				return originalRender.call(this, width);
			};
			ToolExecutionComponent.prototype.__compactTranscriptPatched = true;
		}

		const Component = assistantModule.AssistantMessageComponent;
		if (!Component?.prototype || Component.prototype.__compactTranscriptPatched) return;
		const original = Component.prototype.updateContent;

		Component.prototype.updateContent = function (message: any) {
			if (!this.hideThinkingBlock) return original.call(this, message);

			this.lastMessage = message;
			this.contentContainer.clear();

			const hasText = message.content.some((c: any) => c.type === "text" && c.text?.trim());
			const hasThinking = message.content.some((c: any) => c.type === "thinking" && c.thinking?.trim());
			this.hasToolCalls = message.content.some((c: any) => c.type === "toolCall");

			// During live runs, coalesce consecutive assistant messages that only
			// contribute hidden thinking (with or without tool calls). Tool rows are
			// separate components, so hiding the older assistant component removes only
			// repeated "Thinking..." noise, not the tool preview itself.
			const thinkingSignal = agentActive && hasThinking && !hasText;
			if (this.__compactTranscriptHiddenThinkingSignal) return;
			if (thinkingSignal && lastThinkingSignalComponent !== this) {
				if (lastThinkingSignalComponent) {
					lastThinkingSignalComponent.__compactTranscriptHiddenThinkingSignal = true;
					lastThinkingSignalComponent.invalidate?.();
				}
				lastThinkingSignalComponent = this;
				thinkingSignalCount++;
			} else if (!thinkingSignal && hasText) {
				resetThinkingSignals();
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
				while (
					message.content[i + count]?.type === "thinking" &&
					message.content[i + count]?.thinking?.trim()
				) {
					count++;
				}
				i += count - 1;

				if (thinkingSignal) {
					if (renderedThinkingSignal) continue;
					count = Math.max(count, thinkingSignalCount);
					renderedThinkingSignal = true;
				}

				const label = count > 1 ? `${LABEL} (${count}x)` : LABEL;
				this.contentContainer.addChild(
					new Text(themeModule.theme.italic(themeModule.theme.fg("thinkingText", label)), this.outputPad, 0),
				);

				const hasVisibleAfter = message.content
					.slice(i + 1)
					.some((c: any) => (c.type === "text" && c.text?.trim()) || (c.type === "thinking" && c.thinking?.trim()));
				if (hasVisibleAfter) this.contentContainer.addChild(new Spacer(1));
			}
		};
		Component.prototype.__compactTranscriptPatched = true;
	} catch {
		// Best-effort: older/bundled pi builds may not expose internal component modules.
	}
}

export default async function (pi: ExtensionAPI) {
	await patchInternalRenderers();
	let consecutiveThinking = 0;

	function thinkingLabel() {
		return consecutiveThinking > 1 ? `${LABEL} (${consecutiveThinking}x)` : LABEL;
	}

	function resetTools() {
		resetToolRun();
	}

	function applyThinkingLabel(ctx: ExtensionContext) {
		ctx.ui.setHiddenThinkingLabel(thinkingLabel());
	}

	pi.on("session_start", async (_event, ctx) => {
		applyThinkingLabel(ctx);
		ctx.ui.setWorkingMessage();
	});

	pi.on("agent_start", () => {
		agentActive = true;
		resetTools();
		resetThinkingSignals();
	});

	pi.on("agent_end", () => {
		agentActive = false;
		currentNoiseBurst = [];
		resetThinkingSignals();
	});

	pi.on("turn_start", (_event, ctx) => {
		consecutiveThinking = 0;
		applyThinkingLabel(ctx);
	});

	pi.on("message_update", (event: any, ctx) => {
		const type = event.assistantMessageEvent?.type;
		if (type === "thinking_start") {
			consecutiveThinking++;
			applyThinkingLabel(ctx);
			return;
		}
		if (type && !type.startsWith("thinking_")) {
			consecutiveThinking = 0;
			applyThinkingLabel(ctx);
			if (type === "text_delta" || type === "text_start") {
				resetTools();
				resetThinkingSignals();
			}
		}
	});

	pi.on("tool_execution_start", (event: any) => {
		beginTool(event.toolCallId, event.toolName, event.args);
	});

	pi.on("tool_execution_end", (event: any) => {
		const info = toolsById.get(event.toolCallId);
		if (!info) return;
		const suffix = resultPreview(event.result);
		if (suffix) info.result = suffix;
		info.invalidate?.();
	});

	for (const name of BUILT_INS) {
		const base = getBuiltInTools(process.cwd())[name] as any;
		pi.registerTool({
			...base,
			name,
			label: name,
			renderShell: "self",
			async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
				const tool = (getBuiltInTools(ctx.cwd) as any)[name];
				return tool.execute(toolCallId, params, signal, onUpdate, ctx);
			},
			renderCall(args: any, theme: any, context: any) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				text.setText(compactToolLine(context.toolCallId, name, args, theme, context.invalidate));
				return text;
			},
			renderResult(_result: any, _options: any, _theme: any, _context: any) {
				return new Text("", 0, 0);
			},
		});
	}
}
