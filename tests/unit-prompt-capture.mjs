#!/usr/bin/env node

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectPromptSkills, getSharedPromptCaptures, projectPromptCapture, PROMPT_CAPTURES_KEY, PromptCaptures } from "../src/prompt-capture.js";

const PI_HARNESS = "You are an expert coding assistant operating inside pi. Pi documentation: pi packages (docs/packages.md).";
const PARENT_KEY = `${PI_HARNESS}\n\n<project_context>raw parent context</project_context>\nCurrent working directory: /parent`;
const CHILD_SUFFIX = `\n\n<sub_agent_context>child rules</sub_agent_context>\n\n<active_agent name="Plan"/>\n\n# Environment\nWorking directory: /child\n\n<agent_instructions>plan carefully</agent_instructions>`;
const CHILD_KEY = `${PARENT_KEY}${CHILD_SUFFIX}\nCurrent working directory: /child`;

function skill(name, { disabled = false } = {}) {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: { source: "test", scope: "temporary", origin: "top-level" },
		disableModelInvocation: disabled,
	};
}

function capture(overrides = {}) {
	return { contextFiles: [], skills: [], ...overrides };
}

function project(captures, key, skillReadTool = "mcp") {
	const found = captures.resolve(key);
	assert.ok(found, `missing capture for ${key.slice(0, 30)}`);
	return projectPromptCapture(found, { skillReadTool });
}

function occurrences(text, needle) {
	return text.split(needle).length - 1;
}

