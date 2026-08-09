import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * HARNESS-06 — deterministic file-tree fixtures.
 *
 *  - `createLocalFileTree()` builds the FILE-01 corpus: an HTML page (with the
 *    stable marker), a real PNG, a Unicode-named text file, a genuinely binary
 *    file, a large file, nested directories, a hidden directory, an empty dir —
 *    with a sha256/size manifest the specs hash-compare.
 *  - `createShareTrees()` builds the synthetic Windows-share pair for FILE-02's
 *    "real temporary SMB-share URL ... never a similarly prefixed neighbor":
 *    two sibling root dirs named `share` and `share-evil` sharing the `share`
 *    prefix, the main share carrying spaces/Unicode members. The NATIVE mount/
 *    read of such a share is host-limited to Windows; on Linux the harness
 *    exercises the tree content + the pure UNC/file-URL mapping semantics (the
 *    pure helpers below are exactly what FILE-02/03 parameterize).
 *
 * All roots live under a per-call mkdtemp; `cleanup()` removes them. Nothing
 * here ever touches the caller's real home.
 */

export interface FileManifestEntry {
  sha256: string
  size: number
}

export interface FileTreeResult {
  root: string
  /** rel path (posix-joined within the tree) → hash metadata */
  manifest: Record<string, FileManifestEntry>
  cleanup: () => void
}

export interface ShareTrees extends FileTreeResult {
  /** share name → tree (keys: 'share' and 'share-evil') */
  shares: Map<string, FileTreeResult>
}

export interface SplitFileUrl {
  server: string
  share: string
  segments: string[]
}

// ---------------------------------------------------------------------------
// Pure path-mapping helpers (FILE-02/03 semantics: exactly-once encoding)
// ---------------------------------------------------------------------------

/**
 * `\\server\share\seg1\seg2` — a real UNC path string. `segments` are raw
 * (already-decoded) names; UNC has no percent-encoding so nothing is escaped.
 */
export function uncPathFor(server: string, share: string, segments: string[]): string {
  return `\\\\${server}\\${share}\\${segments.join('\\')}`
}

/**
 * `file://server/share/seg1/seg2` with each segment percent-encoded exactly
 * once (RFC 3986; '/' is the path separator and is NOT encoded). Drive-style
 * `file:///C:/...` is `fileUrlFor('', 'C:', segments)` — see `splitFileUrl`.
 */
export function fileUrlFor(server: string, share: string, segments: string[]): string {
  const encoded = segments.map(encodeURIComponent).join('/')
  return `file://${server}/${share}/${encoded}`
}

/**
 * Inverse of `uncPathFor`. Returns null when the string is not a UNC path.
 * Decoding is a no-op (UNC carries raw names) — "exactly once".
 */
export function splitUncPath(unc: string): SplitFileUrl | null {
  const m = /^\\\\([^\\/]+)\\([^\\/]+)\\(.+)$/.exec(unc)
  if (!m) return null
  return { server: m[1], share: m[2], segments: m[3].split('\\') }
}

/**
 * Inverse of `fileUrlFor` (also handles `file:///C:/...` drive URLs as
 * server:''). Percent-decoding is applied EXACTLY ONCE per segment — so
 * `a%2520b.txt` yields the literal name `a%20b.txt`, never `a b.txt`.
 */
export function splitFileUrl(url: string): SplitFileUrl | null {
  const m = /^file:\/\/([^/]*)\/([^/]+)\/(.+)$/.exec(url)
  if (!m) return null
  const segments = m[3]
    .split('/')
    .map((s) => decodeURIComponent(s))
  return { server: m[1], share: decodeURIComponent(m[2]), segments }
}

// ---------------------------------------------------------------------------
// Deterministic content
// ---------------------------------------------------------------------------

