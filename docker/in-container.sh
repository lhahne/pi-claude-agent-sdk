#!/usr/bin/env bash
# Runs inside the container. Prepares a writable copy of the mounted package and
# installs its runtime deps, then hands off to the requested check.
#
# Mounts expected:
#   /src        the repo under test (read-only)
#   /creds      auth.json for the live checks (read-only)
#   /harness    this repo's docker/ directory (read-only) — kept separate from /src
#               so the harness can drive an older package snapshot that predates it
#
# Everything else happens in the container-local $HOME, so the host's pi state,
# Claude state and OAuth credentials are never touched.
set -euo pipefail

MODE="${1:?usage: in-container.sh <prepare|unit|live|typecheck> [args...]}"
shift || true

PKG=/home/node/pkg
export CLAUDE_BRIDGE_DEBUG="${CLAUDE_BRIDGE_DEBUG:-1}"
export CLAUDE_BRIDGE_DEBUG_PATH="${CLAUDE_BRIDGE_DEBUG_PATH:-/home/node/logs/claude-bridge.log}"
mkdir -p "$(dirname "$CLAUDE_BRIDGE_DEBUG_PATH")"

prepare_pkg() {
	local with_dev="${1:-}"
	if [[ ! -d "$PKG" ]]; then
		# Exclude node_modules: the host's tree is for a different platform and would
		# be copied only to be replaced. .git and test output are dead weight too.
		mkdir -p "$PKG"
		tar -C /src \
			--exclude=./node_modules \
			--exclude=./.git \
			--exclude=./.test-output \
			-cf - . | tar -C "$PKG" -xf -
	fi
	cd "$PKG"
	# The extension ships TS source and pi compiles it itself, so the runtime deps
	# are enough for the live checks. The unit suite needs tsx, and typecheck needs
	# typescript.
	if [[ -n "$with_dev" ]]; then
		npm install --no-audit --no-fund --silent
	else
		npm install --omit=dev --no-audit --no-fund --silent
	fi
}

# Pin the pi packages the suite resolves to the version under test.
#
# Normally a no-op: the devDependencies track the newest pi, which is what this
# package supports. It stays because the build arg and the devDependencies can
# drift apart, and a suite resolving against a different pi-ai than the CLI under
# test would quietly prove nothing.
pin_pi_version() {
	cd "$PKG"
	npm install --no-audit --no-fund --silent \
		"@earendil-works/pi-ai@$PI_VERSION" \
		"@earendil-works/pi-coding-agent@$PI_VERSION"
	local resolved
	resolved=$(node -p "require('./node_modules/@earendil-works/pi-ai/package.json').version")
	[[ "$resolved" == "$PI_VERSION" ]] || {
		echo "ERROR: pi-ai resolved to $resolved, expected $PI_VERSION" >&2
		return 1
	}
	echo "unit suite will run against pi-ai $resolved"
}

prepare_creds() {
	mkdir -p "$HOME/.pi/agent"
	cp /creds/auth.json "$HOME/.pi/agent/auth.json"
	chmod 600 "$HOME/.pi/agent/auth.json"
}

case "$MODE" in
	prepare)
		prepare_pkg
		prepare_creds
		echo "prepared: pi=$(pi --version) pkg=$PKG"
		;;
	unit)
		prepare_pkg dev
		pin_pi_version
		cd "$PKG"
		npm run test:unit
		;;
	typecheck)
		# typecheck runs against the newest pi the package declares, so it keeps
		# catching new API drift rather than pinning itself to an old release.
		prepare_pkg dev
		cd "$PKG"
		npx tsc --noEmit
		echo "typecheck OK"
		;;
	live)
		prepare_pkg
		prepare_creds
		# Best-effort: the third-party extension the prompt-capture fallback exists for.
		# It strips its own tool from the active set inside before_agent_start whenever
		# ctx.hasUI is false, which is what makes pi's rendered prompt and the transcript
		# pi writes disagree. Installed rather than modelled with a fixture because a
		# fixture could not reproduce it: registerTool does not put a tool into the base
		# prompt options, so stripping it was a no-op and the check passed without
		# exercising anything. A failed install just skips the check.
		if [[ ! -d /home/node/probe/node_modules/@juicesharp/rpiv-ask-user-question ]]; then
			npm install --prefix /home/node/probe --no-audit --no-fund --silent \
				@juicesharp/rpiv-ask-user-question >/dev/null 2>&1 || true
		fi
		exec bash /harness/live-check.sh "$@"
		;;
	*)
		echo "unknown mode: $MODE" >&2
		exit 2
		;;
esac
