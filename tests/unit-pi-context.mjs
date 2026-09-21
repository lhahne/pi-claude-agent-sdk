#!/usr/bin/env node

/**
 * Pi provider-context normalization.
 *
 * Pi 0.86 changed a custom provider's input from `Context` to a normalized
 * `TranscriptContext`, moving the system prompt and tool declarations into a
 * leading `system` message. The bridge handled neither, and the failure was
 * silent at the point of damage: the leading system message was counted as
 * conversation history, converted to zero Anthropic records, and the resulting
 * empty session was then resumed — surfacing as "No conversation found with
 * session ID", several steps from the cause.
 *
 * These tests pin the shape against pi's own `normalizeContext`, so they fail if
 * pi changes what it hands providers rather than only if this module changes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeContext } from "@earendil-works/pi-ai";

import { normalizePiContext } from "../src/pi-context.js";

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const system = (text, extra = {}) => ({ role: "system", content: text, timestamp: 0, ...extra });
const tool = (name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } });

describe("normalizePiContext", () => {
	it("extracts the prompt and tools from the leading system message", () => {
		const context = normalizePiContext({
			messages: [
				system("You are pi.", { toolsAdded: [tool("read"), tool("bash")] }),
				user("hello"),
			],
		});
		assert.equal(context.transcript, true);
		assert.equal(context.systemPrompt, "You are pi.");
		assert.deepEqual(context.tools.map((t) => t.name), ["read", "bash"]);
		// The load-bearing assertion: the system message is not history.
		assert.deepEqual(context.messages.map((m) => m.role), ["user"]);
	});

	it("replays mid-conversation prompt and tool changes", () => {
		const context = normalizePiContext({
			messages: [
				system("Base prompt.", { toolsAdded: [tool("read"), tool("bash")] }),
				user("hello"),
				// What pi appends when before_agent_start changes the prompt or tools.
				system("", { sections: { style: "Be terse." }, toolsRemoved: [{ name: "bash" }] }),
				user("again"),
				system("", { toolsAdded: [tool("grep")] }),
			],
		});
		assert.equal(context.systemPrompt, "Base prompt.\n\nBe terse.");
		assert.deepEqual(context.tools.map((t) => t.name), ["read", "grep"]);
		assert.deepEqual(context.messages.map((m) => m.role), ["user", "user"]);
	});

	it("round-trips what pi's own normalizeContext produces", () => {
		const tools = [tool("read"), tool("bash")];
		// The real producer, not a hand-built fixture — this is the contract that
		// broke, so it is pinned against pi's own function.
		const context = normalizePiContext(normalizeContext({
			systemPrompt: "You are pi.",
			tools,
			messages: [user("hello"), user("world")],
		}));
		assert.equal(context.transcript, true);
		assert.equal(context.systemPrompt, "You are pi.");
		assert.deepEqual(context.tools.map((t) => t.name), ["read", "bash"]);
		assert.deepEqual(context.messages.map((m) => m.role), ["user", "user"]);
	});

	it("leaves a bare completion alone", () => {
		// createInitialSystemMessage returns undefined when both prompt and tools are
		// empty, so a prompt-less, tool-less call has no leading system message.
		const context = normalizePiContext(normalizeContext({ messages: [user("hi")] }));
		assert.equal(context.transcript, false);
		assert.equal(context.systemPrompt, undefined);
		assert.deepEqual(context.tools, []);
		assert.deepEqual(context.messages.map((m) => m.role), ["user"]);
	});

	it("refuses a raw Context that bypassed normalizeContext", () => {
		// Reading systemPrompt/tools here would appear to work, and would silently
		// drop any mid-conversation prompt change pi recorded in the transcript.
		assert.throws(
			() => normalizePiContext({ systemPrompt: "You are pi.", messages: [user("hi")] }),
			/raw Context, not the TranscriptContext/,
		);
		assert.throws(
			() => normalizePiContext({ tools: [tool("read")], messages: [user("hi")] }),
			/raw Context, not the TranscriptContext/,
		);
		// An empty prompt or tool list is not evidence of a raw Context.
		assert.doesNotThrow(() => normalizePiContext({ systemPrompt: "", tools: [], messages: [user("hi")] }));
	});

	it("survives a missing or non-array messages field", () => {
		assert.deepEqual(normalizePiContext({}).messages, []);
		assert.deepEqual(normalizePiContext({ messages: null }).messages, []);
	});
});
