import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { harness, lines, row } from "./helpers.ts";

const toolCall = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } };

function message(...content: object[]) {
	return { role: "assistant", content } as any;
}

function render(component: AssistantMessageComponent): string[] {
	return lines(component, 80).map((line) => line.trimEnd());
}

test("hidden thinking is removed entirely, including pi's placeholder", async () => {
	const h = harness();
	await h.startSession();
	const component = new AssistantMessageComponent(
		message({ type: "thinking", thinking: "Secret plan" }, { type: "text", text: "Here is the answer." }),
		true,
	);
	const output = render(component).join("\n");
	assert.match(output, /Here is the answer\./);
	assert.doesNotMatch(output, /Secret plan/);
	assert.doesNotMatch(output, /Thinking/);

	const thinkingOnly = new AssistantMessageComponent(message({ type: "thinking", thinking: "Secret plan" }), true);
	assert.deepEqual(render(thinkingOnly), [], "a message with only thinking renders nothing");
});

test("streamed updates with hidden thinking reuse the text Markdown", async () => {
	const h = harness();
	await h.startSession();
	const component = new AssistantMessageComponent(undefined, true) as any;
	const textMarkdown = () => component.contentContainer.children.filter((child: any) => child.constructor.name === "Markdown");
	component.updateContent(message({ type: "thinking", thinking: "Plan" }, { type: "text", text: "First" }), true);
	const [first] = textMarkdown();
	component.updateContent(message({ type: "thinking", thinking: "Plan" }, { type: "text", text: "First and more" }), true);
	assert.deepEqual(textMarkdown(), [first], "the same Markdown renders the grown text");
	assert.match(render(component).join("\n"), /First and more/);
});

test("commentary before tool calls gets the rail; final answers do not", async () => {
	const h = harness();
	await h.startSession();
	const commentary = render(new AssistantMessageComponent(
		message({ type: "text", text: "Checking the files first." }, toolCall),
		true,
	));
	const textLines = commentary.filter((line) => line.trim());
	assert.ok(textLines.length > 0);
	assert.ok(textLines.every((line) => line.startsWith("│ ")), "every commentary line is railed");
	assert.equal(commentary.at(-1), "", "a blank line separates commentary from the tools below");

	const answer = render(new AssistantMessageComponent(message({ type: "text", text: "All done." }), true));
	assert.ok(answer.some((line) => line.includes("All done.")));
	assert.ok(answer.every((line) => !line.startsWith("│")), "final answers stay unframed");
});

test("commentary is railed when thinking is shown too", async () => {
	const h = harness();
	await h.startSession();
	const output = render(new AssistantMessageComponent(
		message({ type: "thinking", thinking: "Plan" }, { type: "text", text: "Checking the files first." }, toolCall),
		false,
	));
	assert.ok(output.some((line) => line.startsWith("│ ") && line.includes("Checking the files first.")));
});

test("with the extension off, assistant messages render natively", async () => {
	const h = harness();
	await h.startSession();
	try {
		await h.command("off");
		const output = render(new AssistantMessageComponent(
			message({ type: "text", text: "Checking the files first." }, toolCall),
			true,
		));
		assert.ok(output.some((line) => line.includes("Checking the files first.")));
		assert.ok(output.every((line) => !line.startsWith("│")), "no rail while off");
	} finally {
		await h.command("on");
	}
});

test("pi's Markdown transformers still run on assistant text", async () => {
	const h = harness();
	await h.startSession();
	const seen: Array<{ messageType: string; isStreaming: boolean }> = [];
	const transformer = (markdown: string, context: { messageType: string; isStreaming: boolean }) => {
		seen.push({ messageType: context.messageType, isStreaming: context.isStreaming });
		return markdown.replace("MERMAID_SOURCE", "rendered diagram");
	};
	const component = new AssistantMessageComponent(
		message({ type: "text", text: "Here: MERMAID_SOURCE" }),
		true,
		undefined,
		undefined,
		undefined,
		[transformer as any],
	);
	const output = render(component).join("\n");
	assert.match(output, /rendered diagram/);
	assert.doesNotMatch(output, /MERMAID_SOURCE/);
	assert.deepEqual(seen.at(-1), { messageType: "assistant", isStreaming: false });
});

test("a failing Markdown transformer is skipped", async () => {
	const h = harness();
	await h.startSession();
	const broken = () => {
		throw new Error("boom");
	};
	const upper = (markdown: string) => markdown.toUpperCase();
	const component = new AssistantMessageComponent(
		message({ type: "text", text: "still here" }),
		true,
		undefined,
		undefined,
		undefined,
		[broken as any, upper as any],
	);
	assert.match(render(component).join("\n"), /STILL HERE/);
});

test("assistant text in history splits bursts when thinking is shown", async () => {
	const h = harness();
	await h.startSession("resume");
	try {
		const a = h.restore("a", "read", { path: "a.ts" });
		new AssistantMessageComponent(message({ type: "text", text: "Now the next file." }), false);
		const b = h.restore("b", "read", { path: "b.ts" });
		assert.equal(row(a), "◆ read a.ts {ok}");
		assert.equal(row(b), "◆ read b.ts {ok}");
	} finally {
		await h.emit("session_shutdown");
	}
});
