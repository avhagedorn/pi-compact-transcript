import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import compactTranscript from "../extensions/compact-transcript.ts";

test("compact tool and thought rows use render width and recover on resize", async () => {
	const handlers = new Map<string, Function>();
	const theme = {
		fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	} as Theme;
	const ctx = { ui: { theme, setStatus() {}, setWorkingMessage() {} } } as unknown as ExtensionContext;
	compactTranscript({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand() {},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI);
	const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
	emit("agent_start");
	try {
		const command = `echo ${"界🙂é ".repeat(35)}END_OF_COMMAND`;
		const args = { command };
		emit("tool_execution_start", { toolCallId: "width-test", toolName: "bash", args });
		const component = new ToolExecutionComponent("bash", "width-test", args, {}, undefined,
			{ requestRender() {} } as unknown as TUI, process.cwd());
		const expected = `◆ $ ${command} {running}`;
		const checkTool = (width: number) => {
			const lines = component.render(width);
			assert.equal(lines.length, 1);
			assert.equal(stripTerminalSequences(lines[0]), stripTerminalSequences(truncateToWidth(expected, width, "…")));
			assert.ok(visibleWidth(lines[0]) <= width);
			assert.ok(lines[0].includes("\x1b["), "theme styling is preserved");
		};
		checkTool(220); // Beyond the old 104-cell preview cap.
		checkTool(24);
		checkTool(600); // No invalidate/update between widths: recover the full line.

		const heading = `Considering ${"界🙂é ".repeat(35)}END_OF_THOUGHT`;
		emit("message_update", {
			assistantMessageEvent: { type: "thinking_delta" },
			message: { content: [{ type: "thinking", thinking: heading }] },
		});
		for (const width of [220, 24, 600]) {
			const lines = component.render(width);
			assert.equal(lines.length, 2, "thought ticker stays a single row");
			assert.equal(stripTerminalSequences(lines[1]), stripTerminalSequences(truncateToWidth(`  ↳ ${heading}`, width, "…")));
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	} finally {
		await emit("session_shutdown");
	}
});

test("compact tool and thought rows reuse their truncated line until the width changes", async () => {
	const handlers = new Map<string, Function>();
	const theme = {
		fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	} as Theme;
	const ctx = { ui: { theme, setStatus() {}, setWorkingMessage() {} } } as unknown as ExtensionContext;
	compactTranscript({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand() {},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI);
	const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
	emit("agent_start");
	try {
		const args = { command: `echo ${"界🙂é ".repeat(35)}END_OF_COMMAND` };
		emit("tool_execution_start", { toolCallId: "cache-test", toolName: "bash", args });
		const component = new ToolExecutionComponent("bash", "cache-test", args, {}, undefined,
			{ requestRender() {} } as unknown as TUI, process.cwd());
		emit("message_update", {
			assistantMessageEvent: { type: "thinking_delta" },
			message: { content: [{ type: "thinking", thinking: "Considering the cache" }] },
		});
		const rows = (Reflect.get(component, "selfRenderContainer") as { children: { render(width: number): string[] }[] })
			.children;
		assert.equal(rows.length, 2, "tool row and thought row");
		for (const row of rows) {
			const first = row.render(80);
			assert.equal(row.render(80), first, "same width reuses the truncated line");
			const narrow = row.render(24);
			assert.notEqual(narrow, first, "a new width truncates again");
			assert.ok(visibleWidth(narrow[0]) <= 24);
		}
	} finally {
		await emit("session_shutdown");
	}
});

test("commentary rail reuses its railed lines until the width changes", async () => {
	initTheme("dark", false);
	const handlers = new Map<string, Function>();
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const ctx = { ui: { theme, setStatus() {}, setWorkingMessage() {} } } as unknown as ExtensionContext;
	compactTranscript({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand() {},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI);
	const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
	emit("agent_start");
	try {
		const component = new AssistantMessageComponent({
			role: "assistant",
			content: [
				{ type: "text", text: "Checking the files before running the tests." },
				{ type: "toolCall", id: "rail-test", name: "bash", arguments: { command: "ls" } },
			],
		} as unknown as ConstructorParameters<typeof AssistantMessageComponent>[0]);
		const children = (Reflect.get(component, "contentContainer") as { children: object[] }).children;
		const rail = children.find((child) => child.constructor.name === "CommentaryRail") as
			| { render(width: number): string[] }
			| undefined;
		assert.ok(rail, "commentary is framed by the rail");
		const first = rail.render(80);
		assert.ok(first.some((line) => stripTerminalSequences(line).startsWith("│  Checking the files")));
		assert.equal(rail.render(80), first, "same width reuses the railed lines");
		const narrow = rail.render(30);
		assert.notEqual(narrow, first, "a new width rebuilds the railed lines");
		assert.ok(narrow.every((line) => visibleWidth(line) <= 30));
	} finally {
		await emit("session_shutdown");
	}
});

test("collapsing tool output clears image sources together with image components", async () => {
	initTheme("dark", false);
	const handlers = new Map<string, Function>();
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
	const ctx = { ui: { theme, setStatus() {}, setWorkingMessage() {} } } as unknown as ExtensionContext;
	compactTranscript({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand() {},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI);
	const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
	emit("agent_start");
	try {
		const component = new ToolExecutionComponent("read", "image-test", { path: "image.png" }, {}, undefined,
			{ requestRender() {} } as unknown as TUI, process.cwd());
		component.setExpanded(true);
		// Seed the private image cache as if expanded output had rendered an image.
		// A stale source lets pi reuse an undefined component on the next expansion.
		Reflect.set(component, "imageComponents", [{ render: () => ["image"], invalidate() {} }]);
		Reflect.set(component, "imageSources", [{ data: "image", mimeType: "image/png", widthCells: 80 }]);
		component.setExpanded(false);
		assert.deepEqual(Reflect.get(component, "imageComponents"), []);
		assert.deepEqual(Reflect.get(component, "imageSources"), []);
		assert.doesNotThrow(() => {
			component.setExpanded(true);
			component.render(80);
		});
	} finally {
		await emit("session_shutdown");
	}
});
