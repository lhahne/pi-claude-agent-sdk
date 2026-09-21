#!/usr/bin/env bash
# Live Claude Code checks, run inside the container by docker/in-container.sh live.
#
# Asserts both the user-visible result and the bridge's internal invariants from
# its debug log. The log assertions matter more than the answer text: the pi 0.86
# regression produced a *plausible-looking* failure ("No conversation found")
# only after silently converting a non-empty context to zero records, so the
# invariants are what actually pin the fix.
set -uo pipefail

PKG="${PKG:-/home/node/pkg}"
MODEL="${MODEL:-claude-bridge/claude-haiku-4-5}"
WORK=/home/node/live
rm -rf "$WORK"; mkdir -p "$WORK"

PASS=0
FAIL=0

LOG="$CLAUDE_BRIDGE_DEBUG_PATH"

check() {
	local name="$1" ok="$2" detail="${3:-}"
	if [[ "$ok" == "1" ]]; then
		printf '%-58s PASS\n' "$name"
		PASS=$((PASS + 1))
	else
		printf '%-58s FAIL  %s\n' "$name" "$detail"
		FAIL=$((FAIL + 1))
	fi
}

# Assert the bridge never hit the pi 0.86 failure chain. Runs against the whole
# accumulated log, so it covers every turn of every check below.
assert_log_invariants() {
	local label="$1"
	if grep -q -- "→ 0 anthropic msgs" "$LOG" 2>/dev/null; then
		check "$label: no zero-record conversion" 0 "$(grep -m1 -- '→ 0 anthropic msgs' "$LOG")"
	else
		check "$label: no zero-record conversion" 1
	fi
	if grep -q "file missing after save" "$LOG" 2>/dev/null; then
		check "$label: session file written" 0 "$(grep -m1 'file missing after save' "$LOG" | cut -c1-140)"
	else
		check "$label: session file written" 1
	fi
	if grep -q "No conversation found with session ID" "$LOG" 2>/dev/null; then
		check "$label: no missing-session resume" 0 "$(grep -m1 'No conversation found' "$LOG" | cut -c1-140)"
	else
		check "$label: no missing-session resume" 1
	fi
}

echo "=== live checks: pi=$(pi --version) model=$MODEL ==="
echo ""

# --- 1. Single turn -----------------------------------------------------------------
# The smallest case that reproduces the original bug: one user message, no tools
# used. Under 0.86 the leading system message became the only "prior" message,
# producing an empty session that was then resumed.
OUT1="$WORK/single.txt"
: > "$LOG"
pi --no-session -ne -e "$PKG" --model "$MODEL" -p "Reply with just the word yes" > "$OUT1" 2>&1
RC=$?
check "single turn: exit 0" "$([[ $RC -eq 0 ]] && echo 1 || echo 0)" "exit=$RC"
check "single turn: answered" "$(grep -qi 'yes' "$OUT1" && echo 1 || echo 0)" "$(head -c 140 "$OUT1")"

# Tools must come from getCurrentTools() on 0.86; upstream reported tools=0.
TOOLS=$(grep -o 'tools=[0-9]*' "$LOG" | head -1 | cut -d= -f2)
check "single turn: tools resolved (>0)" "$([[ -n "$TOOLS" && "$TOOLS" -gt 0 ]] && echo 1 || echo 0)" "tools=${TOOLS:-none}"

# A first turn has no prior history, so it takes the clean-start path and never
# converts anything — the conversion invariant belongs to the rebuild check below.
assert_log_invariants "single turn"

# --- 2. Tool round-trip -------------------------------------------------------------
# Proves the MCP tool servers were built from the transcript's tool declarations
# and that a pi tool call survives the full dispatch/result cycle.
OUT2="$WORK/tool.txt"
: > "$LOG"
pi --no-session -ne -e "$PKG" --model "$MODEL" \
	-p "Read the file $PKG/package.json and reply with only the value of its \"version\" field." > "$OUT2" 2>&1
RC=$?
VERSION=$(jq -r .version "$PKG/package.json")
check "tool round-trip: exit 0" "$([[ $RC -eq 0 ]] && echo 1 || echo 0)" "exit=$RC"
check "tool round-trip: read real file contents" "$(grep -qF "$VERSION" "$OUT2" && echo 1 || echo 0)" "want=$VERSION got=$(head -c 140 "$OUT2")"
check "tool round-trip: MCP tool dispatched" "$(grep -q 'mcp handler:' "$LOG" && echo 1 || echo 0)" "no mcp handler line"
assert_log_invariants "tool round-trip"

# --- 3. Multi-turn in-process (session REUSE) ---------------------------------------
# Three turns in one process must reuse the Claude Code session built on turn 1
# and never rebuild it. Rebuilding here would mean the cursor is wrong — the 0.86
# break advanced the cursor past a session whose file was never written.
OUT3="$WORK/multi.txt"
: > "$LOG"
pi --no-session -ne -e "$PKG" --model "$MODEL" -p \
	"My favourite colour is teal. Reply with just: ok" \
	"Read $PKG/README.md and tell me the first heading. Be brief." \
	"What is my favourite colour? Reply with just the colour." > "$OUT3" 2>&1
RC=$?
REUSE=$(grep -c 'Case 3:' "$LOG")
REBUILDS=$(grep -c 'path=rebuild' "$LOG")
check "multi-turn: exit 0" "$([[ $RC -eq 0 ]] && echo 1 || echo 0)" "exit=$RC"
check "multi-turn: recalled earlier turn" "$(grep -qi 'teal' "$OUT3" && echo 1 || echo 0)" "$(tail -c 200 "$OUT3")"
check "multi-turn: reused session (Case 3)" "$([[ $REUSE -ge 2 ]] && echo 1 || echo 0)" "reuse lines=$REUSE"
check "multi-turn: no spurious rebuild" "$([[ $REBUILDS -eq 0 ]] && echo 1 || echo 0)" "rebuilds=$REBUILDS"
assert_log_invariants "multi-turn"

