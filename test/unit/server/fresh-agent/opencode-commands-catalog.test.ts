import { describe, expect, it } from 'vitest'

import {
  matchOpencodeSlashCommand,
  normalizeOpencodeCommandCatalog,
} from '../../../../server/fresh-agent/adapters/opencode/commands-catalog.js'
import { FreshAgentSessionCommandSchema, type FreshAgentSessionCommand } from '../../../../shared/fresh-agent-contract.js'

/** Verbatim row from the VAL-A receipt `val-a-command-dirB-post-session.json`
 * (opencode 1.18.18): explicit nulls on agent/model/subtask, hints template-side. */
const VAL_A_ROW = {
  name: 'val-b-probe',
  description: 'VAL-B-PROBE',
  agent: null,
  model: null,
  source: 'command',
  template: 'VALPROBE-EXPANDED: $ARGUMENTS',
  subtask: null,
  hints: ['$ARGUMENTS'],
}

describe('normalizeOpencodeCommandCatalog', () => {
  it('normalizes receipt-shaped rows, tolerating explicit nulls and missing optionals', () => {
    const rows = normalizeOpencodeCommandCatalog([
      VAL_A_ROW,
      { name: 'goal', description: null, agent: null, model: null, source: 'command', subtask: null },
      { name: 'mcp-tool', description: 'via mcp', source: 'mcp' },
      { name: 'browsing', description: 'skill row', source: 'skill' },
    ])

    expect(rows).toEqual([
      { name: 'val-b-probe', description: 'VAL-B-PROBE' },
      { name: 'goal', description: '' },
      { name: 'mcp-tool', description: 'via mcp' },
      { name: 'browsing', description: 'skill row' },
    ])
    // Contract stays the minimal intersect: no serve-side fields, no undefined-valued
    // optionals (argumentHint/aliases are OMITTED, not null/undefined).
    expect(JSON.stringify(rows)).not.toMatch(/template|agent|model|subtask|hints|source|argumentHint|aliases/)
    for (const row of rows ?? []) {
      expect(() => FreshAgentSessionCommandSchema.parse(row)).not.toThrow()
    }
  })

  it('keeps all three proven executable sources (command, mcp, skill) and drops unknown sources', () => {
    const rows = normalizeOpencodeCommandCatalog([
      { name: 'from-command', description: '', source: 'command' },
      { name: 'from-mcp', description: '', source: 'mcp' },
      { name: 'from-skill', description: '', source: 'skill' },
      { name: 'from-future', description: '', source: 'future-source' },
    ])

    expect(rows?.map((row) => row.name)).toEqual(['from-command', 'from-mcp', 'from-skill'])
  })

  it('drops malformed rows (empty/missing name) but keeps valid siblings', () => {
    const rows = normalizeOpencodeCommandCatalog([
      { name: '', description: 'empty name', source: 'command' },
      { description: 'nameless', source: 'command' },
      'a plain string is not a row',
      null,
      { name: 'valid', description: 'survives', source: 'command' },
    ])

    expect(rows).toEqual([{ name: 'valid', description: 'survives' }])
  })

  it('returns undefined for a non-array payload so the caller treats it as absent', () => {
    expect(normalizeOpencodeCommandCatalog({})).toBeUndefined()
    expect(normalizeOpencodeCommandCatalog(null)).toBeUndefined()
    expect(normalizeOpencodeCommandCatalog(undefined)).toBeUndefined()
    expect(normalizeOpencodeCommandCatalog('[]')).toBeUndefined()
  })

  it('treats an empty listing as a real, publishable empty catalog', () => {
    expect(normalizeOpencodeCommandCatalog([])).toEqual([])
  })
})

describe('matchOpencodeSlashCommand', () => {
  const catalog: FreshAgentSessionCommand[] = [
    { name: 'Review', description: 'review the diff' },
    { name: 'val-b-probe', description: 'VAL-B-PROBE' },
  ]

  it('matches the first token after a leading slash case-insensitively and returns the canonical casing', () => {
    expect(matchOpencodeSlashCommand('/review', catalog)).toEqual({ name: 'Review', arguments: '' })
    expect(matchOpencodeSlashCommand('/REVIEW', catalog)).toEqual({ name: 'Review', arguments: '' })
    expect(matchOpencodeSlashCommand('/Review', catalog)).toEqual({ name: 'Review', arguments: '' })
  })

  it('passes the arguments after the name verbatim, preserving inner and trailing spacing', () => {
    expect(matchOpencodeSlashCommand('/val-b-probe MARKER_B2', catalog))
      .toEqual({ name: 'val-b-probe', arguments: 'MARKER_B2' })
    expect(matchOpencodeSlashCommand('/val-b-probe  a  b ', catalog))
      .toEqual({ name: 'val-b-probe', arguments: 'a  b ' })
  })

  it('treats a trailing separator run with nothing after it as empty arguments', () => {
    expect(matchOpencodeSlashCommand('/review ', catalog)).toEqual({ name: 'Review', arguments: '' })
    expect(matchOpencodeSlashCommand('/review  ', catalog)).toEqual({ name: 'Review', arguments: '' })
  })

  it('does not match slash text that is absent from the catalog', () => {
    expect(matchOpencodeSlashCommand('/not-a-command args', catalog)).toBeUndefined()
  })

  it('does not match when the catalog is absent or empty', () => {
    expect(matchOpencodeSlashCommand('/review', undefined)).toBeUndefined()
    expect(matchOpencodeSlashCommand('/review', [])).toBeUndefined()
  })

  it('is not an alias lookup — matching is on canonical names only', () => {
    expect(matchOpencodeSlashCommand('/re help', catalog)).toBeUndefined()
  })

  it('ignores text without a strictly leading slash', () => {
    expect(matchOpencodeSlashCommand(' /review', catalog)).toBeUndefined()
    expect(matchOpencodeSlashCommand('look at /review please', catalog)).toBeUndefined()
    expect(matchOpencodeSlashCommand('/', catalog)).toBeUndefined()
    expect(matchOpencodeSlashCommand('/ review', catalog)).toBeUndefined()
    expect(matchOpencodeSlashCommand('', catalog)).toBeUndefined()
  })

  it('keeps multi-line arguments after the name intact', () => {
    expect(matchOpencodeSlashCommand('/review line one\nline two', catalog))
      .toEqual({ name: 'Review', arguments: 'line one\nline two' })
  })
})
