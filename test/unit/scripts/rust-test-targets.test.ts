// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  computeRustTestPlan,
  graphFromCargoMetadata,
  planToInvocation,
  type WorkspaceGraph,
} from '../../../scripts/hooks/rust-test-targets.js'
import { resolveOwningTsx } from '@test/helpers/tsx-stub-resolution'

// Workspace fixture mirroring the real dependency directions:
// server -> {ws, terminal, sessions, freshagent, protocol}
// freshagent -> {ws, terminal, protocol}
// ws -> {protocol}
// tauri -> {server}
const graph: WorkspaceGraph = {
  members: [
    'freshell-server',
    'freshell-ws',
    'freshell-terminal',
    'freshell-sessions',
    'freshell-freshagent',
    'freshell-protocol',
    'freshell-tauri',
  ],
  edges: {
    'freshell-server': ['freshell-ws', 'freshell-terminal', 'freshell-sessions', 'freshell-freshagent', 'freshell-protocol'],
    'freshell-freshagent': ['freshell-ws', 'freshell-terminal', 'freshell-protocol'],
    'freshell-ws': ['freshell-protocol'],
    'freshell-terminal': [],
    'freshell-sessions': [],
    'freshell-protocol': [],
    'freshell-tauri': ['freshell-server'],
  },
}

describe('computeRustTestPlan', () => {
  it('skips when nothing changed', () => {
    expect(computeRustTestPlan([], graph)).toEqual({ mode: 'skip' })
  })

  it('skips for client-only and docs-only changes', () => {
    expect(computeRustTestPlan(['src/components/App.tsx', 'docs/index.html'], graph)).toEqual({ mode: 'skip' })
    expect(computeRustTestPlan(['README.md'], graph)).toEqual({ mode: 'skip' })
  })

  it('tests a changed crate plus its transitive workspace dependents', () => {
    expect(computeRustTestPlan(['crates/freshell-ws/src/lib.rs'], graph)).toEqual({
      mode: 'packages',
      packages: ['freshell-freshagent', 'freshell-server', 'freshell-ws'],
    })
  })

  it('tests only the changed crate when nothing depends on it', () => {
    expect(computeRustTestPlan(['crates/freshell-server/src/main.rs'], graph)).toEqual({
      mode: 'packages',
      packages: ['freshell-server'],
    })
  })

  it('closes transitively across the whole chain', () => {
    expect(computeRustTestPlan(['crates/freshell-protocol/src/lib.rs'], graph)).toEqual({
      mode: 'packages',
      packages: ['freshell-freshagent', 'freshell-protocol', 'freshell-server', 'freshell-ws'],
    })
  })

  it('ignores client files mixed into a rust push', () => {
    expect(computeRustTestPlan(['src/lib/api.ts', 'crates/freshell-terminal/src/x.rs'], graph)).toEqual({
      mode: 'packages',
      packages: ['freshell-freshagent', 'freshell-server', 'freshell-terminal'],
    })
  })

  it('excludes freshell-tauri per clippy parity, alone and mixed', () => {
    expect(computeRustTestPlan(['crates/freshell-tauri/src/main.rs'], graph)).toEqual({ mode: 'skip' })
    expect(
      computeRustTestPlan(['crates/freshell-tauri/src/main.rs', 'crates/freshell-ws/src/lib.rs'], graph),
    ).toEqual({ mode: 'packages', packages: ['freshell-freshagent', 'freshell-server', 'freshell-ws'] })
  })

  it('falls back to the whole workspace for unknown crate directories', () => {
    expect(computeRustTestPlan(['crates/freshell-newthing/src/lib.rs'], graph)).toEqual({ mode: 'workspace' })
  })

  it('treats root-level rust files as workspace-wide', () => {
    for (const p of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'rust-toolchain', '.cargo/config.toml']) {
      expect(computeRustTestPlan([p], graph)).toEqual({ mode: 'workspace' })
    }
  })

  it('treats rust files outside crates/ as workspace-wide', () => {
    expect(computeRustTestPlan(['tools/foo.rs'], graph)).toEqual({ mode: 'workspace' })
  })

  it('treats test fixtures consumed by rust tests as workspace-wide', () => {
    expect(
      computeRustTestPlan(['test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs'], graph),
    ).toEqual({ mode: 'workspace' })
  })

  it('widens to the workspace when a fixture change mixes with a crate change', () => {
    expect(
      computeRustTestPlan(['test/fixtures/x.mjs', 'crates/freshell-terminal/src/x.rs'], graph),
    ).toEqual({ mode: 'workspace' })
  })

  it('treats crate-local manifests as crate changes', () => {
    expect(computeRustTestPlan(['crates/freshell-ws/Cargo.toml'], graph)).toEqual({
      mode: 'packages',
      packages: ['freshell-freshagent', 'freshell-server', 'freshell-ws'],
    })
  })
})

