#!/usr/bin/env bash
# Host-side orchestrator for the cross-version Docker matrix.
#
#   ./docker/run-matrix.sh                 # full matrix
#   ./docker/run-matrix.sh live-086-fork   # one case by name
#   ./docker/run-matrix.sh --list          # case names
#
# Nothing is installed on the host. The repo is mounted read-only and copied into
# the container; pi and Claude Code state live entirely in the container's HOME.
#
# Colima only shares $HOME, so all scratch lives under ~/.cache — a /tmp mount
# silently appears empty inside the container.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="${PI_BRIDGE_DOCKER_SCRATCH:-$HOME/.cache/pi-claude-agent-sdk-docker}"
UPSTREAM_REF="${UPSTREAM_REF:-v0.8.6}"
CREDS_SRC="${CREDS_SRC:-$HOME/.pi/agent/auth.json}"
MODEL="${MODEL:-claude-bridge/claude-haiku-4-5}"

mkdir -p "$SCRATCH/logs"

# --- credentials --------------------------------------------------------------------
# Copied, never bind-mounted writable: the container must not be able to rotate
# the host's OAuth refresh token. `expires` is pushed far into the future so pi
# treats the access token as fresh and never calls the refresh endpoint at all —
# that call is the only way this test could invalidate the host's credential.
# The access token is short-lived (~8h); re-run after using pi on the host if the
# live checks start failing to authenticate.
prepare_creds() {
	local out="$SCRATCH/creds/auth.json"
	mkdir -p "$SCRATCH/creds"
	if [[ ! -f "$CREDS_SRC" ]]; then
		echo "ERROR: no credentials at $CREDS_SRC (set CREDS_SRC)" >&2
		exit 1
	fi
	python3 - "$CREDS_SRC" "$out" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
data = json.load(open(src))
entry = data.get("anthropic")
if not entry:
    sys.exit("ERROR: no `anthropic` entry in auth.json")
if entry.get("type") == "oauth":
    entry["expires"] = 4102444800000  # 2100-01-01: suppress refresh entirely
json.dump(data, open(dst, "w"), indent=2)
PY
	chmod 600 "$out"
}

# --- images -------------------------------------------------------------------------
image_for() {
	echo "pi-bridge-test:$1"
}

build_image() {
	local pi_version="$1"
	local tag
	tag="$(image_for "$pi_version")"
	if docker image inspect "$tag" >/dev/null 2>&1; then
		echo "image $tag already built"
		return 0
	fi
	echo "building $tag (pi $pi_version)..."
	docker build \
		--build-arg "PI_VERSION=$pi_version" \
		-t "$tag" \
		"$REPO/docker" >/dev/null || return 1
	echo "built $tag"
}

# --- package snapshots --------------------------------------------------------------
# A pristine upstream tree, so the failing baseline is the *released* package and
# not this working tree.
prepare_upstream() {
	local dest="$SCRATCH/upstream-$UPSTREAM_REF"
	if [[ -d "$dest" ]]; then
		return 0
	fi
	mkdir -p "$dest"
	git -C "$REPO" archive "$UPSTREAM_REF" | tar -x -C "$dest" || return 1
	echo "extracted $UPSTREAM_REF to $dest"
}

