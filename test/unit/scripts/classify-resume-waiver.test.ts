import { describe, expect, it } from 'vitest'

import {
  HARNESSED_TESTS,
  classifyResumeWaiver,
} from '../../../scripts/classify-resume-waiver'

// Delta-review r6: the Mechanism-B certification waiver must enforce the exact
// accepted signature — no looser (waiving an unrelated failure that happens to
// mention the token) and no tighter (rejecting a true signature because of
// another terminal's recovery frames). These fixtures pin both edges.

const GREEN_LOG = `
running 2 tests
test crashing_agent_is_resumed_twice_then_settles_exited ... ok
test reconcile_after_replacement_attaches_to_the_new_terminal ... ok

test result: ok. 2 passed; 0 failed
`

function failingLog(testName: string, ringEntries: string[]): string {
  // The ring renders via Rust Debug ({ignored:?}) with escaped quotes — the
  // classifier must normalize that before parsing.
  const ring = ringEntries.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(', ')
  return `
running 2 tests

---- ${testName} stdout ----
thread '${testName}' panicked at crates/freshell-ws/tests/auto_resume_e2e.rs:170:13:
timed out waiting for terminal.replaced; ignored frames (last ${ringEntries.length}): [${ring}]
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace

failures:

failures:
    ${testName}

test result: FAILED. 0 passed; 1 failed
`
}

const SETTLE =
  'type="terminal.status" tid="term-A" status="exited" reason="no_resumable_identity"'

describe('classifyResumeWaiver (mechanism-B certification waiver)', () => {
  it('reports no-failure on a green log', () => {
    expect(classifyResumeWaiver(GREEN_LOG).verdict).toBe('no-failure')
  })

  it('waives the exact mechanism-B signature, including Debug-escaped quotes', () => {
    const c = classifyResumeWaiver(
      failingLog('crashing_agent_is_resumed_twice_then_settles_exited', [
        'type="sessions.updated"',
        SETTLE,
        // Recovery activity for an UNRELATED terminal must not block (r6).
        'type="terminal.status" tid="term-OTHER" status="recovering" attempt="1"',
        'type="terminal.replaced" tid="term-OTHER"',
      ]),
    )
    expect(c.verdict).toBe('waive')
    expect(c.evidence.join('\n')).toContain('no_resumable_identity')
  })

  it('waives both harnessed tests when both fail with the signature', () => {
    expect(HARNESSED_TESTS.size).toBe(2)
    const log =
      failingLog('crashing_agent_is_resumed_twice_then_settles_exited', [SETTLE]) +
      failingLog('reconcile_after_replacement_attaches_to_the_new_terminal', [SETTLE])
    expect(classifyResumeWaiver(log).verdict).toBe('waive')
  })

  it('blocks when ANY failing test is outside the harnessed pair', () => {
    const log =
      failingLog('crashing_agent_is_resumed_twice_then_settles_exited', [SETTLE]) +
      failingLog('some_other_flake_entirely', [SETTLE])
    const c = classifyResumeWaiver(log)
    expect(c.verdict).toBe('block')
    expect(c.evidence.join('\n')).toContain('some_other_flake_entirely')
  })

  it('blocks when the only exited frame carries a different reason', () => {
    const c = classifyResumeWaiver(
      failingLog('crashing_agent_is_resumed_twice_then_settles_exited', [
        'type="terminal.status" tid="term-A" status="exited" reason="clean_exit"',
      ]),
    )
    expect(c.verdict).toBe('block')
    expect(c.evidence.join('\n')).toContain('clean_exit')
  })

  it('blocks when the token appears in panic text but no ring settle frame exists', () => {
    const log = failingLog('crashing_agent_is_resumed_twice_then_settles_exited', []).replace(
      'timed out waiting for terminal.replaced',
      'hub settle mentioned no_resumable_identity in its log line',
    )
    expect(classifyResumeWaiver(log).verdict).toBe('block')
  })

  it('blocks when the settled terminal was replaced (recovery happened)', () => {
    const c = classifyResumeWaiver(
      failingLog('crashing_agent_is_resumed_twice_then_settles_exited', [
        SETTLE,
        'type="terminal.replaced" tid="term-A" attempt="1"',
      ]),
    )
    expect(c.verdict).toBe('block')
    expect(c.evidence.join('\n')).toContain('recover')
  })

  it('blocks when the settled terminal shows a recovering attempt', () => {
    const c = classifyResumeWaiver(
      failingLog('crashing_agent_is_resumed_twice_then_settles_exited', [
        SETTLE,
        'type="terminal.status" tid="term-A" status="recovering" attempt="1"',
      ]),
    )
    expect(c.verdict).toBe('block')
  })

  it('blocks when a settle frame lacks terminalId (uncorrelatable)', () => {
    const c = classifyResumeWaiver(
      failingLog('crashing_agent_is_resumed_twice_then_settles_exited', [
        'type="terminal.status" status="exited" reason="no_resumable_identity"',
      ]),
    )
    expect(c.verdict).toBe('block')
    expect(c.evidence.join('\n')).toContain('terminalId')
  })

  it('blocks when FAILED is reported without a parseable failures list', () => {
    expect(classifyResumeWaiver('test result: FAILED. 0 passed; 1 failed\n').verdict).toBe('block')
  })

  it('blocks when the failing test has no stdout section', () => {
    const log = `
failures:
    crashing_agent_is_resumed_twice_then_settles_exited

test result: FAILED. 0 passed; 1 failed
`
    expect(classifyResumeWaiver(log).verdict).toBe('block')
  })
})
