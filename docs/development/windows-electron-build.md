# Building the Windows Electron App

This documents how to produce the Windows desktop installer
(`release/Freshell Setup <version>.exe`). The desktop app has one app-bound
backend: the native Rust `freshell-server` executable. Node is packaged only
for the standalone MCP client and the isolated Claude SDK sidecar.

## Key constraint: build on native Windows

The Windows build must run as a native Windows process. `pnpm run
electron:build:win` begins with `scripts/assert-native-windows-build.ts`, which
hard-fails unless `process.platform === 'win32'`. This ensures Cargo produces a
native `freshell-server.exe` and Electron Builder packages the Windows
artifact, rather than a Linux binary or a non-runnable installer stub.

## Prerequisites (on the Windows side)

- Node.js (matching `engines.node`, currently `>=22.5.0`) and the pinned
  pnpm 10.34.5 for the client, tooling, and Electron build. Bootstrap pnpm
  once with `npm install --global pnpm@10.34.5` — npm is only the bootstrap
  tool here. The repo's `packageManager` pin is enforced; any other pnpm
  version fails the frozen install.
- A Rust stable toolchain with the MSVC target (`rustup`, Cargo, and the
  Visual Studio Build Tools **Desktop development with C++** workload).
- No Node native-module compiler or Python setup is required for the
  app-bound backend. The Rust server owns PTY support.

## Option A — from a native Windows shell

```powershell
pnpm install --frozen-lockfile
$env:CI = "true"
pnpm run electron:build:win        # assert win32 → client/tools/Rust → Electron Builder NSIS
```

`electron:build:win` runs, in order: the native-platform assertion, client and
tool typechecks/builds, the release `freshell-server.exe` Cargo build,
`build:electron`, `build:wizard`, `build:launch-chooser`,
`prepare:claude-sidecar`, `prepare:electron-runtime`, `electron-builder --win
nsis --publish never`, and the artifact verifier. `prepare:claude-sidecar`
verifies the sidecar workspace member's installed dependency tree and, if it
is missing or stale, repairs it with one frozen, sidecar-filtered pnpm
install; `prepare:electron-runtime` stages the portable sidecar and MCP client
runtimes from pnpm deploys of the workspace lock. No sidecar `node_modules`
directory needs to be checked into the repository. Output lands
in `release/`.

## Option B — driving the Windows build from WSL

Your dev checkout usually lives on the WSL filesystem, but the build must run
as a native Windows process. **Do not** build over the `\\wsl.localhost\...`
UNC path (slow and fragile over 9p). Copy the worktree to a Windows-local path
and run Windows' own pnpm and Cargo against it via interop (bootstrap pnpm on
the Windows side with `npm install --global pnpm@10.34.5`).

1. Copy the worktree to a Windows-local directory, excluding generated and
   platform-specific directories:

   ```bash
   rsync -rlt --delete --no-perms --no-owner --no-group \
     --exclude='.git' --exclude='node_modules/' --exclude='dist/' \
     --exclude='target/' --exclude='release/' --exclude='electron-runtime/' \
     --exclude='packages/freshell-mcp-runtime/generated/' \
     --exclude='.worktrees/' \
     ./ "/mnt/c/Users/<you>/AppData/Local/Temp/freshell-electron-build/"
   ```

   `target/` and `.worktrees/` matter when copying from the **main checkout**:
   it holds multi-GB Rust build artifacts and every sibling worktree, and
   copying those over 9p stalls the sync indefinitely. They are harmless to
   exclude when copying from a linked worktree. `node_modules/` excludes every
   dependency layout at any depth — the pnpm root tree and its virtual store
   plus the workspace members' own `node_modules` — and
   `packages/freshell-mcp-runtime/generated/` is staged build output that the
   Windows-side run regenerates. The pnpm workspace config and lockfiles
   (`pnpm-workspace.yaml`, `pnpm-lock.yaml`) are tracked files and get copied,
   which is what the frozen install on the Windows side needs.

2. Run Windows pnpm in that directory via `cmd.exe`. Always `cd /d` to a real
   Windows path first — `cmd.exe` launched from WSL inherits the UNC cwd and
   will warn and mangle relative paths:

   ```bash
   cmd.exe /c 'cd /d C:\Users\<you>\AppData\Local\Temp\freshell-electron-build && set "CI=true" && set "PORT=39517" && pnpm install --frozen-lockfile && pnpm run electron:build:win'
   ```

   `PORT=<unused>` keeps the build's preflight isolated from any unrelated
   local service. The package build verifies (and if needed frozen-installs)
   the isolated Claude sidecar as part of the command. Reusing a
   previous Windows-local build directory keeps its native dependencies warm,
   while `target/`, `dist/`, and `electron-runtime/` are rebuilt for the copied
   checkout.

3. To move artifacts off `/mnt/c`, prefer WSL `cp` over `cmd copy` — `cmd`'s
   quote/path handling through interop is unreliable for paths with spaces.

## What you get

`config/electron-builder.yml` targets **`nsis`** for Windows: a one-click,
per-user installer (`oneClick: true`, `perMachine: false`).

- `release/Freshell Setup <version>.exe` — the installer. Running it installs
  to `%LOCALAPPDATA%\Programs\Freshell\Freshell.exe` and launches the app
  when `runAfterFinish` is enabled.
- `release/win-unpacked/Freshell.exe` — the app executable itself; run it
  directly to launch without installing.

The installer is **unsigned** unless a code-signing certificate is configured,
so Windows SmartScreen may warn on first run.

## Sanity-check a build

A good build should show:

- `release/Freshell Setup <version>.exe` is a full-size installer, not a small
  stub.
- `release/win-unpacked/resources/bin/freshell-server.exe` exists and is the
  app-bound backend.
- `release/win-unpacked/resources/client/index.html` exists.
- `release/win-unpacked/resources/node/bin/node.exe` exists only for the
  packaged MCP client and Claude sidecar.
- The packaged resources contain no legacy backend directory or compiled
  legacy backend artifact, and no backend-specific native Node addon is
  packaged.

The authoritative checkout-free checks are `pnpm run verify:electron-artifact`
and `pnpm run test:electron:runtime`.
