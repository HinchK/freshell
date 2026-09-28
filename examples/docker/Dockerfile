# Minimal image demonstrating Freshell's Rust server and static client.
#
# Build:  docker build -t freshell-docker-test -f examples/docker/Dockerfile .
# Run:    docker run --rm -e AUTH_TOKEN=<at-least-16-characters> -p 3001:3001 freshell-docker-test
# Open:   http://localhost:3001/
#
# The example image intentionally contains no application Node dependency tree.
# Node is not the backend process; the final image starts the native server.

# ---------------------------------------------------------------------------
# Stage 1: compile the native backend.
# ---------------------------------------------------------------------------
FROM rust:1-bookworm AS rust-builder

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
COPY extensions/ ./extensions/
RUN cargo build --release -p freshell-server --locked

# ---------------------------------------------------------------------------
# Stage 2: build the browser client with the retained JavaScript toolchain.
# ---------------------------------------------------------------------------
FROM node:24-slim AS client-builder

WORKDIR /app
# Workspace member manifests must precede the frozen install: pnpm resolves
# every importer listed in pnpm-workspace.yaml before touching the lock. Each
# member manifest needs its destination directory spelled out — a multi-file
# COPY into ./ flattens file sources by basename, which would overwrite the
# root package.json with the member's manifest.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY crates/freshell-claude-sidecar/package.json crates/freshell-claude-sidecar/
COPY packages/freshell-mcp-runtime/package.json packages/freshell-mcp-runtime/

# npm appears only as the pinned pnpm bootstrap; dependency installation is
# pnpm against the workspace lock. --ignore-scripts preserves this example
# stage's intentional script-free install (the npm-era stage ran
# `npm ci --ignore-scripts`).
RUN npm install -g pnpm@10.34.5 \
  && pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm run build:client

# ---------------------------------------------------------------------------
# Stage 3: only the Rust executable and static client are shipped.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=rust-builder /build/target/release/freshell-server /app/freshell-server
COPY --from=client-builder /app/dist/client /app/dist/client

ENV PORT=3001 \
    FRESHELL_BIND_HOST=0.0.0.0
EXPOSE 3001

CMD ["/app/freshell-server"]
