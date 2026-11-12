import assert from "node:assert/strict";
import test from "node:test";
import { harness, lines, row } from "./helpers.ts";

const image = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWHQAAAAASUVORK5CYII=",
};

for (const restored of [false, true]) {
	test(`image results stay native and separate from bursts (${restored ? "history" : "live"})`, async () => {
		const h = harness();
		await h.startSession();
		await h.emit("agent_start");
		try {
			const add = async (id: string, content = [{ type: "text", text: "ok" }]) => {
				if (restored) return h.restore(id, "read", { path: id }, { content });
				const component = await h.start(id, "read", { path: id });
				await h.finish(id, { content });
				return component;
			};
			const first = await add("first");
			const second = await add("second");
			const picture = await add("picture", [image, image] as any);
			const next = await add("next");
			assert.deepEqual(lines(first), []);
			assert.match(row(second), /2× read/);
			assert.equal(Reflect.get(picture, "__compactTranscriptForceSelf"), false);
			assert.equal(Reflect.get(picture, "__compactTranscriptHidden"), false);
			assert.ok(lines(picture).length > 0);
			assert.match(row(next), /read next/);
			assert.doesNotMatch(row(next), /×/);
			for (const mode of ["off", "on"]) {
				await h.command(mode);
				assert.equal(Reflect.get(picture, "__compactTranscriptForceSelf"), false);
				assert.ok(lines(picture).length > 0);
			}
			picture.setExpanded(true);
			picture.setExpanded(false);
			assert.equal(Reflect.get(picture, "__compactTranscriptForceSelf"), false);
		} finally {
			await h.emit("session_shutdown");
		}
	});
}

test("partial images use the native renderer and text-only replacements become compact", async () => {
	const h = harness();
	await h.startSession();
	try {
		const component = await h.start("partial", "read", { path: "preview.png" });
		component.updateResult({ content: [image], isError: false } as any, true);
		assert.equal(Reflect.get(component, "__compactTranscriptForceSelf"), false);
		await h.finish("partial");
		assert.equal(Reflect.get(component, "__compactTranscriptForceSelf"), true);
		assert.deepEqual(Reflect.get(component, "imageComponents"), []);
		assert.equal(lines(component).length, 1);
	} finally {
		await h.emit("session_shutdown");
	}
});
