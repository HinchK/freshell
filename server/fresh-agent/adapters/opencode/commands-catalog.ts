import { z } from 'zod'

import {
  FreshAgentSessionCommandSchema,
  type FreshAgentSessionCommand,
} from '../../../../shared/fresh-agent-contract.js'

/** Row shape of the sidecar's `GET /command` listing (opencode 1.18.x; VAL-A receipts).
 * Explicit nulls were observed live on description/agent/model/subtask, so every
 * advertised field is null-tolerant; unknown extra fields are tolerated (stripped by
 * default) but never advertised. The contract keeps the minimal intersect — template/
 * agent/model/subtask/hints stay serve-side (hints are template-side, aliases omitted). */
const OpencodeSidecarCommandRowSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
  // Exactly the three sources proven executable via POST /session/{id}/command (VAL-A
  // LB-04b + E4). A row from an unknown future source is dropped rather than
  // speculatively advertised as dispatchable.
  source: z.enum(['command', 'mcp', 'skill']),
})

/** Normalize the raw `/command` payload to contract rows. Returns undefined when the
 * payload is not an array at all (caller treats it as a fetch failure: catalog absent).
 * Individual malformed rows are DROPPED, keeping their valid siblings — one bad row must
 * never nuke a whole 40+ row listing (same skip-invalid convention as the model catalog's
 * normalizeOpencodeEnabledModelCatalog). An empty listing is a real, publishable catalog. */
export function normalizeOpencodeCommandCatalog(raw: unknown): FreshAgentSessionCommand[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const rows: FreshAgentSessionCommand[] = []
  for (const entry of raw) {
    const parsed = OpencodeSidecarCommandRowSchema.safeParse(entry)
    if (!parsed.success) continue
    const row = FreshAgentSessionCommandSchema.safeParse({
      name: parsed.data.name,
      description: parsed.data.description ?? '',
    })
    if (row.success) rows.push(row.data)
  }
  return rows
}

export type OpencodeSlashCommandMatch = {
  /** Canonical name with the catalog's own casing. */
  name: string
  /** Everything after the name's separating whitespace run, verbatim (inner and
   * trailing spacing preserved); '' when the send carried no arguments. */
  arguments: string
}

/** Strict leading-slash shape: name = first token after '/', args = the rest verbatim
 * (e.g. "/review  a  b " → name "review", arguments "a  b "; "/review " → ""). */
const SLASH_SUBMISSION_PATTERN = /^\/(\S+)(?:\s+([\s\S]*))?$/

/** Resolve a submitted composer text against the session's captured catalog. Matching is
 * case-insensitive on canonical names only (the catalog's row wins the casing); aliases
 * are never consulted (opencode rows advertise none). Absent/empty catalog, non-leading
 * slash, or no name match ⇒ undefined, and the caller keeps the verbatim prompt path. */
export function matchOpencodeSlashCommand(
  text: string,
  catalog: readonly FreshAgentSessionCommand[] | undefined,
): OpencodeSlashCommandMatch | undefined {
  if (!catalog || catalog.length === 0) return undefined
  const match = SLASH_SUBMISSION_PATTERN.exec(text)
  if (!match) return undefined
  const lookup = match[1]!.toLowerCase()
  const row = catalog.find((candidate) => candidate.name.toLowerCase() === lookup)
  if (!row) return undefined
  return { name: row.name, arguments: match[2] ?? '' }
}
