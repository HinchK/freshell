# Testing Skill for Claude Code Session Organizer

> **Quick Start:** Run `pnpm run test:status` first if you need to see whether a broad repo-supported test run is already active.

## Test Commands

| Command | Purpose |
|---------|---------|
| `pnpm run typecheck:client` | Cheap client-only compile gate; safe while prod is live |
| `pnpm run test` | Coordinated full suite: client Vitest, Rust source-runtime smoke, Cargo tests, and Electron tests |
| `pnpm run test:all` | Alias for the same coordinated full suite |
| `pnpm run check` | Typecheck, then the coordinated full suite |
| `pnpm run verify` | Run `build`, then the coordinated full suite |
| `pnpm run test:unit` | Exact default-config `test/unit` workload |
| `pnpm run test:client` | Exact default-config `test/unit/client` workload |
| `pnpm run test:integration` | Exact Rust workspace integration-test workload |
| `pnpm run test:server` | Cargo-backed Rust `freshell-server` tests; only coordinates explicit broad `--run` |
| `pnpm run test:coverage` | Exact default-config `vitest run --coverage` workload |
| `pnpm run test:status` | Show the current holder, latest results, and any matching advisory baseline |
| `pnpm run test:vitest run <paths...> --config <config>` | Repo-owned direct Vitest path for focused passthrough work |

pnpm forwards arguments after the script name directly, so none of the
examples above use npm's `--` separator. The coordinator still tolerates an
old npm-style leading `--` if one slips through; prefer the separator-free
spelling in all new invocations.

## Coordination Rules

- Broad repo-supported runs wait instead of failing fast when another coordinated run is active.
- `test:unit` is the exact default-config `test/unit` workload.
- `test:integration` runs the Rust workspace integration tests.
- `test:server` runs the Cargo-backed Rust `freshell-server` crate. Zero-argument and explicit broad `--run` invocations are coordinated; narrowed Cargo selectors are delegated.
- prior successful baselines are advisory only. They never short-circuit an explicitly requested run.
- use `pnpm run test:vitest run <paths...> --config <config>` if you need a repo-owned direct Vitest escape hatch. Raw `pnpm exec vitest` / `npx vitest` is not a supported coordinated path.

## Practical Workflow

1. Run `pnpm run test:status` if you need to know whether another agent is already holding the coordinated gate.
2. Set `FRESHELL_TEST_SUMMARY="why this run matters"` before broad runs so holder/status output is readable.
3. Use `pnpm run typecheck:client` when you only need the cheap frontend compile gate.
4. Use the narrowest truthful public command you can.
5. If another holder is active, wait rather than killing a foreign process.

When production is live from the main checkout, the prebuild guard fails closed
before any artifact writes for `pnpm run test` (through its source-runtime phase),
`pnpm run check`, `pnpm run test:source-runtime`, `pnpm run build`, and
`pnpm run verify`. Use `pnpm run typecheck:client` for a no-write check, or run
source-runtime/build verification from a linked worktree such as
`.worktrees/<branch>`. `pnpm run dev` and `pnpm run dev:server` create a secure
first-run `.env` token and prepare the locked Claude sidecar (repairing it with
one frozen pnpm install if stale) before starting the Rust server.

## Focused Examples

```bash
pnpm run typecheck:client
FRESHELL_TEST_SUMMARY="Verify coordinated full suite" pnpm run test
pnpm run test:server --help
pnpm run test:server --run
pnpm run test:unit test/unit/client/store/tabsPersistence.test.ts
pnpm run test:vitest run test/unit/tooling/run-standard-tests.test.ts --config config/vitest/vitest.config.ts
pnpm run test:source-runtime test/integration/tooling/source-runtime-rust.test.ts
```
