#!/usr/bin/env node

/**
 * Pi summarization and extension-owned nested completions set
 * cacheRetention="none". The bridge must route those requests to a standalone
 * Claude Code subprocess before prompt capture or shared-session handling.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { default: activate, __test } = await import("../src/index.js");

function activateWithMockPi() {
	const handlers = new Map();
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {} });
	return handlers;
}

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const system = (text, extra = {}) => ({ role: "system", content: text, timestamp: 0, ...extra });

/** Providers receive a normalized context, so tests enter through the same door. */
const norm = (context) => __test.normalizePiContext(context);

describe("standalone provider routing", () => {
	it("recognizes the one-message, tool-free, explicit no-cache shape", () => {
		const standalone = norm({ messages: [user("summarize")] });
		assert.equal(__test.isStandaloneRequest(standalone, { cacheRetention: "none" }), true);
		assert.equal(__test.isStandaloneRequest(standalone, { cacheRetention: "short" }), false);
		assert.equal(__test.isStandaloneRequest(standalone, {}), false);
		assert.equal(__test.isStandaloneRequest(standalone), false);
		// pi 0.86's normalizeContext only records `toolsAdded` for a *non-empty* list,
		// so an explicitly empty tool list reads the same as an absent one. Nothing is
		// lost: cacheRetention "none" has exactly one setter in pi —
		// completeSummarization, which never passes tools — so the tool check is
		// belt-and-braces rather than the load-bearing signal.
		assert.equal(
			__test.isStandaloneRequest(norm({ messages: [user("summarize")], tools: [] }), { cacheRetention: "none" }),
			true,
		);
		assert.equal(
			__test.isStandaloneRequest(norm({ messages: [user("a"), user("b")] }), { cacheRetention: "none" }),
			false,
		);
	});

	it("recognizes the transcript shape pi 0.86 sends", () => {
		// The leading system message is the whole difference from the old Context API.
		// Before the fix it was counted as conversation history, converted to zero
		// records, and the empty session was then resumed.
		const normalized = norm({
			messages: [system("You summarize conversations."), user("summarize")],
		});
		assert.equal(normalized.transcript, true);
		assert.equal(normalized.systemPrompt, "You summarize conversations.");
		assert.deepEqual(normalized.tools, []);
		assert.equal(normalized.messages.length, 1, "the system message must not remain in history");
		assert.equal(normalized.messages[0].role, "user");
		assert.equal(__test.isStandaloneRequest(normalized, { cacheRetention: "none" }), true);
		assert.equal(__test.extractStandalonePrompt(normalized), "summarize");
	});

	it("accepts the one-user-message shape used by summaries and planners", () => {
		assert.equal(
			__test.extractStandalonePrompt(norm({ messages: [system("planner"), user("PLAN REQUEST")] })),
			"PLAN REQUEST",
		);
	});

	it("rejects stateful conversations and tool-bearing standalone calls", () => {
		assert.throws(
			() => __test.extractStandalonePrompt(norm({ messages: [user("a"), user("b")] })),
			/expected exactly 1 user message/,
		);
		assert.throws(
			// Tools arrive in the transcript's system message, so this is the shape a
			// tool-bearing standalone call would actually have.
			() => __test.extractStandalonePrompt(norm({ messages: [system("", { toolsAdded: [{ name: "plan" }] }), user("a")] })),
			/do not support tools/,
		);
	});

	it("does not compete with other compaction or tree extensions", () => {
		const handlers = activateWithMockPi();
		assert.equal(handlers.has("session_before_compact"), false);
		assert.equal(handlers.has("session_before_tree"), false);
	});
});
