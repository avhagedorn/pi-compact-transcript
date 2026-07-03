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

type ToolInfo = {
	id: string;
	name: string;
	args: any;
	preview: string;
	result?: string;
	invalidate?: () => void;
};

const BUILT_INS: BuiltInName[] = ["bash", "read", "write", "edit", "grep", "find", "ls"];
const LABEL = "Thinking...";

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

function toolCallName(block: any): string {
	return block?.name ?? block?.toolName ?? block?.tool_name ?? block?.tool?.name ?? "tool";
}

function toolCallArgs(block: any): any {
	return block?.args ?? block?.input ?? block?.arguments ?? block?.tool?.args ?? {};
}

function nextStepSummary(content: any[], fromIndex: number): string {
	const tools = content.slice(fromIndex + 1).filter((c: any) => c?.type === "toolCall");
	if (tools.length === 0) return " Next, I’ll continue from this reasoning and respond with the result. I’ll keep the visible output brief.";

	const first = tools[0];
	const preview = limitPlain(previewFor(toolCallName(first), toolCallArgs(first)), 90);
	if (tools.length === 1) {
		return ` Next, I’ll use ${preview}. I’ll inspect the result and decide the next visible step from there.`;
	}
	const last = tools[tools.length - 1];
	const lastPreview = limitPlain(previewFor(toolCallName(last), toolCallArgs(last)), 70);
	return ` Next, I’ll run ${tools.length} tool calls, starting with ${preview}. I’ll use the latest result to continue, ending this batch around ${lastPreview}.`;
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
			ToolExecutionComponent.prototype.render = function (width: number) {
				if (this.hideComponent) return [];
				if (this.hasRendererDefinition?.() && this.getRenderShell?.() === "self") {
					const contentLines = this.selfRenderContainer.render(width);
					if (contentLines.length === 0 && this.imageComponents.length === 0) return [];
					const lines = [...contentLines];
					for (let i = 0; i < this.imageComponents.length; i++) {
						const spacer = this.imageSpacers[i];
						if (spacer) lines.push(...spacer.render(width));
						const imageComponent = this.imageComponents[i];
						if (imageComponent) lines.push(...imageComponent.render(width));
					}
					return lines;
				}
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

			const visible = message.content.filter(
				(c: any) => (c.type === "text" && c.text?.trim()) || (c.type === "thinking" && c.thinking?.trim()),
			);
			if (visible.length) this.contentContainer.addChild(new Spacer(1));

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

				const label = count > 1 ? `${LABEL} (${count}x)` : LABEL;
				const summary = nextStepSummary(message.content, i);
				this.contentContainer.addChild(
					new Text(themeModule.theme.italic(themeModule.theme.fg("thinkingText", limitPlain(`${label}${summary}`))), this.outputPad, 0),
				);

				const hasVisibleAfter = message.content
					.slice(i + 1)
					.some((c: any) => (c.type === "text" && c.text?.trim()) || (c.type === "thinking" && c.thinking?.trim()));
				if (hasVisibleAfter) this.contentContainer.addChild(new Spacer(1));
			}

			this.hasToolCalls = message.content.some((c: any) => c.type === "toolCall");
		};
		Component.prototype.__compactTranscriptPatched = true;
	} catch {
		// Best-effort: older/bundled pi builds may not expose internal component modules.
	}
}

export default async function (pi: ExtensionAPI) {
	await patchInternalRenderers();
	let current: ToolInfo[] = [];
	let byId = new Map<string, ToolInfo>();
	let consecutiveThinking = 0;

	function thinkingLabel() {
		return consecutiveThinking > 1 ? `${LABEL} (${consecutiveThinking}x)` : LABEL;
	}

	function resetTools() {
		current = [];
		byId = new Map();
	}

	function applyThinkingLabel(ctx: ExtensionContext) {
		ctx.ui.setHiddenThinkingLabel(thinkingLabel());
	}

	pi.on("session_start", async (_event, ctx) => {
		applyThinkingLabel(ctx);
		ctx.ui.setWorkingMessage(LABEL);
	});

	pi.on("agent_start", () => {
		resetTools();
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
			if (type === "text_delta" || type === "text_start") resetTools();
		}
	});

	pi.on("tool_execution_start", (event: any) => {
		const previous = current[current.length - 1];
		const info: ToolInfo = {
			id: event.toolCallId,
			name: event.toolName,
			args: event.args,
			preview: previewFor(event.toolName, event.args),
		};
		current.push(info);
		byId.set(info.id, info);
		previous?.invalidate?.();
	});

	pi.on("tool_execution_end", (event: any) => {
		const info = byId.get(event.toolCallId);
		if (!info) return;
		const suffix = resultPreview(event.result);
		if (suffix) info.result = suffix;
		info.invalidate?.();
	});

	function compactLine(toolCallId: string, name: string, args: any, theme: any, context: any): string {
		let info = byId.get(toolCallId);
		if (!info) {
			info = { id: toolCallId, name, args, preview: previewFor(name, args) };
			byId.set(toolCallId, info);
			if (!current.some((t) => t.id === toolCallId)) current.push(info);
		}
		info.invalidate = context.invalidate;
		info.args = args;
		info.preview = previewFor(name, args);

		if (current[current.length - 1]?.id !== toolCallId) return "";

		const details = info.result ? `${info.preview} {${oneLine(info.result)}}` : info.preview;
		if (current.length === 1) return theme.fg("muted", limitPlain(details));
		const prefix = `Used ${current.length} tools `;
		return theme.fg("toolTitle", prefix) + theme.fg("muted", limitPlain(details, Math.max(20, (process.stdout.columns || 100) - prefix.length - 6)));
	}

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
				text.setText(compactLine(context.toolCallId, name, args, theme, context));
				return text;
			},
			renderResult(_result: any, _options: any, _theme: any, _context: any) {
				return new Text("", 0, 0);
			},
		});
	}
}
