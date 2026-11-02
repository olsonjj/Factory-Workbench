# Claude-enabled sandbox image for the factory's `agent.provider: "claude"`
# runs. Mirrors @ai-hero/sandcastle 0.12.0's CLAUDE_CODE_DOCKERFILE template
# (node_modules/@ai-hero/sandcastle/dist/main.js), minus the
# {{ISSUE_TRACKER_TOOLS}} placeholder: the factory's sandbox stages need only
# git/curl/jq — PR publishing runs host-side `gh` via GhPrPublisher, and the
# pi image's issue-tracker block is a sandcastle-scaffold feature, not a
# factory requirement (a future sandbox `gh` need would be an explicit
# follow-up).
#
# Build (the UID/GID build-args are REQUIRED — see README "Choosing the agent
# provider": Sandcastle's docker provider inspects the image's default user
# and refuses to start a sandbox on UID mismatch with the host user):
#
#   docker build -f docker/claude.Dockerfile \
#     --build-arg AGENT_UID="$(id -u)" --build-arg AGENT_GID="$(id -g)" \
#     -t sandcastle:claude .
#
# Then point factory.config.json at it: "sandbox": { "imageName": "sandcastle:claude" }

FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Build-args for UID/GID alignment — REQUIRED, see header: the sandcastle
# docker provider runs a UID-mismatch check against the image's default user.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI (baked into the image; no claude install on the
# host — auth reaches the sandbox via env only: ANTHROPIC_API_KEY or
# CLAUDE_CODE_OAUTH_TOKEN).
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

ENTRYPOINT ["sleep", "infinity"]