describe("PromptCaptures", () => {
	it("keeps parent and child captures isolated", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));

		assert.equal(captures.resolve(PARENT_KEY).contextFiles.length, 1);
		assert.equal(captures.resolve(CHILD_KEY).contextFiles.length, 0);
		assert.equal(captures.resolve("unknown"), undefined);
		assert.equal(captures.resolve(undefined), undefined);
	});

	it("derives a transient capture when a later extension wrapped the prompt", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({
			contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }],
			skills: [skill("browser")],
		}));

		// What an extension loading after the bridge produces: our recorded prompt,
		// wrapped in text we never saw.
		const wrapped = `PREFIX FROM ANOTHER EXTENSION\n\n${PARENT_KEY}\n\nSUFFIX`;
		const derived = captures.resolveOrDerive(wrapped);
		const projected = projectPromptCapture(derived, { skillReadTool: "mcp" });

		assert.match(projected, /parent rules/, "the wrapped prompt's own instructions must survive");
		assert.match(projected, /browser/, "and so must its skills");
		// The wrapper's own text is instruction too. Substituting the embedded prompt
		// while discarding what surrounds it would be the silent loss the throw exists
		// to prevent — accept the prompt whole or refuse it, never accept and discard.
		assert.match(projected, /PREFIX FROM ANOTHER EXTENSION/, "the wrapper's prefix must survive");
		assert.match(projected, /SUFFIX/, "and so must its suffix");
		assert.doesNotMatch(projected, /Pi documentation/, "but never Pi's harness, which the projection replaces");
		assert.equal(captures.resolve(wrapped), undefined, "a derived capture is not retained");
	});

	it("revives an exact capture whose lookup key was evicted", () => {
		const captures = new PromptCaptures(2);
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }));
		// A child keeps the parent node alive by reference even once its key is gone.
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
		// Evicts PARENT_KEY's lookup key while the child keeps the node itself alive.
		captures.record("unrelated", capture());
		assert.equal(captures.resolve(PARENT_KEY), undefined, "precondition: the key is gone");

		// findInheritedPrompts skips a node whose key IS the prompt, so an evicted
		// exact match would otherwise embed nothing and throw.
		const revived = captures.resolveOrDerive(PARENT_KEY);
		assert.equal(revived.contextFiles[0].content, "parent rules");
		// Revival re-adds a key that was not in the map, so it has to trim like a write.
		assert.equal(captures.size, 2, "reviving must not grow the map past its bound");
	});

	it("keeps a parent alive that is only ever resolved, never re-recorded", () => {
		// The real shape: one long-lived parent agent, then a stream of sub-agents
		// each recording a prompt of its own. Counting only writes ages the parent out.
		const captures = new PromptCaptures(4);
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }));

		for (let i = 0; i < 8; i++) {
			assert.ok(captures.resolve(PARENT_KEY), `parent evicted after ${i} sub-agents`);
			captures.record(`sub-agent prompt ${i}`, capture());
		}

		assert.ok(captures.resolve(PARENT_KEY), "the parent must survive its own sub-agents");
		assert.equal(captures.resolve(PARENT_KEY).contextFiles.length, 1);
	});

	it("throws rather than silently dropping instructions it cannot account for", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }));

		assert.throws(
			() => captures.resolveOrDerive("a prompt sharing nothing with what we recorded"),
			(err) => /no capture for this .* system prompt/.test(err.message)
				&& !/another package root/.test(err.message),
		);
		// No prompt at all is not a loss — there is nothing to forward.
		assert.equal(captures.resolveOrDerive(undefined), undefined);
	});

	it("names a duplicate package root when nothing was ever recorded", () => {
		const captures = new PromptCaptures();
		assert.throws(
			() => captures.resolveOrDerive("unrecorded"),
			/second copy of this extension loaded from another package root/,
		);
	});

	it("reports the closest known capture when a prompt matches nothing", () => {
		const diagnostics = [];
		const captures = new PromptCaptures(64, (d) => diagnostics.push(d));
		captures.record("prefix-common-THE-REST", capture());

		let error;
		try {
			captures.resolveOrDerive("prefix-common-WHO-ARE-YOU");
		} catch (e) {
			error = e;
		}

		assert.match(String(error?.message), /diverges at offset 14 \(22-char key\)/);
		assert.equal(diagnostics.length, 1);
		assert.equal(diagnostics[0].matches[0].key, "prefix-common-THE-REST");
		assert.equal(diagnostics[0].matches[0].firstDivergent, 14);
	});

	it("recovers a turn whose prompt pi re-rendered with a different tool list", () => {
		// pi renders `before_agent_start`'s systemPrompt from the tool loadout as it
		// stands mid-dispatch, then corrects selectedTools to the live loadout before
		// writing the transcript's sections. An extension calling setActiveTools()
		// from its own handler — rpiv-ask-user-question strips its tool whenever
		// ctx.hasUI is false — leaves the two renders differing by that tool's snippet
		// and guidelines, and nothing else. The provider's prompt then matches no
		// capture exactly, which used to fail every print, RPC and sub-agent turn.
		const recorded = [
			"You are an expert coding assistant operating inside pi.",
			"- read: Read file contents from the filesystem",
			"- ask_user_question: Ask the user up to 4 structured questions",
			"- agent_browser: Browse websites, read live docs, click and fill pages",
			"Use ask_user_question whenever the user's request is underspecified.",
			"Current working directory: /work",
		].join("\n");
		// What the transcript holds: the same prompt minus that tool and its guideline.
		const replayed = recorded
			.split("\n")
			.filter((line) => !line.includes("ask_user_question"))
			.join("\n");

		const fallbacks = [];
		const captures = new PromptCaptures(64, undefined, (f) => fallbacks.push(f));
		captures.record(recorded, capture({ contextFiles: [{ path: "/AGENTS.md", content: "rules" }] }));

		const found = captures.resolveOrDerive(replayed);
		assert.ok(found, "the turn should be served, not failed");
		assert.equal(found.assembledPrompt, recorded, "the capture recorded this turn is the one used");
		assert.equal(fallbacks.length, 1, "and the recovery is reported so it can be logged");
		assert.equal(fallbacks[0].candidates, 1);
	});

	it("still refuses a turn whose prompt shares no structure with any capture", () => {
		// The fallback must not become "any capture will do". A capture recorded this
		// turn whose prompt is unrelated to what the provider is sending is exactly the
		// silent instruction corruption this file exists to prevent.
		const captures = new PromptCaptures();
		captures.record(
			[PI_HARNESS, "<project_context>unrelated rules</project_context>"].join("\n"),
			capture({ contextFiles: [{ path: "/AGENTS.md", content: "unrelated rules" }] }),
		);
		assert.throws(
			() => captures.resolveOrDerive("A completely different prompt an extension rebuilt from scratch."),
			/no capture for this/,
		);
	});

	it("refuses to choose between concurrent turns that both look consistent", () => {
		// Two agent runs can record before either reaches a provider. Both prompts are
		// supersets of the requested one, so containment cannot separate them and
		// picking by recency would hand one agent the other's context files.
		const shared = [
			"You are an expert coding assistant operating inside pi.",
			"Current working directory: /work",
		].join("\n");
		const requested = shared;
		const captures = new PromptCaptures(64, undefined, () => {
			assert.fail("an ambiguous turn must not be resolved");
		});
		captures.record(`${shared}\n<project_context>one</project_context>`, capture());
		captures.record(`${shared}\n<project_context>two</project_context>`, capture());
		assert.throws(() => captures.resolveOrDerive(requested), /no capture for this/);
	});

	it("consumes the turn's candidate so a later turn cannot reuse it", () => {
		const recorded = "You are an expert coding assistant operating inside pi.\nCurrent working directory: /work";
		const captures = new PromptCaptures();
		captures.record(recorded, capture());
		assert.ok(captures.resolveOrDerive(recorded), "the turn resolves");
		// The next turn records nothing (pi reused the same prompt key), so there is no
		// candidate left and an unrelated prompt must fail rather than be served the
		// previous turn's capture.
		assert.throws(
			() => captures.resolveOrDerive("Something else entirely, with no shared structure at all."),
			/no capture for this/,
		);
	});

	it("recursively projects an inherited prompt without Pi's harness", () => {
		const browser = skill("browser");
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({
			contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }],
			skills: [browser],
		}));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, skills: [browser] }));

		const parent = project(captures, PARENT_KEY);
		const child = project(captures, CHILD_KEY);
		assert.ok(child.startsWith(parent), "child should retain the parent's projected cache prefix");
		assert.doesNotMatch(child, /operating inside pi|pi packages/);
		assert.match(child, /parent rules/);
		assert.match(child, /<sub_agent_context>child rules<\/sub_agent_context>/);
		assert.match(child, /<active_agent name="Plan"\/>/);
		assert.match(child, /<agent_instructions>plan carefully<\/agent_instructions>/);
		assert.equal(occurrences(child, "/skills/browser/SKILL.md"), 1);
	});

	it("leaves direct custom and replace-mode prompts byte-identical", () => {
		const captures = new PromptCaptures();
		captures.record("direct assembled", capture({ custom: "  direct user instructions\n" }));
		captures.record("replace assembled", capture({ custom: "<active_agent name=\"review\"/>\nreplace instructions" }));

		assert.equal(project(captures, "direct assembled"), "  direct user instructions\n");
		assert.equal(project(captures, "replace assembled"), "<active_agent name=\"review\"/>\nreplace instructions");
	});

	it("uses the longest inherited key for nested agents", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
		const grandSuffix = "\n\n<sub_agent_context>grandchild rules</sub_agent_context>";
		const grandKey = `${CHILD_KEY}${grandSuffix}\nCurrent working directory: /grandchild`;
		captures.record(grandKey, capture({ custom: `${CHILD_KEY}${grandSuffix}` }));

		const grandchild = project(captures, grandKey);
		assert.doesNotMatch(grandchild, /operating inside pi|Current working directory: \/parent|Current working directory: \/child/);
		assert.equal(occurrences(grandchild, "parent rules"), 1);
		assert.match(grandchild, /child rules/);
		assert.match(grandchild, /grandchild rules/);
	});

	it("retains inherited nodes after their lookup keys are evicted", () => {
		const captures = new PromptCaptures(2);
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "survives eviction" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
		captures.record("unrelated", capture());

		assert.equal(captures.resolve(PARENT_KEY), undefined);
		assert.match(project(captures, CHILD_KEY), /survives eviction/);
	});

	it("relinks an evicted ancestor through the live inheritance graph", () => {
		const captures = new PromptCaptures(2);
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "reachable ancestor" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
		captures.record("unrelated", capture());
		const changedKey = "changed child assembled prompt";
		captures.record(changedKey, capture({ custom: `${PARENT_KEY}\n\nchanged child rules` }));

		const changed = project(captures, changedKey);
		assert.doesNotMatch(changed, /operating inside pi/);
		assert.match(changed, /reachable ancestor/);
		assert.match(changed, /changed child rules/);
	});

	it("updates descendants through a re-recorded parent node", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "rules v1" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "rules v2" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, append: "child append" }));

		const child = project(captures, CHILD_KEY);
		assert.doesNotMatch(child, /rules v1|operating inside pi/);
		assert.match(child, /rules v2/);
		assert.match(child, /child append$/);
	});

	it("projects every non-overlapping occurrence of an inherited prompt", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "repeated rules" }] }));
		const repeatedCustom = `${PARENT_KEY}\nseparator\n${PARENT_KEY}`;
		captures.record("repeated child", capture({ custom: repeatedCustom }));

		const result = project(captures, "repeated child");
		assert.doesNotMatch(result, /operating inside pi/);
		assert.equal(occurrences(result, "repeated rules"), 2);
	});

	it("deduplicates inherited skills and preserves child-only skills", () => {
		const browser = skill("browser");
		const review = skill("review");
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ skills: [browser] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, skills: [browser, review] }));

		const childCapture = captures.resolve(CHILD_KEY);
		assert.deepEqual(collectPromptSkills(childCapture).map(({ name }) => name), ["browser", "review"]);
		const result = projectPromptCapture(childCapture, { skillReadTool: "mcp" });
		assert.equal(occurrences(result, "/skills/browser/SKILL.md"), 1);
		assert.equal(occurrences(result, "/skills/review/SKILL.md"), 1);
	});

	it("allows an enabled child skill when the inherited copy is hidden", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ skills: [skill("browser", { disabled: true })] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, skills: [skill("browser")] }));
		assert.equal(occurrences(project(captures, CHILD_KEY), "/skills/browser/SKILL.md"), 1);
	});

	it("is bounded and evicts the least-recently-recorded key", () => {
		const captures = new PromptCaptures(3);
		captures.record("a", capture());
		captures.record("b", capture());
		captures.record("c", capture());
		captures.record("a", capture({ custom: "refreshed" }));
		captures.record("d", capture());

		assert.equal(captures.size, 3);
		assert.equal(captures.resolve("b"), undefined);
		assert.equal(captures.resolve("a").custom, "refreshed");
		assert.ok(captures.resolve("c") && captures.resolve("d"));
	});
});