# --- case runner --------------------------------------------------------------------
# run_case <name> <pi_version> <pkg_dir> <mode> <expect: pass|fail> [required_pattern]
#
# `required_pattern` is what stops an expected failure from being a false pass: a
# case that is supposed to break must break for the stated reason. The first run of
# this harness reported "fail (as expected)" for a package snapshot that predated
# the harness scripts and died on a missing file — a green tick for a broken setup.
run_case() {
	local name="$1" pi_version="$2" pkg="$3" mode="$4" expect="$5" pattern="${6:-}"
	local image logdir cid rc
	image="$(image_for "$pi_version")"
	logdir="$SCRATCH/logs/$name"
	rm -rf "$logdir"; mkdir -p "$logdir"

	printf '%-24s pi=%-7s %-9s ' "$name" "$pi_version" "$mode"

	cid=$(docker create \
		-v "$pkg:/src:ro" \
		-v "$REPO/docker:/harness:ro" \
		-v "$REPO/tests/fixtures:/fixtures:ro" \
		-v "$SCRATCH/creds:/creds:ro" \
		-e "MODEL=$MODEL" \
		-e "CLAUDE_BRIDGE_DEBUG=1" \
		-e "CLAUDE_BRIDGE_DEBUG_PATH=/home/node/logs/claude-bridge.log" \
		"$image" bash -lc "mkdir -p /home/node/logs && bash /harness/in-container.sh $mode" 2>/dev/null)
	if [[ -z "$cid" ]]; then
		printf 'FAIL (container create)\n'
		return 1
	fi

	docker start -a "$cid" > "$logdir/stdout.log" 2>&1
	rc=$?
	docker cp "$cid:/home/node/logs/." "$logdir/" >/dev/null 2>&1
	# The check outputs and the container's pi/Claude state are what make a failure
	# debuggable after the fact; the container itself is gone either way.
	docker cp "$cid:/home/node/live/." "$logdir/live/" >/dev/null 2>&1
	docker rm "$cid" >/dev/null 2>&1

	local got="pass"
	[[ $rc -eq 0 ]] || got="fail"

	# An expected failure only counts if it failed for the documented reason.
	if [[ "$expect" == "fail" && -n "$pattern" ]]; then
		if ! grep -qF -- "$pattern" "$logdir/claude-bridge.log" 2>/dev/null; then
			printf 'fail (WRONG REASON — %s not in log)\n' "$pattern"
			tail -15 "$logdir/stdout.log" | sed 's/^/    | /'
			return 1
		fi
	fi

	if [[ "$got" == "$expect" ]]; then
		printf '%s (as expected)\n' "$got"
		return 0
	fi
	printf '%s (EXPECTED %s)\n' "$got" "$expect"
	tail -25 "$logdir/stdout.log" | sed 's/^/    | /'
	return 1
}

# --- cases --------------------------------------------------------------------------
FAILURES=0
run_all() {
	local upstream="$SCRATCH/upstream-$UPSTREAM_REF"

	echo "=== pi-claude-agent-sdk docker matrix ==="
	echo "repo:    $REPO"
	echo "scratch: $SCRATCH"
	echo ""

	prepare_creds || exit 1
	prepare_upstream || exit 1

	build_image 0.86.1 || { echo "build failed"; exit 1; }
	echo ""

	# Row 1 is the regression baseline: the released bridge on the new pi. It MUST
	# fail, and with the specific missing-session error — otherwise the harness is
	# not actually exercising the bug and the fix proves nothing.
	run_case "baseline-086-upstream" 0.86.1 "$upstream" live fail "No conversation found with session ID" \
		|| FAILURES=$((FAILURES + 1))

	run_case "live-086-fork"    0.86.1 "$REPO" live pass || FAILURES=$((FAILURES + 1))

	run_case "unit-086-fork"    0.86.1 "$REPO" unit pass || FAILURES=$((FAILURES + 1))
	run_case "typecheck-086-fork" 0.86.1 "$REPO" typecheck pass || FAILURES=$((FAILURES + 1))

	echo ""
	if [[ $FAILURES -eq 0 ]]; then
		echo "matrix: ALL EXPECTATIONS MET"
	else
		echo "matrix: $FAILURES case(s) did not meet expectations"
	fi
	echo "logs: $SCRATCH/logs"
	[[ $FAILURES -eq 0 ]]
}

# --- single case --------------------------------------------------------------------
# Names are stable so a failing row can be re-run without paying for the matrix.
run_single() {
	local name="$1" upstream="$SCRATCH/upstream-$UPSTREAM_REF"
	prepare_creds || exit 1
	prepare_upstream || exit 1
	case "$name" in
		baseline-086-upstream) build_image 0.86.1 && run_case "$name" 0.86.1 "$upstream" live fail "No conversation found with session ID" ;;
		live-086-fork)         build_image 0.86.1 && run_case "$name" 0.86.1 "$REPO" live pass ;;
		unit-086-fork)         build_image 0.86.1 && run_case "$name" 0.86.1 "$REPO" unit pass ;;
		typecheck-086-fork)    build_image 0.86.1 && run_case "$name" 0.86.1 "$REPO" typecheck pass ;;
		*) echo "unknown case: $name (use --list)" >&2; exit 2 ;;
	esac
}

case "${1:-}" in
	--list)
		echo "baseline-086-upstream live-086-fork unit-086-fork typecheck-086-fork"
		;;
	"")
		run_all
		;;
	*)
		run_single "$1"
		;;
esac
