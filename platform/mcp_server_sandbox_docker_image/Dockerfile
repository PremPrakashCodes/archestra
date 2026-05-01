# syntax=docker/dockerfile:1.7
#
# MCP Sandbox base image.
#
# Runtime for `runtimeProfile: sandbox` MCP servers. Diverges from
# `mcp_server_docker_image` because the sandbox needs:
#
#   - Ubuntu 24.04 (glibc) instead of Alpine (musl) — many data-science
#     packages publish glibc-only wheels.
#   - Python + Node + Bun toolchains pre-installed so the agent can do
#     real work without spending the first ~30s on pip install.
#   - tmux + ttyd for the live read-only terminal panel.
#   - A single non-root user `sandbox` (uid 1000); pod-level security
#     context (read-only root FS, dropped capabilities, seccomp,
#     AppArmor, no service-account token) is applied by the K8s YAML
#     generator, not baked into the image.
#
# Multi-stage layout:
#   1. python-builder      — uv-driven hash-pinned Python venv at /opt/venv
#   2. node-builder        — Node 22 LTS + global dev tooling at /opt/node
#   3. bun-fetcher         — pinned Bun release archive, sha256-verified
#   4. ttyd-fetcher        — pinned ttyd release binary, sha256-verified
#   5. mcp-server-builder  — npm-installed + tsc-compiled in-pod MCP server
#   6. final               — Ubuntu 24.04 runtime, copies everything in

ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:d415caac2f1f77b98caaf9415c5f807e14bc8d7bdea62561ea2fef4fbd08a73c
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.26@sha256:9a23023be68b2ed09750ae636228e903a54a05ea56ed03a934d00fe9fbeded4b

# Per-arch pinned upstream artifacts. The default values target amd64;
# the buildx multi-arch matrix passes TARGETARCH at build time, and the
# stages branch on it to download the right binary. The shas below were
# captured at image authoring time — bumping the upstream version means
# updating both the URL and the hash for every arch.
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256_AMD64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_ARM64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165

ARG BUN_VERSION=1.3.13
ARG BUN_SHA256_AMD64=79c0771fa8b92c33aae41e15a0e0d307ea99d0e2f00317c71c6c53237a78e25a
ARG BUN_SHA256_ARM64=70bae41b3908b0a120e1e58c5c8af30e74afae3b8d11b0d3fdd8e787ddfb4b22

ARG SANDBOX_UID=1000
ARG SANDBOX_GID=1000

# ============================================================================
# Stage 1: Python builder
# ============================================================================
FROM ${UBUNTU_IMAGE} AS python-builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      python3.12 \
      python3.12-dev \
      python3.12-venv \
      build-essential \
      pkg-config \
      libffi-dev \
      libxml2-dev \
      libxslt1-dev \
      libjpeg-dev \
      zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.9.26@sha256:9a23023be68b2ed09750ae636228e903a54a05ea56ed03a934d00fe9fbeded4b /uv /usr/local/bin/uv
COPY --from=ghcr.io/astral-sh/uv:0.9.26@sha256:9a23023be68b2ed09750ae636228e903a54a05ea56ed03a934d00fe9fbeded4b /uvx /usr/local/bin/uvx
RUN chmod +x /usr/local/bin/uv /usr/local/bin/uvx

# Build the venv with hash-pinned wheels. The lockfile is universal
# (see Makefile), so it works on both amd64 and arm64 hosts; uv selects
# the matching wheel by platform at install time and verifies the hash.
RUN uv venv /opt/venv --python 3.12
ENV PATH="/opt/venv/bin:$PATH"

COPY pyproject.toml requirements.lock /tmp/python-deps/
RUN uv pip install --upgrade wheel pip
RUN uv pip sync \
      --no-cache \
      --require-hashes \
      --python-version 3.12 \
      /tmp/python-deps/requirements.lock

# ============================================================================
# Stage 2: Node builder
# ============================================================================
FROM ${NODE_IMAGE} AS node-builder