describe('graphFromCargoMetadata', () => {
  it('builds members and workspace-internal edges from real cargo package-ID metadata', () => {
    const metadata = {
      workspace_members: [
        'path+file:///repo/crates/freshell-server/Cargo.toml#0.7.5',
        'path+file:///repo/crates/freshell-ws/Cargo.toml#0.7.5',
        'path+file:///repo/crates/freshell-protocol/Cargo.toml#0.7.5',
      ],
      packages: [
        {
          name: 'freshell-server',
          id: 'path+file:///repo/crates/freshell-server/Cargo.toml#0.7.5',
          manifest_path: '/repo/crates/freshell-server/Cargo.toml',
          dependencies: [{ name: 'freshell-ws' }, { name: 'serde' }, { name: 'freshell-protocol' }],
        },
        {
          name: 'freshell-ws',
          id: 'path+file:///repo/crates/freshell-ws/Cargo.toml#0.7.5',
          manifest_path: '/repo/crates/freshell-ws/Cargo.toml',
          dependencies: [{ name: 'freshell-protocol' }, { name: 'tokio' }],
        },
        {
          name: 'freshell-protocol',
          id: 'path+file:///repo/crates/freshell-protocol/Cargo.toml#0.7.5',
          manifest_path: '/repo/crates/freshell-protocol/Cargo.toml',
          dependencies: [],
        },
      ],
    }
    const built = graphFromCargoMetadata(JSON.stringify(metadata))
    expect(built.members.sort()).toEqual(['freshell-protocol', 'freshell-server', 'freshell-ws'])
    expect(built.edges['freshell-server'].sort()).toEqual(['freshell-protocol', 'freshell-ws'])
    expect(built.edges['freshell-ws']).toEqual(['freshell-protocol'])
  })

  it('still resolves when workspace_members are manifest paths', () => {
    const metadata = {
      workspace_members: ['/repo/crates/freshell-ws/Cargo.toml'],
      packages: [
        {
          name: 'freshell-ws',
          manifest_path: '/repo/crates/freshell-ws/Cargo.toml',
          dependencies: [],
        },
      ],
    }
    expect(graphFromCargoMetadata(JSON.stringify(metadata)).members).toEqual(['freshell-ws'])
  })

  it('ignores packages that are not workspace members', () => {
    const metadata = {
      workspace_members: ['path+file:///repo/crates/freshell-ws/Cargo.toml#0.7.5'],
      packages: [
        {
          name: 'freshell-ws',
          id: 'path+file:///repo/crates/freshell-ws/Cargo.toml#0.7.5',
          manifest_path: '/repo/crates/freshell-ws/Cargo.toml',
          dependencies: [{ name: 'some-external-dep' }],
        },
        {
          name: 'non-member',
          id: 'path+file:///repo/other/Cargo.toml#1.0.0',
          manifest_path: '/repo/other/Cargo.toml',
          dependencies: [],
        },
      ],
    }
    const built = graphFromCargoMetadata(JSON.stringify(metadata))
    expect(built.members).toEqual(['freshell-ws'])
    expect(built.edges['freshell-ws']).toEqual([])
  })
})

describe('planToInvocation', () => {
  it('renders skip as an empty invocation', () => {
    expect(planToInvocation({ mode: 'skip' })).toBe('')
  })

  it('renders workspace as a full workspace test with the tauri exclusion', () => {
    expect(planToInvocation({ mode: 'workspace' })).toBe(
      'cargo test --workspace --exclude freshell-tauri --locked',
    )
  })

  it('renders a targeted package invocation in deterministic order', () => {
    expect(
      planToInvocation({ mode: 'packages', packages: ['freshell-ws', 'freshell-server'] }),
    ).toBe('cargo test --locked -p freshell-server -p freshell-ws')
  })
})

