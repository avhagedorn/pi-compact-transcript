import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
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
