// FRESH-AGENT EXTRAS (AGENT-13, kata ekc6) -- PW-RUST e2e proof that the Rust
// server's fresh-agent extras routes match the Node oracle contract
// (test/server/fresh-agent-extras.test.ts as pinned by
// crates/freshell-server/src/fresh_agent_extras.rs):
//
//   1. diff (REST): GET /api/fresh-agent/diff?cwd&path — a 200 unified diff
//      (-one/+two) over the session cwd's OWN repo, the exact
//      400 `cwd does not exist: <cwd>`, and the 500 `git diff failed: …` prefix
//      on a non-repo cwd.
//   2. exec (REST): POST /api/fresh-agent/exec — stdout+stderr folded with one
//      newline, the numeric exit code passed through in a 200 (never a 500),
//      and the exact 400 `command is required`.
//
// Both tests drive the server directly (REST, no browser page — the
// freshagent-settings-resume-rust.spec.ts direct-drive precedent). Rust-only:
// registered in RUST_ONLY_SPECS + the rust-chromium project's testMatch.
//
// Donor (precedent, not copied code): the REST-with-token pattern from
// agent-checkpoint-rewind.spec.ts (:299-303).
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'

test.describe('fresh-agent extras routes (rust)', () => {
  // ── AGENT-13 (kata ekc6): GET /api/fresh-agent/diff ──────────────────────
  test('diff: 200 unified diff over the session repo, exact 400/500 error contracts', async ({ e2eServerKind }) => {
    // 6-minute timeout covers RustServer.start()'s synchronous cold
    // `cargo build --release` on the first local run (the terminal-escape-key
    // spec precedent; the cloud lane prebuilds and never compiles).
    test.setTimeout(360_000)
    expect(e2eServerKind).toBe('rust')
    // Hoisted cleanup handles: every statement after the mkdtemp runs inside
    // the try so a mid-setup throw cannot leak the tmpdir.
    let sharedRoot: string | null = null
    let server: RustServer | null = null
    try {
      sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fa-extras-diff-'))
      const repoDir = path.join(sharedRoot, 'repo')
      const plainDir = path.join(sharedRoot, 'plain')
      await fsp.mkdir(repoDir, { recursive: true })
      await fsp.mkdir(plainDir, { recursive: true })
      server = new RustServer()
      const info = await server.start()
      execFileSync('git', ['init', '-q'], { cwd: repoDir })
      await fsp.writeFile(path.join(repoDir, 'a.txt'), 'one\n')
      execFileSync('git', ['add', 'a.txt'], { cwd: repoDir })
      execFileSync(
        'git',
        ['-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'initial'],
        { cwd: repoDir },
      )
      await fsp.writeFile(path.join(repoDir, 'a.txt'), 'two\n')

      const url = `${info.baseUrl}/api/fresh-agent/diff`
      const authHeaders = { 'x-auth-token': info.token }

      // Happy path: `git diff --no-color -- a.txt` in the SESSION's own repo.
      const res = await fetch(`${url}?cwd=${encodeURIComponent(repoDir)}&path=a.txt`, {
        headers: authHeaders,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { diff?: string }
      expect(typeof body.diff).toBe('string')
      expect(body.diff, 'the diff carries the committed-old line').toContain('\n-one\n')
      expect(body.diff, 'the diff carries the working-tree-new line').toContain('\n+two\n')

      // A nonexistent cwd → the oracle's exact 400.
      const ghost = path.join(sharedRoot, 'missing')
      const badCwd = await fetch(`${url}?cwd=${encodeURIComponent(ghost)}`, { headers: authHeaders })
      expect(badCwd.status).toBe(400)
      expect(await badCwd.json()).toEqual({ error: `cwd does not exist: ${ghost}` })

      // A cwd that is not a git repo → 500 with the oracle's error prefix.
      const nonRepo = await fetch(`${url}?cwd=${encodeURIComponent(plainDir)}`, {
        headers: authHeaders,
      })
      expect(nonRepo.status).toBe(500)
      const nonRepoBody = (await nonRepo.json()) as { error?: string }
      expect(
        nonRepoBody.error?.startsWith('git diff failed: '),
        'non-repo cwd fails with the oracle `git diff failed: ` prefix',
      ).toBe(true)
    } finally {
      await server?.stop().catch(() => {})
      if (sharedRoot) await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  // ── AGENT-13 (kata ekc6): POST /api/fresh-agent/exec ─────────────────────
  test('exec: stdout+stderr fold, exit-code passthrough in a 200, exact 400 for a missing command', async ({ e2eServerKind }) => {
    // 6-minute timeout covers RustServer.start()'s synchronous cold
    // `cargo build --release` on the first local run (the terminal-escape-key
    // spec precedent; the cloud lane prebuilds and never compiles).
    test.setTimeout(360_000)
    expect(e2eServerKind).toBe('rust')
    let sharedRoot: string | null = null
    let server: RustServer | null = null
    try {
      sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fa-extras-exec-'))
      const cwd = path.join(sharedRoot, 'work')
      await fsp.mkdir(cwd, { recursive: true })
      server = new RustServer()
      const info = await server.start()
      const url = `${info.baseUrl}/api/fresh-agent/exec`
      const authJsonHeaders = { 'x-auth-token': info.token, 'content-type': 'application/json' }

      // Streams fold as `${stdout}\n${stderr}`.trim() (verbatim per stream —
      // printf emits no trailing newlines, so the combined form has no blank
      // line; echo's trailing newlines WOULD survive as a blank separator,
      // pinned by the Node oracle suite and the crate's
      // exec_folds_streams_verbatim_without_per_stream_trims). A non-zero exit
      // is a 200 with the numeric code — never a 500.
      const res = await fetch(url, {
        method: 'POST',
        headers: authJsonHeaders,
        body: JSON.stringify({ command: 'printf out; printf err 1>&2; exit 7', cwd }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ output: 'out\nerr', exitCode: 7, truncated: false })

      // Missing command → the oracle's exact 400 body.
      const missing = await fetch(url, {
        method: 'POST',
        headers: authJsonHeaders,
        body: JSON.stringify({ cwd }),
      })
      expect(missing.status).toBe(400)
      expect(await missing.json()).toEqual({ error: 'command is required' })
    } finally {
      await server?.stop().catch(() => {})
      if (sharedRoot) await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
