import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import chokidar from 'chokidar'
import { CodingCliSessionIndexer } from '../../../../server/coding-cli/session-indexer'
import { configStore } from '../../../../server/config-store'
import { clearRepoRootCache } from '../../../../server/coding-cli/utils'
import { claudeProvider } from '../../../../server/coding-cli/providers/claude'
import { codexProvider } from '../../../../server/coding-cli/providers/codex'
import { amplifierProvider } from '../../../../server/coding-cli/providers/amplifier'

/**
 * SESSION-16 — legacy CONTROL for "tolerate malformed and partially written provider
 * data". This file pins the FROZEN parity source's observable behavior against the same
 * corpus classes the Rust characterization pins
 * (`crates/freshell-sessions/tests/malformed_data_quarantine.rs`) assert on the Rust
 * port, so both sides point at one shared contract:
 *
 *  - healthy records stay indexed beside quarantined siblings (empty / all-malformed /
 *    cwd-invisible / truncated-without-a-complete-line), for claude + codex + amplifier
 *    (the opencode db-level semantics are already pinned by
 *    `session-indexer-provider-refresh.test.ts`
 *    "preserves cached direct-provider sessions … when listSessionsDirect throws" and
 *    `opencode-listing-query.test.ts`, cited here, not duplicated);
 *  - truncated-with-VALID-prefix is NOT quarantined (the parseable prefix is indexed);
 *  - invalid-UTF-8 is NOT quarantined (Node's utf8 read is lossy — the record is
 *    indexed with U+FFFD replacements);
 *  - a partially-written record becomes indexed once a completing write lands, WITHOUT
 *    a restart (driven through the REAL watcher-event → dirty-file → incremental-refresh
 *    path, not merely a forced full rescan).
 *
 * Provider objects are the REAL provider modules with only `homeDir` repointed at the
 * isolated temp home (the providers read `this.homeDir` inside every method, so the
 * spread override re-routes discovery AND parsing with zero behavior edits — the same
 * seam `session-indexer.test.ts`'s `makeProvider` documents for its defaults).
 */

vi.mock('chokidar', async () => {
  const { EventEmitter } = await import('events')

  type MockWatcher = EventEmitter & {
    close: ReturnType<typeof vi.fn<() => Promise<void>>>
    on: ReturnType<typeof vi.fn>
  }

  const watch = vi.fn(() => {
    const emitter = new EventEmitter()
    const addListener = emitter.on.bind(emitter)
    const watcher = emitter as MockWatcher
    watcher.close = vi.fn(async () => {
      emitter.removeAllListeners()
    })
    watcher.on = vi.fn((event: string, handler: (...args: any[]) => void) => {
      addListener(event, handler)
      return watcher
    })
    return watcher
  })

  return {
    default: { watch },
  }
})

vi.mock('../../../../server/config-store', () => ({
  configStore: {
    getProjectColors: vi.fn().mockResolvedValue({}),
    snapshot: vi.fn(),
  },
}))

const CLAUDE_HEALTHY_ID = '00000001-0000-4000-8000-0000000000c1'
const CLAUDE_PREFIX_ID = '00000002-0000-4000-8000-0000000000c2'
const CLAUDE_UTF8_ID = 'cccc1111-2222-4333-8444-555566667777'
const CLAUDE_PARTIAL_ID = '00000003-0000-4000-8000-0000000000c3'
const CODEX_HEALTHY_ID = 'codex-s16-healthy'
const AMP_HEALTHY_ID = 'amp-s16-healthy'
const AMP_PARTIAL_ID = 'amp-s16-partial'

/** Minimal valid claude record (user line: cwd + sessionId + message -> title). */
function claudeUserLine(sessionId: string, cwd: string, timestamp: string, message: string): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd,
    sessionId,
    version: '1.0.0',
    gitBranch: 'main',
    type: 'user',
    message: { role: 'user', content: message },
    uuid: sessionId,
    timestamp,
  }) + '\n'
}

function codexHealthyRollout(sessionId: string, cwd: string): string {
  return [
    JSON.stringify({
      timestamp: '2026-07-18T08:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd },
    }),
    JSON.stringify({
      timestamp: '2026-07-18T08:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'codex healthy request' }],
      },
    }),
  ].join('\n') + '\n'
}

