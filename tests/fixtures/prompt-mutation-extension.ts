// Test extension: patches a system prompt section on every turn after the first,
// so pi's transcript gains a mid-conversation `system` message carrying a section
// delta.
//
// This is the case the bridge's pi 0.86 support has to get right. The provider
// rebuilds the *current* prompt with getCurrentSystemPrompt(), replaying those
// deltas, and then asks PromptCaptures to account for it. If the replay diverges
// by so much as a section's placement from what before_agent_start recorded, the
// resolver throws and the turn fails — loudly, which is the point, but it would
// mean every user with a prompt-mutating extension is broken.
//
// The resolved path is worth knowing, because it is not the obvious one. Handlers
// run in registration order, so with the bridge loaded first it records the prompt
// *before* this extension mutates it. The provider therefore sees a prompt that
// matches no capture exactly — but it embeds one, and resolveOrDerive's wrapper
// path then carries the surrounding text through unchanged while substituting the
// embedded capture's portable parts. That is what forwards the mutation to Claude
// Code; dropping it would be the silent instruction loss prompt capture exists to
// prevent.
//
// The mutation is deliberately different on each turn so pi emits a fresh delta
// rather than deduplicating it away, and carries an unmistakable token so the test
// can tell "the section never reached Claude Code" apart from "the model ignored
// the instruction".
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let turns = 0;
	pi.on("before_agent_start", (event) => {
		turns += 1;
		if (turns < 2) return;
		event.systemPromptOptions.sections = {
			...event.systemPromptOptions.sections,
			"prompt-mutation-test": `Mutation ${turns}. You must begin every reply with the exact token MUTATION${turns}.`,
		};
	});
}
