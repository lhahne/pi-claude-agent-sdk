// Pi provider-context normalization.
//
// Pi 0.86 changed the input to a custom provider's `streamSimple` from `Context`
// to a branded `TranscriptContext`: `{ messages }`, where the system prompt and
// the tool declarations are folded into a leading `system` message by
// `normalizeContext()` before the provider is called. `context.systemPrompt` and
// `context.tools` no longer exist.
//
// This package targets the current pi only, so the transcript is read directly
// rather than probed for. What remains is the guard: a provider input that still
// carries the old explicit fields means something bypassed `normalizeContext()`,
// and the failure mode that produces is expensive and silent. Under 0.86 an
// unrecognised system message is counted as conversation history, converts to
// zero Anthropic records, and `cc-session-io` writes no file for an empty
// session — after which the caller resumes a UUID that does not exist and Claude
// Code answers "No conversation found with session ID", several steps from the
// cause. Refusing the shape outright costs one turn and names the problem.
//
// Everything downstream works on the normalized shape, which has one important
// property: `messages` contains no system messages at all. The bridge's session
// cursor, its history/prompt split and its message conversion then share a single
// index space, so no offset arithmetic can drift.

import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import type { Message, Tool, TranscriptContext } from "@earendil-works/pi-ai";

export interface PiProviderContext {
	/** The current system prompt, with any mid-conversation section patches replayed. */
	systemPrompt?: string;
	/** The current tool set, after every transcript addition and removal. */
	tools: Tool[];
	/** The transcript with every system message removed. */
	messages: Message[];
	/** Whether the transcript carried a system message at all. False for a bare
	 *  completion with neither a prompt nor tools — `createInitialSystemMessage`
	 *  returns undefined for an empty prompt and tool set, so there is no leading
	 *  message to read. */
	transcript: boolean;
}

export function normalizePiContext(context: TranscriptContext): PiProviderContext {
	const raw: Message[] = Array.isArray(context?.messages) ? context.messages : [];
	const systemMessages = raw.filter((message) => message.role === "system");

	if (systemMessages.length === 0) {
		// No system message is normal when the caller supplied neither a prompt nor
		// tools. Stray explicit fields are not: they mean a raw `Context` — the shape
		// pi used before 0.86 — reached a provider that now only ever receives
		// normalized transcripts. Reading them would appear to work while silently
		// dropping any mid-conversation prompt change pi recorded, so refuse instead.
		// Nothing in pi calls a provider without normalizing, so this is a misuse
		// guard rather than a compatibility path.
		const legacy = context as unknown as { systemPrompt?: string; tools?: Tool[] };
		if (legacy.systemPrompt || legacy.tools?.length) {
			throw new Error(
				"pi-context: provider input carries systemPrompt/tools but no system message. "
				+ "This is a raw Context, not the TranscriptContext pi 0.86+ produces — the system prompt "
				+ "would be lost. Route the call through Models.stream()/streamSimple() so normalizeContext() runs.",
			);
		}
		return { systemPrompt: undefined, tools: [], messages: raw, transcript: false };
	}

	return {
		systemPrompt: getCurrentSystemPrompt(raw) || undefined,
		tools: getCurrentTools(raw),
		messages: raw.filter((message) => message.role !== "system"),
		transcript: true,
	};
}
