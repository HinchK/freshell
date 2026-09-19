#!/usr/bin/env tsx
// Rust test-target computation for the pre-push gate: given the files a push
// changed, decide whether `cargo test` must run and for which packages —
// the changed crates plus every workspace crate that (transitively) depends
// on them. Rust-less pushes cost nothing; rust pushes run exactly what the
// change can reach. See docs/development/pre-push-gate.md.
//
// Consumed by scripts/hooks/pre-push (stdin = changed paths, one per line).
// Output on stdout:
//   skip                        — no cargo test needed
//   workspace                   — cargo test --workspace --exclude freshell-tauri --locked
//   packages <p1> <p2> ...      — cargo test --locked -p p1 -p p2 ...
export interface WorkspaceGraph {
  members: string[]
  /** pkg -> its workspace-internal dependencies */
  edges: Record<string, string[]>
}

export type RustTestPlan =
  | { mode: 'skip' }
  | { mode: 'packages'; packages: string[] }
  | { mode: 'workspace' }

// freshell-tauri is excluded from the rust gate lanes (clippy parity).
const EXCLUDED_PACKAGES = new Set(['freshell-tauri'])

function isRustRelevant(p: string): boolean {
  return (
    /\.rs$/.test(p) ||
    /(^|\/)Cargo\.toml$/.test(p) ||
    /(^|\/)Cargo\.lock$/.test(p) ||
    /^rust-toolchain/.test(p) ||
    /^\.cargo\//.test(p)
  )
}

function crateNameFor(p: string): string | null {
  const m = /^crates\/([^/]+)\//.exec(p)
  return m ? m[1] : null
}

export function computeRustTestPlan(changedPaths: string[], graph: WorkspaceGraph): RustTestPlan {
  const rustPaths = changedPaths.filter(isRustRelevant)
  if (rustPaths.length === 0) return { mode: 'skip' }

  const memberSet = new Set(graph.members)
  const changedCrates = new Set<string>()
  for (const p of rustPaths) {
    const crate = crateNameFor(p)
    if (crate === null) return { mode: 'workspace' }
    changedCrates.add(crate)
  }

  // Clippy-parity exclusion: tauri alone triggers nothing.
  const candidates = [...changedCrates].filter((c) => !EXCLUDED_PACKAGES.has(c))
  if (candidates.length === 0) return { mode: 'skip' }

  // Unknown crate directory (typo, or a new crate not yet in metadata): the
  // safe default is the whole workspace.
  if (candidates.some((c) => !memberSet.has(c))) return { mode: 'workspace' }

  // Reverse edges: dependent -> set of workspace deps it links.
  const dependents: Record<string, string[]> = {}
  for (const [pkg, deps] of Object.entries(graph.edges)) {
    if (!memberSet.has(pkg) || EXCLUDED_PACKAGES.has(pkg)) continue
    for (const dep of deps) {
      if (!memberSet.has(dep) || EXCLUDED_PACKAGES.has(dep)) continue
      ;(dependents[dep] ??= []).push(pkg)
    }
  }

  const targets = new Set<string>(candidates)
  const queue = [...candidates]
  while (queue.length > 0) {
    const cur = queue.pop() as string
    for (const dependent of dependents[cur] ?? []) {
      if (EXCLUDED_PACKAGES.has(dependent)) continue
      if (!targets.has(dependent)) {
        targets.add(dependent)
        queue.push(dependent)
      }
    }
  }

  return { mode: 'packages', packages: [...targets].sort() }
}

export function graphFromCargoMetadata(metadataJson: string): WorkspaceGraph {
  const metadata = JSON.parse(metadataJson) as {
    // workspace_members are package IDs in current cargo ("path+file://…#0.0.0");
    // older/other shapes use manifest paths — accept both.
    workspace_members: string[]
    packages: Array<{ name: string; id?: string; manifest_path: string; dependencies: Array<{ name: string }> }>
  }
  const memberIds = new Set(metadata.workspace_members)
  const members: string[] = []
  const edges: Record<string, string[]> = {}
  for (const pkg of metadata.packages) {
    const isMember = (pkg.id !== undefined && memberIds.has(pkg.id)) || memberIds.has(pkg.manifest_path)
    if (!isMember) continue
    members.push(pkg.name)
    edges[pkg.name] = pkg.dependencies.map((d) => d.name).filter((d) => d !== pkg.name)
  }
  const memberSet = new Set(members)
  for (const name of members) {
    edges[name] = edges[name].filter((d) => memberSet.has(d))
  }
  return { members, edges }
}

export function planToInvocation(plan: RustTestPlan): string {
  if (plan.mode === 'skip') return ''
  if (plan.mode === 'workspace') return 'cargo test --workspace --exclude freshell-tauri --locked'
  return `cargo test --locked${[...plan.packages].sort().map((p) => ` -p ${p}`).join('')}`
}

async function main(): Promise<number> {
  const full = process.argv.includes('--full')
  if (full) {
    console.log('workspace')
    return 0
  }
  const input = await new Promise<string>((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })
  const changedPaths = input.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)

  const { spawnSync } = await import('node:child_process')
  const metadata = spawnSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
    encoding: 'utf8',
  })
  if (metadata.status !== 0) {
    process.stderr.write(`rust-test-targets: cargo metadata failed:\n${metadata.stderr}\n`)
    return 1
  }

  const graph = graphFromCargoMetadata(metadata.stdout)
  const plan = computeRustTestPlan(changedPaths, graph)
  if (plan.mode === 'skip') {
    console.log('skip')
  } else if (plan.mode === 'workspace') {
    console.log('workspace')
  } else {
    console.log(`packages ${plan.packages.join(' ')}`)
  }
  return 0
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(await main())
}
