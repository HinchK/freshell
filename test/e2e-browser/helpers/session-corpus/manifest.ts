/**
 * HARNESS-04 — corpus manifest: the machine-readable contract of a built
 * corpus. The builder hashes every file it writes; the Playwright contract
 * re-parses the manifest from disk and recomputes hashes to prove integrity.
 */

import path from 'path'
import fsp from 'fs/promises'
import { createHash } from 'crypto'
import type {
  CorpusFileRecord,
  CorpusGitFixture,
  CorpusProvider,
  CorpusSessionExpectation,
} from './types.js'

export interface CorpusRoots {
  claudeProjects: string
  codexSessions: string
  codexArchived: string
  opencodeData: string
  amplifierProjects: string
  freshellConfig: string
  corpusWorkspace: string
}

export interface CorpusPaginationExpectation {
  listedCount: number
  pageLimit: number
  expectedPages: number
}

export interface CorpusManifest {
  formatVersion: 1
  runId: string
  generatedAt: string
  homeDir: string
  providers: CorpusProvider[]
  roots: CorpusRoots
  files: CorpusFileRecord[]
  sessions: CorpusSessionExpectation[]
  gitFixtures: CorpusGitFixture[]
  pagination: CorpusPaginationExpectation
}

export const CORPUS_MANIFEST_DIR = '.freshell-corpus'
export const CORPUS_MANIFEST_FILE = 'manifest.json'

export async function sha256File(filePath: string): Promise<string> {
  const content = await fsp.readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

/** Hash-path bookkeeping shared by every provider writer. */
export async function recordFile(
  files: CorpusFileRecord[],
  homeDir: string,
  absolutePath: string,
  role: string,
): Promise<void> {
  const stat = await fsp.stat(absolutePath)
  files.push({
    path: path.relative(homeDir, absolutePath).split(path.sep).join('/'),
    sha256: await sha256File(absolutePath),
    bytes: stat.size,
    role,
  })
}

export async function writeManifest(homeDir: string, manifest: CorpusManifest): Promise<string> {
  const dir = path.join(homeDir, CORPUS_MANIFEST_DIR)
  await fsp.mkdir(dir, { recursive: true })
  const manifestPath = path.join(dir, CORPUS_MANIFEST_FILE)
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifestPath
}

function fail(message: string): never {
  throw new Error(`session-corpus manifest: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validateManifest(value: unknown): CorpusManifest {
  if (!isRecord(value)) fail('not an object')
  if (value.formatVersion !== 1) fail(`unsupported formatVersion ${String(value.formatVersion)}`)
  if (typeof value.runId !== 'string' || !value.runId.startsWith('h04corpus-')) fail('bad runId')
  if (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) fail('bad generatedAt')
  if (typeof value.homeDir !== 'string' || !path.isAbsolute(value.homeDir)) fail('bad homeDir')
  if (!Array.isArray(value.providers) || value.providers.length !== 4) fail('bad providers')
  if (!isRecord(value.roots)) fail('missing roots')
  for (const key of ['claudeProjects', 'codexSessions', 'codexArchived', 'opencodeData', 'amplifierProjects', 'freshellConfig', 'corpusWorkspace']) {
    if (typeof (value.roots as Record<string, unknown>)[key] !== 'string') fail(`roots.${key} missing`)
  }
  if (!Array.isArray(value.files)) fail('bad files')
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.path !== 'string' || typeof file.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(file.sha256) || typeof file.bytes !== 'number'
      || typeof file.role !== 'string') {
      fail(`bad file record ${JSON.stringify(file)}`)
    }
  }
  if (!Array.isArray(value.sessions)) fail('bad sessions')
  for (const session of value.sessions) {
    if (!isRecord(session) || typeof session.key !== 'string'
      || typeof session.provider !== 'string' || typeof session.sessionId !== 'string'
      || typeof session.role !== 'string' || typeof session.projectPath !== 'string'
      || typeof session.cwd !== 'string'
      || typeof session.lastActivityAt !== 'number' || !Number.isInteger(session.lastActivityAt)
      || !['listed', 'absent', 'hidden-default'].includes(session.visibility as string)) {
      fail(`bad session record ${JSON.stringify(session)}`)
    }
  }
  if (!Array.isArray(value.gitFixtures)) fail('bad gitFixtures')
  if (!isRecord(value.pagination)) fail('bad pagination')
  const page = value.pagination as Record<string, unknown>
  if (typeof page.listedCount !== 'number' || typeof page.pageLimit !== 'number'
    || typeof page.expectedPages !== 'number' || page.expectedPages < 2) {
    fail('pagination block must describe more than one page')
  }
  return value as unknown as CorpusManifest
}

/** Read and validate `<homeDir>/.freshell-corpus/manifest.json` from disk. */
export async function loadSessionCorpusManifest(homeDir: string): Promise<CorpusManifest> {
  const manifestPath = path.join(homeDir, CORPUS_MANIFEST_DIR, CORPUS_MANIFEST_FILE)
  let raw: string
  try {
    raw = await fsp.readFile(manifestPath, 'utf-8')
  } catch (error) {
    fail(`unreadable at ${manifestPath}: ${(error as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    fail(`invalid JSON: ${(error as Error).message}`)
  }
  return validateManifest(parsed)
}

/**
 * Every regular file under the home (recursive), as posix-style paths relative
 * to the home, sorted. The builder/contract use this to prove the manifest's
 * hash list has 100% coverage of what the build physically wrote.
 */
export async function walkCoveragePaths(homeDir: string): Promise<string[]> {
  const rels: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        rels.push(path.relative(homeDir, full).split(path.sep).join('/'))
      }
    }
  }
  await walk(homeDir)
  return rels.sort()
}