describe('pre-push hook routing (hermetic fixture repo)', () => {
  const hookPath = path.resolve(import.meta.dirname, '../../../scripts/hooks/pre-push')

  // The hook resolves tsx from cwd, the script dir, or the owning checkout.
  // A fresh worktree has no node_modules, so pin the real tsx from the
  // owning checkout and stub it into the fixture repo — the hermetic tests
  // then exercise the hook's full chain regardless of the worktree's
  // install state (the hook passes the real rust-test-targets.ts path as
  // the script argument, so the stub only supplies the runtime).
  // The stub MUST embed an ABSOLUTE tsx path: the cloud test image ships
  // no .git metadata, so plain git common-dir resolution yields a relative
  // path there — and a relative stub exec's ITSELF inside the fixture repo
  // in an infinite /bin/sh exec loop that freezes the worker (spawnSync
  // blocks the event loop, so no vitest timeout ever fires). resolveOwningTsx
  // falls back to a package.json walk-up in gitless checkouts, so the stub
  // path is absolute in every environment (see
  // test/unit/scripts/tsx-stub-resolution.test.ts).
  const realTsx = resolveOwningTsx(import.meta.dirname)

  let fixtureRoot: string
  let baseSha: string
  let rustSha: string
  let docsSha: string
  let tauriSha: string
  let fixtureSha: string
  let cargoConfigSha: string

  function git(args: string[], opts: { cwd: string; stdin?: string } = { cwd: '' }): string {
    const res = spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' })
    if (res.status !== 0 || res.error) {
      const detail = res.error
        ? `${res.error.message}${res.error.code === 'ETIMEDOUT' ? ' (timed out after 10s)' : ''}`
        : res.stderr
      throw new Error(`git ${args.join(' ')} failed: ${detail}`)
    }
    return (res.stdout ?? '').trim()
  }

  function writeFixture(p: string, contents: string): void {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, contents)
  }

  function pkg(name: string, deps: string[]): string {
    const depLines = deps.map((d) => `  ${d} = { path = "../${d}" }`).join('\n')
    return [
      '[package]',
      `name = "${name}"`,
      'version = "0.0.0"',
      'edition = "2021"',
      depLines.length > 0 ? `[dependencies]\n${depLines}` : '',
      '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  beforeAll(() => {
    if (!fs.existsSync(realTsx)) throw new Error(`owning checkout tsx missing: ${realTsx}`)
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-routing-'))
    const stubDir = path.join(fixtureRoot, 'node_modules/.bin')
    fs.mkdirSync(stubDir, { recursive: true })
    fs.writeFileSync(path.join(stubDir, 'tsx'), `#!/bin/sh\nexec "${realTsx}" "$@"\n`)
    fs.chmodSync(path.join(stubDir, 'tsx'), 0o755)
    git(['init', '-q', '-b', 'main'], { cwd: fixtureRoot })
    writeFixture(
      path.join(fixtureRoot, 'Cargo.toml'),
      [
        '[workspace]',
        'members = [',
        '  "crates/freshell-protocol",',
        '  "crates/freshell-ws",',
        '  "crates/freshell-freshagent",',
        '  "crates/freshell-server",',
        '  "crates/freshell-tauri",',
        ']',
        'resolver = "2"',
        '',
      ].join('\n'),
    )
    const fixtureDeps: Record<string, string[]> = {
      'freshell-protocol': [],
      'freshell-ws': ['freshell-protocol'],
      'freshell-freshagent': ['freshell-ws'],
      'freshell-server': ['freshell-ws', 'freshell-freshagent'],
      'freshell-tauri': ['freshell-server'],
    }
    for (const [name, deps] of Object.entries(fixtureDeps)) {
      writeFixture(path.join(fixtureRoot, `crates/${name}/Cargo.toml`), pkg(name, deps))
      writeFixture(path.join(fixtureRoot, `crates/${name}/src/lib.rs`), '')
    }
    const commit = (msg: string): string => {
      git(['add', '-A'], { cwd: fixtureRoot })
      git(
        ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg],
        { cwd: fixtureRoot },
      )
      return git(['rev-parse', 'HEAD'], { cwd: fixtureRoot })
    }
    baseSha = commit('base: fixture workspace')

    writeFixture(path.join(fixtureRoot, 'crates/freshell-ws/src/lib.rs'), '// ws change\n')
    rustSha = commit('rust: freshell-ws src change')

    writeFixture(path.join(fixtureRoot, 'README.md'), 'docs only\n')
    docsSha = commit('docs: readme')

    writeFixture(path.join(fixtureRoot, 'crates/freshell-tauri/src/main.rs'), 'fn main() {}\n')
    tauriSha = commit('rust: tauri-only change')

    writeFixture(
      path.join(fixtureRoot, 'test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs'),
      '// fixture change\n',
    )
    fixtureSha = commit('test fixture change')

    writeFixture(path.join(fixtureRoot, '.cargo/config.toml'), '[build]\n')
    cargoConfigSha = commit('cargo config change')
  })

  afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  })

  function runHook(
    localSha: string,
    remoteSha: string,
    extraEnv: Record<string, string> = {},
  ): { status: number; stderr: string } {
    const res = spawnSync('bash', [hookPath], {
      input: `refs/heads/x ${localSha} refs/heads/x ${remoteSha}\n`,
      env: { ...process.env, ...extraEnv, FRESHELL_PREPUSH_DEBUG: '1' },
      encoding: 'utf8',
      cwd: fixtureRoot,
      // A hung hook (e.g. a stub exec-loop) blocks the event loop, so no
      // vitest timeout can fire — this spawn timeout is the ONLY guard.
      // Generous for real hook debug-mode runs; ETIMEDOUT surfaces below.
      timeout: 120_000,
      killSignal: 'SIGKILL',
    })
    let stderr = res.stderr ?? ''
    if (res.error) {
      const timedOut = res.error.code === 'ETIMEDOUT'
      stderr += `\nrunHook spawn failed: ${res.error.message}${
        timedOut ? ' — hook invocation timed out after 120s (hook or tsx stub hung?)' : ''
      }`
    }
    return { status: res.status ?? -1, stderr }
  }

  it('skips all checks for a docs-only range', () => {
    const out = runHook(docsSha, rustSha)
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('full_gate=0 run_rust=0 run_ts=0 test_mode=skip')
  })

  it('plans targeted cargo tests for a changed crate plus its dependents', () => {
    const out = runHook(rustSha, baseSha)
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('run_rust=1')
    expect(out.stderr).toContain('test_mode=packages test_pkgs=freshell-freshagent freshell-server freshell-ws')
  })

  it('strips git hook env overrides (GIT_DIR et al) before any lane runs', () => {
    // git exports GIT_DIR/GIT_PREFIX into real pre-push invocations (the
    // pushing worktree's gitdir). Unstripped, a bogus or stale GIT_DIR breaks
    // the hook's own routing git calls — and in non-debug mode the leaked
    // vars redirect every test-side git child at the SHARED repository
    // (observed: cargo-test children re-initialized the main checkout's
    // config). The hook must resolve everything via cwd discovery instead.
    const out = runHook(rustSha, baseSha, { GIT_DIR: '/nonexistent-prepush-hook-env' })
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('test_mode=packages test_pkgs=freshell-freshagent freshell-server freshell-ws')
  })

  it('skips the test lane for tauri-only changes (clippy parity)', () => {
    const out = runHook(tauriSha, docsSha)
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('run_rust=1')
    expect(out.stderr).toContain('test_mode=skip')
  })

  it('runs the workspace test lane for test-fixture changes', () => {
    const out = runHook(fixtureSha, tauriSha)
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('run_rust=1')
    expect(out.stderr).toContain('test_mode=workspace')
  })

  it('runs the rust gate for cargo-config changes', () => {
    const out = runHook(cargoConfigSha, fixtureSha)
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('run_rust=1')
    expect(out.stderr).toContain('test_mode=workspace')
  })

  it('runs the full gate when the merge base is unknown', () => {
    const out = runHook('0000000000000000000000000000000000000001', '0000000000000000000000000000000000000002')
    expect(out.status).toBe(0)
    expect(out.stderr).toContain('full_gate=1 run_rust=1 run_ts=1')
    expect(out.stderr).toContain('test_mode=workspace')
  })
})
