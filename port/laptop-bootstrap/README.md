# Laptop bootstrap — freshell rust/tauri port

Purpose: take a clean Windows machine (no WSL, no toolchain, no legacy freshell —
exactly the profile `port/HANDOFF.md` targets) to "agent can continue the port
locally" in two steps + reboot.

## Order of operations

1. **`1-install-wsl.cmd`** (double-click, approve admin, reboot). Installs WSL2 +
   Ubuntu. On first Ubuntu launch, create your Linux user.
2. **`2-bootstrap-wsl.sh`** (inside Ubuntu):
   `bash /mnt/c/Users/Public/freshell-bootstrap/2-bootstrap-wsl.sh`
   Idempotent. Installs apt toolchain (incl. mingw-w64 cross-compiler, Tauri GUI
   deps, imagemagick/tesseract/xdotool), rustup + `x86_64-pc-windows-gnu`, node 22,
   clones the repo at **`feat/rust-tauri-port`** (NOT main — the port and all its
   docs live on that branch), installs JS deps + Playwright chromium, and
   builds the original reference + both Rust server binaries.

   The JS dependency, browser, and build steps follow the **checked-out
   branch's package manager**: the default port branch is npm-era (`npm ci` +
   a separate sidecar `npm install`), while a pnpm-era checkout (current
   `main`) bootstraps the pinned pnpm via npm (`npm install -g pnpm@10.34.5`)
   and runs a frozen workspace install (`pnpm install --frozen-lockfile`)
   that covers the sidecar as a workspace member. Either way, the coding CLIs
   stay separate global npm installs (step 7 of the script).

## What only a human can do (the agent cannot)

- Approve the WSL install + reboot (step 1).
- **Credentials**: `claude` / `codex login` / `opencode auth login` (one-time each);
  git push access (`gh auth login` or PAT); the agent runtime's own model keys.
- Everything else is automated or agent-doable per `port/HANDOFF.md` §3.

## Then

Point the agent at `port/HANDOFF.md` and `port/GOAL.md` in the cloned repo. Key
rules it will follow: test ports **17870–17899 only** (never 3000–3010), source
purity (`server/`, `shared/`, `src/` byte-pristine), differential QA against the
real running original.