WORKDIR /opt/node-deps
COPY package.json ./
# `npm install` (not `npm ci`) — the sandbox image keeps no committed
# package-lock.json since the dev tools we install are loose pins
# (typescript@^5, prettier@^3, etc.) intended to be the most recent
# stable release at build time. CI re-resolves on every build.
RUN npm install --production=false --no-audit --no-fund

# ============================================================================
# Stage 3: Bun fetcher
# ============================================================================
FROM ${UBUNTU_IMAGE} AS bun-fetcher

ARG BUN_VERSION
ARG BUN_SHA256_AMD64
ARG BUN_SHA256_ARM64
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) BUN_ARCH=x64;        BUN_SHA256="${BUN_SHA256_AMD64}" ;; \
      arm64) BUN_ARCH=aarch64;    BUN_SHA256="${BUN_SHA256_ARM64}" ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip"; \
    echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c -; \
    unzip -q /tmp/bun.zip -d /tmp/bun-extract; \
    install -m 0755 "/tmp/bun-extract/bun-linux-${BUN_ARCH}/bun" /usr/local/bin/bun; \
    rm -rf /tmp/bun.zip /tmp/bun-extract

# ============================================================================
# Stage 4: ttyd fetcher
# ============================================================================
FROM ${UBUNTU_IMAGE} AS ttyd-fetcher

ARG TTYD_VERSION
ARG TTYD_SHA256_AMD64
ARG TTYD_SHA256_ARM64
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) TTYD_ARCH=x86_64;  TTYD_SHA256="${TTYD_SHA256_AMD64}" ;; \
      arm64) TTYD_ARCH=aarch64; TTYD_SHA256="${TTYD_SHA256_ARM64}" ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${TTYD_ARCH}"; \
    echo "${TTYD_SHA256}  /tmp/ttyd" | sha256sum -c -; \
    install -m 0755 /tmp/ttyd /usr/local/bin/ttyd; \
    rm -f /tmp/ttyd

# ============================================================================
# Stage 5: In-pod MCP server builder
# ============================================================================
# Builds the agent-facing MCP server bundle (pty_*/file_* tools, tmux
# broker, path-guard, bearer-token reload). Output lands at
# /opt/sandbox-mcp/{dist,node_modules,package.json} and is copied into
# the final image. The supervisor (sandbox-entrypoint.sh) auto-detects
# /opt/sandbox-mcp/dist/server.js on boot.
FROM ${NODE_IMAGE} AS mcp-server-builder

WORKDIR /opt/sandbox-mcp

COPY in_pod_server/package.json in_pod_server/package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund --ignore-scripts

COPY in_pod_server/tsconfig.json ./
COPY in_pod_server/src ./src
RUN npm run build

# Drop dev deps so the runtime image carries only what the server needs
# at startup. `npm prune` keeps the lockfile coherent.
RUN npm prune --omit=dev --no-audit --no-fund --ignore-scripts

# ============================================================================
# Stage 6: Final runtime image
# ============================================================================
FROM ${UBUNTU_IMAGE}

ARG SANDBOX_UID
ARG SANDBOX_GID

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV PYTHONUNBUFFERED=1

# Runtime apt packages.
#
# Two policy notes:
#   - `tini` is included so the image works standalone (`docker run`)
#     even when the K8s Job spec doesn't set its own PID 1 wrapper.
#   - `python3.12` is installed without -dev / build-essential to keep
#     the runtime image small. The agent can `apt-get install` extras
#     interactively at runtime, since we keep apt working in the pod.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      zsh \
      tmux \
      tini \
      git \
      gh \
      curl \
      wget \
      jq \
      ripgrep \
      fzf \
      vim \
      nano \
      unzip \
      zip \
      gzip \
      p7zip-full \
      rsync \
      poppler-utils \
      ca-certificates \
      openssh-client \
      passwd \
      adduser \
      python3.12 \
      python3.12-venv \
      libffi8 \
      libxml2 \
      libxslt1.1 \
      libjpeg-turbo8 \
      zlib1g \
      libstdc++6 \
      libgcc-s1 \
      locales \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.12 /usr/local/bin/python \
    && ln -sf /usr/bin/python3.12 /usr/local/bin/python3

# Ensure ca-certificates are kept up to date.
RUN update-ca-certificates

