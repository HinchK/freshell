/**
 * One-time backfill: stamp the user's active Amplifier bundle into
 * freshell-created Amplifier session stubs whose metadata has no "bundle"
 * key, or the self-perpetuating "bundle": "unknown" the CLI persists.
 *
 * Why: freshell pre-writes session stubs without a bundle key and launches
 * panes via `amplifier resume <uuid>`; the CLI's resume path never consults
 * settings.yaml `bundle.active`, so those sessions silently run the CLI's
 * hardcoded default bundle (`anchors`) forever. Healing stamps the user's
 * configured bundle — resumed healed sessions intentionally switch from
 * that default to the configured bundle. New stubs are stamped at creation
 * (crates/freshell-sessions/src/bundle_config.rs — keep semantics + test
 * matrices mirrored with this file's resolveActiveBundle); this script
 * heals the existing corpus once.
 *
 * Run with: npx tsx scripts/amplifier-backfill-bundle.ts            # dry run (default)
 *           npx tsx scripts/amplifier-backfill-bundle.ts --apply    # write changes
 *
 * Safety (layered — the spec's original two guards were empirically shown
 * to miss live sessions: interactive CLI processes carry no session id in
 * argv, and live sessions go events-silent for 24-70+ minutes; ledger A15):
 *  - --apply REFUSES to run while ANY amplifier process is visible in ps
 *    (excluding this script's own process tree — its argv contains the
 *    script filename, which would otherwise trip the gate on itself),
 *    or when ps itself fails (deliberately over-broad: a false positive
 *    only delays the heal; dry-run is unaffected);
 *  - only sessions with "freshell_terminal_id" (freshell-created) AND
 *    bundle missing-or-"unknown" are touched;
 *  - SKIPS possibly-live sessions: a running `amplifier ... <session_id>`
 *    process, or events.jsonl modified within the last 10 minutes
 *    (defense in depth);
 *  - re-reads the file immediately before writing and skips if its bytes
 *    changed since the eligibility read;
 *  - fidelity verify (ledger A16): if re-serializing the ORIGINAL parse
 *    does not reproduce the original bytes, skip as skipped-unfaithful
 *    (JSON.stringify re-emits 5.0 as 5 and \uXXXX escapes literally);
 *  - resolution mirrors Amplifier's merged-settings precedence (later
 *    wins): ~/.amplifier/settings.yaml, <working_dir>/.amplifier/
 *    settings.yaml, <working_dir>/.amplifier/settings.local.yaml — a
 *    session is stamped ONLY with a plain non-empty string; ANY surprise
 *    (garbage YAML in an existing file, multi-document file, non-string,
 *    empty) skips it; duplicate keys resolve last-wins ({uniqueKeys:
 *    false}) to match the Rust twin and the CLI's own parser;
 *  - atomic write (temp file + rename), preserving key order + indentation.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import YAML from 'yaml'

const execFileP = promisify(execFile)

export type SessionOutcome =
  | 'ineligible'
  | 'skipped-live'
  | 'skipped-unresolved'
  | 'skipped-unfaithful'
  | 'updated'
  | 'would-update'

/** Mirror of Rust `bundle_config::resolve_active_bundle` — see file header. */
export async function resolveActiveBundle(
  globalDir: string,
  workingDir: string | undefined,
): Promise<string | null> {
  const layers = [path.join(globalDir, 'settings.yaml')]
  if (workingDir) {
    layers.push(path.join(workingDir, '.amplifier', 'settings.yaml'))
    layers.push(path.join(workingDir, '.amplifier', 'settings.local.yaml'))
  }
  let winner: string | null = null
  for (const file of layers) {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue // layer absent — normal
      return null // existing-but-unreadable — surprise, omit
    }
    let doc: unknown
    try {
      // uniqueKeys:false — duplicate keys resolve last-wins, matching both
      // the Rust twin (saphyr) and the CLI's own parser (ledger A10).
      // Multi-document files still throw here — Surprise in both twins.
      doc = YAML.parse(raw, { uniqueKeys: false })
    } catch {
      return null // unparseable YAML — surprise, omit (poisons the whole resolution)
    }
    if (doc === null || typeof doc !== 'object') continue // empty/scalar doc — no contribution
    const bundle = (doc as Record<string, unknown>).bundle
    if (bundle === null || bundle === undefined || typeof bundle !== 'object') continue
    if (!('active' in (bundle as Record<string, unknown>))) continue
    const active = (bundle as Record<string, unknown>).active
    if (typeof active !== 'string' || active.trim() === '') return null // surprise, omit
    winner = active.trim()
  }
  return winner
}