# --- 4. Cross-process continue (the REBUILD path) -----------------------------------
# The path the 0.86 break actually damaged. A *new* pi process continuing a
# persisted session has no in-memory shared session, so it rebuilds the Claude Code
# transcript from pi's history — this is where "1 pi msgs → 0 anthropic msgs" and
# the empty session file came from. Requires a persisted pi session, so no
# --no-session, and a dedicated cwd so `-c` cannot pick up another check's session.
REBUILD_DIR="$WORK/rebuild"
mkdir -p "$REBUILD_DIR"
OUT4A="$WORK/rebuild-1.txt"
OUT4B="$WORK/rebuild-2.txt"
: > "$LOG"
(cd "$REBUILD_DIR" && pi -ne -e "$PKG" --model "$MODEL" \
	-p "My favourite colour is teal. Reply with just: ok" > "$OUT4A" 2>&1)
RC1=$?
(cd "$REBUILD_DIR" && pi -ne -e "$PKG" --model "$MODEL" -c \
	-p "What is my favourite colour? Reply with just the colour." > "$OUT4B" 2>&1)
RC2=$?

PRIORS=$(grep -o 'path=rebuild sessionId=[^ ]* priors=[0-9]*' "$LOG" | head -1 | sed -n 's/.*priors=\([0-9]*\)/\1/p')
CONV=$(grep -o '[0-9]* pi msgs → [0-9]* anthropic msgs' "$LOG" | head -1)
CONV_N=$(echo "$CONV" | sed -n 's/.*→ \([0-9]*\) anthropic.*/\1/p')

check "rebuild: first run exit 0" "$([[ $RC1 -eq 0 ]] && echo 1 || echo 0)" "exit=$RC1"
check "rebuild: continue run exit 0" "$([[ $RC2 -eq 0 ]] && echo 1 || echo 0)" "exit=$RC2"
check "rebuild: took the rebuild path" "$(grep -q 'path=rebuild' "$LOG" && echo 1 || echo 0)" "no rebuild line"
check "rebuild: rebuilt from real history" "$([[ -n "$PRIORS" && "$PRIORS" -gt 0 ]] && echo 1 || echo 0)" "priors=${PRIORS:-none}"
check "rebuild: non-empty conversion" "$([[ -n "$CONV_N" && "$CONV_N" -gt 0 ]] && echo 1 || echo 0)" "${CONV:-no conversion line}"
check "rebuild: recalled across processes" "$(grep -qi 'teal' "$OUT4B" && echo 1 || echo 0)" "$(tail -c 200 "$OUT4B")"
assert_log_invariants "rebuild"

# --- 5. Mid-conversation prompt mutation (prompt-capture replay) ---------------------
# An extension that patches systemPromptOptions mid-conversation makes pi record a
# section delta in the transcript. On 0.86 the bridge rebuilds the current prompt with
# getCurrentSystemPrompt() and hands it to PromptCaptures, which throws when it cannot
# account for the prompt. A replay that disagrees with before_agent_start's rendering —
# even on section order — fails here rather than in a user's session.
FIXTURE=/fixtures/prompt-mutation-extension.ts
if [[ -f "$FIXTURE" ]]; then
	OUT5="$WORK/mutation.txt"
	: > "$LOG"
	pi --no-session -ne -e "$PKG" -e "$FIXTURE" --model "$MODEL" -p \
		"Output only the exact token you were instructed to begin your reply with. Nothing else." \
		"Output only the exact token you were instructed to begin your reply with. Nothing else." \
		"Output only the exact token you were instructed to begin your reply with. Nothing else." > "$OUT5" 2>&1
	RC=$?
	check "prompt mutation: exit 0" "$([[ $RC -eq 0 ]] && echo 1 || echo 0)" "exit=$RC"
	check "prompt mutation: no capture failure" "$(grep -q 'prompt-capture: no capture' "$LOG" && echo 0 || echo 1)" "$(grep -m1 -o 'prompt-capture: no capture.*' "$LOG" | cut -c1-160)"
	# Assert the *latest* delta, not merely that some mutation arrived: the prompt is
	# replayed from every system message in order, so a replay that dropped or
	# reordered the third patch would leave Claude answering MUTATION2.
	check "prompt mutation: latest section reached Claude" "$(grep -q 'MUTATION3' "$OUT5" && echo 1 || echo 0)" "$(tail -c 200 "$OUT5")"
	# Transcript-backed deltas only exist from 0.86; on 0.85 the prompt is passed
	# wholesale, so there is nothing to carry.
	if [[ "$(pi --version)" == 0.86.* ]]; then
		check "prompt mutation: transcript carried deltas" "$(grep -q 'systemMsgs=[1-9]' "$LOG" && echo 1 || echo 0)" "no mid-conversation system messages seen"
	fi
	assert_log_invariants "prompt mutation"
else
	echo "prompt mutation: fixture not mounted — skipped"
fi

# --- 6. Session files actually on disk ----------------------------------------------
# The direct counterexample to "file missing after save": at least one CC
# transcript must exist and be non-empty.
SESS_COUNT=$(find "$HOME/.claude/projects" -name '*.jsonl' -size +0 2>/dev/null | wc -l | tr -d ' ')
check "claude sessions written to disk" "$([[ "$SESS_COUNT" -gt 0 ]] && echo 1 || echo 0)" "found=$SESS_COUNT"

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