function amplifierHealthyMetadata(id: string, workingDir: string, name: string): string {
  return JSON.stringify({
    session_id: id,
    working_dir: workingDir,
    created: '2026-08-01T00:00:00.000Z',
    description_updated_at: '2026-08-01T00:00:02.000Z',
    name,
    description: `${name} summary`,
  })
}

function allSessions(indexer: CodingCliSessionIndexer) {
  return indexer.getProjects().flatMap((group) => group.sessions)
}

function sessionKeys(indexer: CodingCliSessionIndexer): string[] {
  return allSessions(indexer)
    .map((session) => `${session.provider}:${session.sessionId}`)
    .sort()
}

let tempDir: string

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-s16-legacy-'))
  clearRepoRootCache()
  vi.mocked(configStore.snapshot).mockResolvedValue({
    sessionOverrides: {},
    settings: {
      codingCli: {
        enabledProviders: ['claude', 'codex', 'amplifier'],
        providers: {},
      },
    },
  } as never)
})

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true })
  vi.clearAllMocks()
})

/** Seed the full per-provider quarantine matrix around one healthy record each. */
async function seedCorpus() {
  const claudeProjects = path.join(tempDir, '.claude', 'projects')
  const claudeProj = path.join(claudeProjects, '-p')
  await fsp.mkdir(claudeProj, { recursive: true })

  await fsp.writeFile(
    path.join(claudeProj, `${CLAUDE_HEALTHY_ID}.jsonl`),
    claudeUserLine(CLAUDE_HEALTHY_ID, '/p/healthy', '2026-01-30T08:00:00.000Z', 'claude healthy request'),
  )
  // (a) 0-byte (never flushed).
  await fsp.writeFile(path.join(claudeProj, '0000000a-0000-4000-8000-0000000000a0.jsonl'), '')
  // (b) whitespace-only.
  await fsp.writeFile(path.join(claudeProj, '0000000b-0000-4000-8000-0000000000b0.jsonl'), '\n  \n\r\n\t\n')
  // (c) every line malformed.
  await fsp.writeFile(
    path.join(claudeProj, '0000000c-0000-4000-8000-0000000000c0.jsonl'),
    'not json at all\n{"unclosed":\n\x00\x01 binary junk\n[1,2,\n',
  )
  // (d) well-formed JSON, NO cwd anywhere (the R10b discovery gate).
  await fsp.writeFile(
    path.join(claudeProj, '0000000d-0000-4000-8000-0000000000d0.jsonl'),
    '{"type":"summary","summary":"a cwd-less record"}\n{"type":"user","message":{"role":"user","content":"hi"}}\n',
  )
  // (e) truncated-only: the whole file is one incomplete JSON object.
  const fullTruncated = claudeUserLine(
    '0000000e-0000-4000-8000-0000000000e0',
    '/p/truncated-only',
    '2026-01-30T08:01:00.000Z',
    'cut off',
  )
  await fsp.writeFile(
    path.join(claudeProj, '0000000e-0000-4000-8000-0000000000e0.jsonl'),
    fullTruncated.slice(0, Math.floor(fullTruncated.length / 3)),
  )
  // NOT quarantined — truncated with a VALID prefix (the cwd-bearing line survived;
  // only the tail line is cut): the parseable prefix is indexed.
  const prefixKept = claudeUserLine(CLAUDE_PREFIX_ID, '/p/prefix', '2026-01-30T08:02:00.000Z', 'prefix kept')
  const partialTail = claudeUserLine(CLAUDE_PREFIX_ID, '/p/prefix', '2026-01-30T08:03:00.000Z', 'cut tail')
  await fsp.writeFile(
    path.join(claudeProj, `${CLAUDE_PREFIX_ID}.jsonl`),
    prefixKept + partialTail.slice(0, Math.floor(partialTail.length / 3)),
  )
  // NOT quarantined — invalid-UTF-8 bytes inside an otherwise valid record (lossy read).
  await fsp.writeFile(
    path.join(claudeProj, `${CLAUDE_UTF8_ID}.jsonl`),
    Buffer.concat([
      Buffer.from(
        `{"parentUuid":null,"cwd":"/p/utf8","sessionId":"${CLAUDE_UTF8_ID}","type":"user","message":{"role":"user","content":"bad `,
        'utf8',
      ),
      Buffer.from([0xc3, 0x28, 0x20, 0xe2, 0x82, 0x20, 0xf0, 0x9f, 0x98]),
      Buffer.from(
        ` end"},"uuid":"cccc0001-0000-4000-8000-000000000001","timestamp":"2026-01-30T08:04:00.000Z"}\n`,
        'utf8',
      ),
    ]),
  )
  // Partially-written, becomes valid in the second test's follow-up step.
  const partialLine = claudeUserLine(CLAUDE_PARTIAL_ID, '/p/partial', '2026-01-30T08:05:00.000Z', 'partial record')
  await fsp.writeFile(
    path.join(claudeProj, `${CLAUDE_PARTIAL_ID}.jsonl`),
    partialLine.slice(0, Math.floor((partialLine.length * 2) / 3)),
  )

  // Codex: healthy + 0-byte + all-malformed (rollover shapes under sessions/YYYY/MM/DD).
  const codexDir = path.join(tempDir, '.codex', 'sessions', '2026', '07', '18')
  await fsp.mkdir(codexDir, { recursive: true })
  await fsp.writeFile(
    path.join(codexDir, `${CODEX_HEALTHY_ID}.jsonl`),
    codexHealthyRollout(CODEX_HEALTHY_ID, '/p/codex-healthy'),
  )
  await fsp.writeFile(path.join(codexDir, 'codex-s16-empty.jsonl'), '')
  await fsp.writeFile(path.join(codexDir, 'codex-s16-garbage.jsonl'), '!!!\n{"x":\n\x00 junk\n')

  // Amplifier: healthy + malformed-metadata + empty-metadata + working_dir-less.
  const ampProjects = path.join(tempDir, '.amplifier', 'projects', 's16-project', 'sessions')
  const ampHealthyDir = path.join(ampProjects, AMP_HEALTHY_ID)
  await fsp.mkdir(ampHealthyDir, { recursive: true })
  await fsp.writeFile(
    path.join(ampHealthyDir, 'metadata.json'),
    amplifierHealthyMetadata(AMP_HEALTHY_ID, '/p/amp-healthy', 's16 amplifier healthy'),
  )
  await fsp.writeFile(
    path.join(ampHealthyDir, 'transcript.jsonl'),
    '{"role":"user","content":"s16 amplifier healthy request"}\n',
  )
  const ampMalformedDir = path.join(ampProjects, 'amp-s16-malformed')
  await fsp.mkdir(ampMalformedDir, { recursive: true })
  await fsp.writeFile(path.join(ampMalformedDir, 'metadata.json'), '{not json at all')
  const ampEmptyDir = path.join(ampProjects, 'amp-s16-empty')
  await fsp.mkdir(ampEmptyDir, { recursive: true })
  await fsp.writeFile(path.join(ampEmptyDir, 'metadata.json'), '')
  const ampCwdlessDir = path.join(ampProjects, 'amp-s16-cwdless')
  await fsp.mkdir(ampCwdlessDir, { recursive: true })
  await fsp.writeFile(
    path.join(ampCwdlessDir, 'metadata.json'),
    '{"session_id":"amp-s16-cwdless","name":"no working dir"}',
  )
  // Partially-written (becomes valid later): truncated mid-doc.
  const ampPartialDir = path.join(ampProjects, AMP_PARTIAL_ID)
  await fsp.mkdir(ampPartialDir, { recursive: true })
  const fullAmp = amplifierHealthyMetadata(AMP_PARTIAL_ID, '/p/amp-partial', 's16 amplifier partial')
  await fsp.writeFile(
    path.join(ampPartialDir, 'metadata.json'),
    fullAmp.slice(0, Math.floor((fullAmp.length * 2) / 3)),
  )
}

