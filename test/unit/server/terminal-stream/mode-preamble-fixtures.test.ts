// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ReplayRing } from '../../../../server/terminal-stream/replay-ring'

/**
 * Cross-language oracle parity: the exact scanner/synthesis contract lives in
 * port/oracle/baselines/mode-preamble/README.md and its f01..f15 fixtures are
 * consumed verbatim here (Node side; the Rust server consumes the same files).
 *
 * Per the README semantics: feed `chunks` in order through a fresh ReplayRing's
 * append sequence (the tracker scans the PRE-normalize data), then synthesize.
 * `expectedSyncData == ""` means NO terminal.modes.sync frame may be emitted —
 * either because surfaceReset is false or because the projection is empty. The
 * emission shim below mirrors exactly that gate; the REAL emission gates are
 * pinned at broker level in broker-modes-sync.test.ts.
 */

type ModePreambleFixture = {
  name: string
  chunks: string[]
  surfaceReset: boolean
  expectedSyncData: string
  note?: string
}

const FIXTURE_DIR = fileURLToPath(
  new URL('../../../../port/oracle/baselines/mode-preamble/', import.meta.url),
)

const fixtureFiles = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith('.json'))
  .sort()

function loadFixture(file: string): ModePreambleFixture {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), 'utf8')) as ModePreambleFixture
}

function emittedSyncData(fixture: ModePreambleFixture): string {
  const ring = new ReplayRing()
  for (const chunk of fixture.chunks) {
    ring.append(chunk, { streamId: 'mode-preamble-fixture' })
  }
  // Emission gate from the README: surfaceReset absent/false ⇒ no frame,
  // regardless of tracker state.
  return fixture.surfaceReset ? ring.synthesizeModes() : ''
}

describe('mode-preamble oracle fixtures', () => {
  it('fixture directory contains the f01..f15 family', () => {
    expect(fixtureFiles).toEqual([
      'f01-opencode-startup.json',
      'f02-family-clear.json',
      'f03-encoding-slot.json',
      'f04-alt-fold.json',
      'f05-alt-toggle-off.json',
      'f06-ris.json',
      'f07-decstr.json',
      'f08-xtmodifykeys.json',
      'f09-chunk-carry.json',
      'f10-c1-opener.json',
      'f11-garbage-resync.json',
      'f12-decrqm.json',
      'f13-cursor-visibility-restore.json',
      'f14-surface-reset-false.json',
      'f15-empty-tracker.json',
    ])
  })

  for (const file of fixtureFiles) {
    const fixture = loadFixture(file)

    it(fixture.name, () => {
      expect(emittedSyncData(fixture)).toBe(fixture.expectedSyncData)
    })
  }
})
