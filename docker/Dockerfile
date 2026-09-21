# Throwaway test container for pi-claude-agent-sdk across pi releases.
#
# Runs as the non-root `node` user: Claude Code refuses
# --dangerously-skip-permissions as root ("cannot be used with root/sudo
# privileges for security reasons"), which the bridge always passes.
#
# The package under test is NOT baked in — the repo is mounted read-only at /src
# and copied to a container-local path at run time, so nothing installs onto the
# host and every run reflects the current working tree.

ARG PI_VERSION=0.86.1
FROM node:22-slim

ARG PI_VERSION
ENV PI_VERSION=${PI_VERSION}

RUN apt-get update \
 && apt-get install -y --no-install-recommends git jq ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Global install needs root; the test itself must not run as root.
RUN npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent@${PI_VERSION} \
 && pi --version

USER node
WORKDIR /home/node
CMD ["bash"]
