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

    if (fixture.name === 'f10-c1-opener') {
      // Authored-fixture bug: f10's input bytes are "\u001b?1003h\u001b?2004h"
      // (ESC followed by '?'), but — per the README's Input Domain — the C1
      // CSI opener is U+009B ("\u009b"), and ESC '?' is a complete (unknown)
      // two-byte ESC sequence to any ECMA-48 parser, so "?1003h" can never be
      // tracked from those bytes. The fixture's own name, and its expected
      // output, confirm the intent was a U+009B input. port/ ownership is
      // outside this change's scope, so this case is pinned as expected-to-fail
      // until the fixture bytes are corrected to "\u009b?1003h\u009b?2004h" —
      // at which point vitest fails this run and the `it.fails` must be removed.
      it.fails(`${fixture.name} (xfail: fixture encodes C1 CSI as ESC '?'; awaiting port/ byte fix)`, () => {
        expect(emittedSyncData(fixture)).toBe(fixture.expectedSyncData)
      })
      continue
    }

    it(fixture.name, () => {
      expect(emittedSyncData(fixture)).toBe(fixture.expectedSyncData)
    })
  }
})