# Copy pre-built artifacts from earlier stages.
COPY --from=python-builder /opt/venv /opt/venv
COPY --from=node-builder /opt/node-deps/node_modules /opt/node-deps/node_modules
COPY --from=node-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=node-builder /usr/local/bin/npm /usr/local/bin/npm
COPY --from=node-builder /usr/local/bin/npx /usr/local/bin/npx
COPY --from=node-builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=bun-fetcher /usr/local/bin/bun /usr/local/bin/bun
COPY --from=ttyd-fetcher /usr/local/bin/ttyd /usr/local/bin/ttyd

# Symlink globally-installed Node tooling onto PATH so the agent can
# invoke `tsc`, `prettier`, etc. without touching node_modules/.bin.
RUN ln -s /opt/node-deps/node_modules/.bin/tsc /usr/local/bin/tsc \
    && ln -s /opt/node-deps/node_modules/.bin/ts-node /usr/local/bin/ts-node \
    && ln -s /opt/node-deps/node_modules/.bin/prettier /usr/local/bin/prettier \
    && ln -s /opt/node-deps/node_modules/.bin/eslint /usr/local/bin/eslint

ENV NODE_PATH=/opt/node-deps/node_modules
ENV PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin

# Single non-root user. fsGroup on the pod spec ensures /workspace and
# PVC mounts pick up the right ownership without recursive chowns.
#
# Ubuntu 24.04 ships with a default `ubuntu` user at uid 1000 — drop it
# first (and its group) so we can claim that uid for `sandbox` cleanly.
RUN if id ubuntu >/dev/null 2>&1; then /usr/sbin/userdel -r ubuntu 2>/dev/null || true; fi \
    && if getent group ubuntu >/dev/null; then /usr/sbin/groupdel ubuntu 2>/dev/null || true; fi \
    && /usr/sbin/groupadd -g ${SANDBOX_GID} sandbox \
    && /usr/sbin/useradd -u ${SANDBOX_UID} -g ${SANDBOX_GID} -m -s /bin/bash sandbox

# Filesystem layout for the sandbox. /workspace is the PVC mount in K8s
# but we create it here too so `docker run` outside K8s also works.
# /var/run is mounted from a tmpfs `emptyDir` in K8s; we still create
# the subdirectories under /var/run/sandbox and /var/run/tmux so the
# entrypoint can recreate them at startup if running outside K8s.
RUN mkdir -p /workspace /var/run/sandbox /var/run/tmux \
    && chown -R sandbox:sandbox /workspace /var/run/sandbox /var/run/tmux

# Install the rootfs overlay (tmux.conf, entrypoint, idle daemon).
COPY rootfs/etc/tmux.conf /etc/tmux.conf
COPY rootfs/usr/local/bin/sandbox-entrypoint.sh /usr/local/bin/sandbox-entrypoint.sh
COPY rootfs/usr/local/bin/sandbox-idle-daemon /usr/local/bin/sandbox-idle-daemon
RUN chmod 0755 /usr/local/bin/sandbox-entrypoint.sh /usr/local/bin/sandbox-idle-daemon

# In-pod MCP server bundle. The supervisor auto-detects this path and
# launches `node dist/server.js` if present.
COPY --from=mcp-server-builder --chown=sandbox:sandbox \
     /opt/sandbox-mcp /opt/sandbox-mcp

WORKDIR /workspace
USER sandbox

ENV SANDBOX_RUNTIME=ubuntu-24.04
ENV ARCHESTRA_RUNTIME=sandbox

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD pgrep -x tmux >/dev/null && pgrep -x ttyd >/dev/null || exit 1

LABEL org.opencontainers.image.title="archestra-mcp-server-sandbox" \
      org.opencontainers.image.description="Ubuntu 24.04 sandbox runtime for Archestra MCP code-execution servers" \
      org.opencontainers.image.source="https://github.com/archestra-ai/archestra" \
      org.opencontainers.image.licenses="Apache-2.0" \
      archestra.ai/runtime="sandbox"

EXPOSE 7681 8080

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sandbox-entrypoint.sh"]