/** Fixed, valid 1x1 PNG (red pixel) — the deterministic image fixture. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const INDEX_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>harness-06 local-file fixture</title></head>
<body>
<div id="fixture-marker">HARNESS-06 LOCAL FILE MARKER</div>
<p>Deterministic local-file tree for FILE-01.</p>
</body></html>
`

function binaryBytes(): Buffer {
  // 0x00..0xFF repeated 8 times = 2048 bytes covering every byte value.
  const buf = Buffer.alloc(256 * 8)
  for (let i = 0; i < buf.length; i++) buf[i] = i % 256
  return buf
}

function largeBytes(size: number): Buffer {
  // Deterministic LCG pattern — same input size → same bytes on every run.
  const buf = Buffer.alloc(size)
  let x = 0x12345678
  for (let i = 0; i < buf.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    buf[i] = x % 256
  }
  return buf
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

interface FileSpec {
  rel: string[]
  content: Buffer | string
  mode?: number
}

interface DirSpec {
  rel: string[]
}

function materialize(specs: FileSpec[], dirs: DirSpec[] = []): FileTreeResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-h06-tree-'))
  const manifest: Record<string, FileManifestEntry> = {}
  try {
    for (const d of dirs) {
      fs.mkdirSync(path.join(root, ...d.rel), { recursive: true })
    }
    for (const spec of specs) {
      const abs = path.join(root, ...spec.rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, spec.content)
      if (spec.mode !== undefined) fs.chmodSync(abs, spec.mode)
      const rel = spec.rel.join('/')
      const bytes = Buffer.isBuffer(spec.content) ? spec.content : Buffer.from(spec.content)
      manifest[rel] = { sha256: sha256(bytes), size: bytes.length }
    }
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true })
    throw err
  }
  return {
    root,
    manifest,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

const LARGE_FILE_SIZE = 5 * 1024 * 1024

export function createLocalFileTree(): FileTreeResult {
  return materialize(
    [
      { rel: ['index.html'], content: INDEX_HTML },
      { rel: ['image.png'], content: PNG_BYTES },
      { rel: ['ünïcodé fíle.txt'], content: 'Unicode fixture — grüße von harness-06\n' },
      { rel: ['binary.bin'], content: binaryBytes() },
      { rel: ['large.bin'], content: largeBytes(LARGE_FILE_SIZE) },
      { rel: ['nested', 'deep', 'note.md'], content: '# nested note\n\nfixture body\n' },
      { rel: ['.hidden', 'inside.txt'], content: 'hidden-dir member\n' },
    ],
    [{ rel: ['empty-dir'] }],
  )
}

export function createShareTrees(): ShareTrees {
  // One parent dir named like a share root's PARENT (`\\TESTBOX\`), containing
  // the two sibling share roots; the pair shares the 'share' prefix on purpose.
  const mainSpecs: FileSpec[] = [
    { rel: ['index.html'], content: INDEX_HTML },
    { rel: ['spaces dir', 'report final.txt'], content: 'MAIN-SHARE report body (spaces dir)\n' },
    { rel: ['ünïçødé dir', 'grüße.txt'], content: 'MAIN-SHARE unicode body ü\n' },
    { rel: ['plain.txt'], content: 'MAIN-SHARE plain\n' },
  ]
  // Materialize both shares under ONE temp parent so `main.root` and
  // `neighbor.root` are siblings (the prefix-confusion layout FILE-02 needs).
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-h06-share-'))
  const shares = new Map<string, FileTreeResult>()
  const manifest: Record<string, FileManifestEntry> = {}
  try {
    const shareRoot = path.join(parent, 'share')
    const evilRoot = path.join(parent, 'share-evil')
    const build = (root: string, specs: FileSpec[]): FileTreeResult => {
      const m: Record<string, FileManifestEntry> = {}
      for (const spec of specs) {
        const abs = path.join(root, ...spec.rel)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, spec.content)
        const rel = spec.rel.join('/')
        const bytes = Buffer.isBuffer(spec.content) ? spec.content : Buffer.from(spec.content)
        m[rel] = { sha256: sha256(bytes), size: bytes.length }
      }
      return { root, manifest: m, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
    }
    shares.set('share', build(shareRoot, mainSpecs))
    shares.set('share-evil', build(evilRoot, [
      // Same member names as the main share would be bait for prefix confusion;
      // distinct CONTENT proves a confused read.
      { rel: ['bait.txt'], content: 'NEIGHBOR-SHARE bait — must never be served as share/ content\n' },
      { rel: ['plain.txt'], content: 'NEIGHBOR-SHARE plain (differs from main)\n' },
    ]))
    for (const [name, tree] of shares) {
      for (const [rel, entry] of Object.entries(tree.manifest)) {
        manifest[`${name}/${rel}`] = entry
      }
    }
  } catch (err) {
    fs.rmSync(parent, { recursive: true, force: true })
    throw err
  }
  return {
    root: parent,
    shares,
    manifest,
    cleanup: () => fs.rmSync(parent, { recursive: true, force: true }),
  }
}