/** Real providers repointed at the isolated temp home. */
function makeProviders() {
  const claudeHome = path.join(tempDir, '.claude')
  const codexHome = path.join(tempDir, '.codex')
  const amplifierHome = path.join(tempDir, '.amplifier')
  return [
    { ...claudeProvider, homeDir: claudeHome },
    { ...codexProvider, homeDir: codexHome },
    // The legacy amplifier provider reads `transcript.jsonl` siblings relative to each
    // metadata.json's own dir — only `homeDir` drives discovery.
    { ...amplifierProvider, homeDir: amplifierHome },
  ]
}

describe('SESSION-16 legacy control: malformed/partial provider data tolerance', () => {
  it('keeps healthy sessions available and quarantines every bad-record class', async () => {
    await seedCorpus()
    const indexer = new CodingCliSessionIndexer(makeProviders())

    await indexer.refresh()

    // Exactly the indexable set: healthy triple + claude valid-prefix + claude
    // invalid-UTF-8. Every quarantine class is absent.
    expect(sessionKeys(indexer)).toEqual([
      `amplifier:${AMP_HEALTHY_ID}`,
      `claude:${CLAUDE_HEALTHY_ID}`,
      `claude:${CLAUDE_PREFIX_ID}`,
      `claude:${CLAUDE_UTF8_ID}`,
      `codex:${CODEX_HEALTHY_ID}`,
    ])

    // The invalid-UTF-8 record is indexed LOSSILY (never quarantined): U+FFFD in title.
    const lossy = allSessions(indexer).find((s) => s.sessionId === CLAUDE_UTF8_ID)
    expect(lossy?.title ?? '').toContain('�')
    expect(lossy?.cwd).toBe('/p/utf8')

    // Scan-failure bookkeeping stays empty: nothing here is a provider OUTAGE (all
    // roots listable), only per-record quarantine.
    expect(indexer.getScanFailures()).toEqual([])
  })

  it('indexes a partially-written record once its completing write lands (no restart)', async () => {
    await seedCorpus()
    const indexer = new CodingCliSessionIndexer(makeProviders(), {
      debounceMs: 50,
      throttleMs: 0,
      fullScanIntervalMs: 0,
    })

    // start() (not bare refresh()): the warm RESCAN path is driven by watcher-marked
    // dirty files — the REAL delivery channel a completing write uses in production.
    await indexer.start()
    try {
      expect(sessionKeys(indexer)).not.toContain(`claude:${CLAUDE_PARTIAL_ID}`)
      expect(sessionKeys(indexer)).not.toContain(`amplifier:${AMP_PARTIAL_ID}`)

      // Claude: the writer resumes and the file's content becomes the completed line.
      const claudePartialPath = path.join(
        tempDir, '.claude', 'projects', '-p', `${CLAUDE_PARTIAL_ID}.jsonl`,
      )
      const partialFull = claudeUserLine(CLAUDE_PARTIAL_ID, '/p/partial', '2026-01-30T08:05:00.000Z', 'partial record')
      await fsp.writeFile(claudePartialPath, partialFull)

      // Amplifier: the provider rewrites the completed metadata doc whole.
      const ampPartialPath = path.join(
        tempDir, '.amplifier', 'projects', 's16-project', 'sessions', AMP_PARTIAL_ID, 'metadata.json',
      )
      const ampFull = amplifierHealthyMetadata(AMP_PARTIAL_ID, '/p/amp-partial', 's16 amplifier partial')
      await fsp.writeFile(ampPartialPath, ampFull)

      // Drive the REAL incremental channel: the (mocked) chokidar 'change' events mark
      // the files dirty; the debounced refresh then re-reads exactly those.
      const watcher = (indexer as unknown as {
        watcher: { emit: (event: string, payload: unknown) => boolean } | null
      }).watcher
      watcher?.emit('change', claudePartialPath)
      watcher?.emit('change', ampPartialPath)

      await vi.waitFor(
        () => {
          expect(sessionKeys(indexer)).toContain(`claude:${CLAUDE_PARTIAL_ID}`)
          expect(sessionKeys(indexer)).toContain(`amplifier:${AMP_PARTIAL_ID}`)
        },
        { timeout: 5000, interval: 100 },
      )

      // Exactly the two completions joined; the quarantine classes stay absent.
      expect(sessionKeys(indexer)).toEqual([
        `amplifier:${AMP_HEALTHY_ID}`,
        `amplifier:${AMP_PARTIAL_ID}`,
        `claude:${CLAUDE_HEALTHY_ID}`,
        `claude:${CLAUDE_PREFIX_ID}`,
        `claude:${CLAUDE_PARTIAL_ID}`,
        `claude:${CLAUDE_UTF8_ID}`,
        `codex:${CODEX_HEALTHY_ID}`,
      ])
    } finally {
      await indexer.stop()
    }
  })
})