/** Best-effort JSON indent sniff so the rewrite matches the original file. */
export function detectIndent(raw: string): string | number {
  if (/\n\t"/.test(raw)) return '\t'
  const m = raw.match(/\n( +)"/)
  return m ? m[1].length : 0
}

/** --apply gate (ledger A15): ANY visible amplifier process blocks apply.
 *  Interactive/pipeline-hosted CLI sessions carry no session id in argv, so
 *  per-session matching cannot see them — refuse wholesale instead.
 *  Over-broad by design: a false positive only postpones the heal.
 *  SELF-EXCLUSION: the backfill's own process tree (node/npx/tsx running
 *  this script, and any shell wrapper quoting its invocation) has
 *  "amplifier" in argv via the script filename, so a whole-snapshot
 *  `/amplifier/` test would refuse unconditionally. ps lines mentioning
 *  the script filename are therefore ignored; every wrapper's argv
 *  (node, npx, tsx, sh -c) contains that filename. */
export function applyBlockedByLiveAmplifier(psOutput: string): boolean {
  return psOutput
    .split('\n')
    .filter((line) => !line.includes('amplifier-backfill-bundle'))
    .some((line) => /amplifier/.test(line))
}

/** A session is live if an amplifier process references its id, or its
 *  events.jsonl was written within the last 10 minutes. */
export async function sessionLooksLive(
  sessionId: string,
  sessionDir: string,
  psOutput: string,
  nowMs: number,
): Promise<boolean> {
  if (new RegExp(`amplifier.*${sessionId}`).test(psOutput)) return true
  try {
    const st = await fs.stat(path.join(sessionDir, 'events.jsonl'))
    if (nowMs - st.mtimeMs < 10 * 60_000) return true
  } catch {
    // no events.jsonl — cannot be live via recency
  }
  return false
}

export async function backfillSession(
  metaPath: string,
  opts: { globalDir: string; apply: boolean; psOutput: string; nowMs: number },
): Promise<SessionOutcome> {
  let raw: string
  try {
    raw = await fs.readFile(metaPath, 'utf8')
  } catch {
    return 'ineligible'
  }
  let meta: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'ineligible'
    meta = parsed as Record<string, unknown>
  } catch {
    return 'ineligible' // unparseable metadata — never touch
  }
  if (typeof meta.freshell_terminal_id !== 'string') return 'ineligible' // not freshell-created
  if (meta.bundle !== undefined && meta.bundle !== 'unknown') return 'ineligible'

  const sessionDir = path.dirname(metaPath)
  const sessionId = path.basename(sessionDir)
  if (await sessionLooksLive(sessionId, sessionDir, opts.psOutput, opts.nowMs)) {
    return 'skipped-live'
  }

  const workingDir = typeof meta.working_dir === 'string' ? meta.working_dir : undefined
  const bundle = await resolveActiveBundle(opts.globalDir, workingDir)
  if (bundle === null) return 'skipped-unresolved'

  // Fidelity verify (ledger A16): only touch files whose exact bytes we can
  // reproduce — re-serializing the ORIGINAL parse must equal the original
  // raw (JSON.stringify re-emits 5.0 as 5 and \uXXXX escapes literally).
  const indent = detectIndent(raw)
  const trailer = raw.endsWith('\n') ? '\n' : ''
  if (JSON.stringify(JSON.parse(raw), null, indent) + trailer !== raw) {
    return 'skipped-unfaithful'
  }

  meta.bundle = bundle // JS objects keep insertion order — an existing "unknown" keeps its slot
  const out = JSON.stringify(meta, null, indent) + trailer
  if (!opts.apply) return 'would-update'
  // Last-moment race check (ledger A15): re-read and compare — if the CLI
  // (or anything else) wrote the file since our eligibility read, treat it
  // as live and leave it alone.
  const recheck = await fs.readFile(metaPath, 'utf8').catch(() => null)
  if (recheck !== raw) return 'skipped-live'
  const tmp = path.join(sessionDir, `.metadata.json.backfill-${process.pid}.tmp`)
  await fs.writeFile(tmp, out)
  await fs.rename(tmp, metaPath) // atomic on the same filesystem
  return 'updated'
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const apply = argv.includes('--apply')
  const unknown = argv.filter((a) => !['--apply', '--dry-run'].includes(a))
  if (unknown.length > 0) {
    console.error(
      'Usage: npx tsx scripts/amplifier-backfill-bundle.ts [--dry-run (default) | --apply]',
    )
    process.exit(1)
  }

  const globalDir = path.join(os.homedir(), '.amplifier')
  const projectsDir = path.join(globalDir, 'projects')

  let psOutput = ''
  let psFailed = false
  try {
    psOutput = (await execFileP('ps', ['-eo', 'args='])).stdout
  } catch {
    psFailed = true
    console.error('WARNING: ps failed; process-based live detection disabled for this run.')
  }
  // ledger A15: per-session process matching cannot see interactive CLI
  // sessions (no session id in argv) — refuse to APPLY while any amplifier
  // process exists (or when we cannot even check). Dry-run proceeds.
  if (apply && (psFailed || applyBlockedByLiveAmplifier(psOutput))) {
    console.error(
      'REFUSING --apply: amplifier process(es) visible in ps (or ps failed).' +
        ' Close all amplifier sessions, then re-run. Dry-run works anytime.',
    )
    process.exit(2)
  }
  const nowMs = Date.now()

  const counts = {
    scanned: 0,
    eligible: 0,
    skippedLive: 0,
    skippedUnresolved: 0,
    skippedUnfaithful: 0,
    updated: 0,
  }
  let projects: string[] = []
  try {
    projects = await fs.readdir(projectsDir)
  } catch {
    console.log(`No projects dir at ${projectsDir} — nothing to do.`)
  }
  for (const project of projects) {
    const sessionsDir = path.join(projectsDir, project, 'sessions')
    let sessions: string[] = []
    try {
      sessions = await fs.readdir(sessionsDir)
    } catch {
      continue
    }
    for (const session of sessions) {
      const metaPath = path.join(sessionsDir, session, 'metadata.json')
      try {
        await fs.access(metaPath)
      } catch {
        continue
      }
      counts.scanned += 1
      const outcome = await backfillSession(metaPath, { globalDir, apply, psOutput, nowMs })
      if (outcome === 'ineligible') continue
      counts.eligible += 1
      if (outcome === 'skipped-live') counts.skippedLive += 1
      else if (outcome === 'skipped-unresolved') counts.skippedUnresolved += 1
      else if (outcome === 'skipped-unfaithful') counts.skippedUnfaithful += 1
      else {
        counts.updated += 1
        console.log(`${apply ? 'updated' : 'would update'}: ${metaPath}`)
      }
    }
  }

  console.log(
    `${apply ? 'APPLY' : 'DRY RUN'} summary: scanned=${counts.scanned}` +
      ` eligible=${counts.eligible} skipped-live=${counts.skippedLive}` +
      ` skipped-unresolved=${counts.skippedUnresolved}` +
      ` skipped-unfaithful=${counts.skippedUnfaithful} updated=${counts.updated}`,
  )
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