describe("getSharedPromptCaptures", () => {
	let previous;

	before(() => {
		previous = globalThis[PROMPT_CAPTURES_KEY];
	});
	beforeEach(() => {
		delete globalThis[PROMPT_CAPTURES_KEY];
	});
	after(() => {
		if (previous === undefined) delete globalThis[PROMPT_CAPTURES_KEY];
		else globalThis[PROMPT_CAPTURES_KEY] = previous;
	});

	it("reuses the first table so a later copy records where the first stream reads", () => {
		let created = 0;
		const first = getSharedPromptCaptures(() => {
			created++;
			return new PromptCaptures();
		});
		first.record("shared-key", capture({ custom: "from first copy" }));

		const second = getSharedPromptCaptures(() => {
			created++;
			return new PromptCaptures();
		});

		assert.equal(created, 1);
		assert.equal(second, first);
		assert.equal(second.resolve("shared-key").custom, "from first copy");
	});

	it("does not replace a table stored by another copy of this module", () => {
		// Another package root evaluates a different PromptCaptures class. instanceof
		// would fail; the stored object must still win so the first copy's stream
		// keeps seeing what later before_agent_start handlers record.
		const foreign = { resolve() { return "foreign"; } };
		globalThis[PROMPT_CAPTURES_KEY] = foreign;
		const got = getSharedPromptCaptures(() => new PromptCaptures());
		assert.equal(got, foreign);
	});
});
