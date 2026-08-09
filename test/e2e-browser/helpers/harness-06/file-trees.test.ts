import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createLocalFileTree,
  createShareTrees,
  uncPathFor,
  fileUrlFor,
  splitFileUrl,
  splitUncPath,
  type FileTreeResult,
} from './file-trees.js'

/**
 * HARNESS-06 file-trees vitest coverage: deterministic local file trees (FILE-01)
 * plus synthetic Windows-share trees and UNC/file-URL mapping (FILE-02/03). The
 * native SMB mount lane is host-limited (Windows); these tests cover everything
 * a Linux harness can: content, manifests/hashes, prefix-confusion layout, and
 * the pure path-mapping semantics.
 */

const trees: FileTreeResult[] = []
function track<T extends FileTreeResult>(t: T): T { trees.push(t); return t }

import { afterEach } from 'vitest'
afterEach(() => {
  while (trees.length) trees.pop()!.cleanup()
})

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

describe('harness-06 file-trees: local tree (FILE-01)', () => {
  it('creates a deterministic tree with a manifest matching on-disk reality', () => {
    const tree = track(createLocalFileTree())

    // Required fixture members (per family contract)
    for (const rel of [
      'index.html',
      'image.png',
      'ünïcodé fíle.txt',
      'binary.bin',
      'large.bin',
      path.join('nested', 'deep', 'note.md'),
      path.join('.hidden', 'inside.txt'),
    ]) {
      const abs = path.join(tree.root, rel)
      expect(fs.existsSync(abs), rel).toBe(true)
      expect(tree.manifest[rel], `manifest entry for ${rel}`).toBeDefined()
      const m = tree.manifest[rel]
      expect(m.sha256).toBe(sha256(abs))
      expect(m.size).toBe(fs.statSync(abs).size)
    }
    // An empty directory exists but is not a manifest FILE entry
    expect(fs.existsSync(path.join(tree.root, 'empty-dir'))).toBe(true)
    expect(tree.manifest['empty-dir']).toBeUndefined()
  })

  it('binary.bin is genuinely binary and large.bin default size is exercised', () => {
    const tree = track(createLocalFileTree())
    const bin = fs.readFileSync(path.join(tree.root, 'binary.bin'))
    expect(bin.length).toBeGreaterThanOrEqual(256)
    const bytes = new Set(bin)
    expect(bytes.has(0x00)).toBe(true)
    expect(bytes.has(0xff)).toBe(true)
    const large = fs.statSync(path.join(tree.root, 'large.bin')).size
    expect(large).toBeGreaterThanOrEqual(1 * 1024 * 1024)
    const html = fs.readFileSync(path.join(tree.root, 'index.html'), 'utf8')
    expect(html).toContain('id="fixture-marker"')
  })

  it('content is byte-identical across two independent creations (determinism)', () => {
    const a = track(createLocalFileTree())
    const b = track(createLocalFileTree())
    expect(a.manifest).toEqual(b.manifest)
    expect(a.root).not.toBe(b.root)
  })

  it('cleanup removes the tree and does not touch the real home', () => {
    const tree = track(createLocalFileTree())
    expect(tree.root).not.toBe(path.resolve(os.homedir()))
    tree.cleanup()
    expect(fs.existsSync(tree.root)).toBe(false)
    trees.pop() // already cleaned
  })
})

describe('harness-06 file-trees: share trees (FILE-02 synthetic-share lane)', () => {
  it('builds a prefix-confusion share pair with spaces/Unicode members', () => {
    const shares = track(createShareTrees())
    const main = shares.shares.get('share')!
    const neighbor = shares.shares.get('share-evil')!
    expect(main).toBeDefined()
    expect(neighbor).toBeDefined()

    // The neighbor root must be a DIFFERENT directory with a name sharing the
    // 'share' prefix (FILE-02: "never a similarly prefixed neighbor").
    expect(path.dirname(main.root)).toBe(path.dirname(neighbor.root))
    expect(path.basename(neighbor.root)).toBe('share-evil')
    expect(path.basename(main.root)).toBe('share')

    // Spaces + Unicode members inside the main share.
    for (const rel of [path.join('spaces dir', 'report final.txt'), path.join('ünïçødé dir', 'grüße.txt')]) {
      expect(fs.existsSync(path.join(main.root, rel)), rel).toBe(true)
      expect(main.manifest[rel]?.sha256).toBe(sha256(path.join(main.root, rel)))
    }
    // Neighbor content differs so a prefix-confused read is always detectable.
    const bait = fs.readFileSync(path.join(neighbor.root, 'bait.txt'), 'utf8')
    expect(bait).toContain('NEIGHBOR-SHARE')
    for (const [rel, m] of Object.entries(neighbor.manifest)) {
      expect(m.sha256).toBe(sha256(path.join(neighbor.root, rel)))
    }
  })

  it('maps share members to UNC paths and file:// URLs with exact-once encoding', () => {
    const shares = track(createShareTrees())
    const rel = ['spaces dir', 'report final.txt']
    const unc = uncPathFor('TESTBOX', 'share', rel)
    expect(unc).toBe('\\\\TESTBOX\\share\\spaces dir\\report final.txt')
    const url = fileUrlFor('TESTBOX', 'share', rel)
    expect(url).toBe('file://TESTBOX/share/spaces%20dir/report%20final.txt')

    const urel = ['ünïçødé dir', 'grüße.txt']
    const uurl = fileUrlFor('TESTBOX', 'share', urel)
    expect(uurl).toBe('file://TESTBOX/share/%C3%BCn%C3%AF%C3%A7%C3%B8d%C3%A9%20dir/gr%C3%BC%C3%9Fe.txt')
    const uunc = uncPathFor('TESTBOX', 'share', urel)
    expect(uunc).toBe('\\\\TESTBOX\\share\\ünïçødé dir\\grüße.txt')
    expect(shares).toBeTruthy()
  })

  it('splits UNC paths and file URLs back (exactly-once decode, drive/UNC forms)', () => {
    expect(splitUncPath('\\\\TESTBOX\\share\\a b\\c.txt')).toEqual({
      server: 'TESTBOX', share: 'share', segments: ['a b', 'c.txt'],
    })
    expect(splitFileUrl('file://TESTBOX/share/a%20b/c.txt')).toEqual({
      server: 'TESTBOX', share: 'share', segments: ['a b', 'c.txt'],
    })
    expect(splitFileUrl('file:///C:/Users/dan/file.txt')).toEqual({
      server: '', share: 'C:', segments: ['Users', 'dan', 'file.txt'],
    })
    // Exactly-once: an encoded %25 must decode to a literal '%', not re-decode.
    expect(splitFileUrl('file://TESTBOX/share/a%2520b.txt')).toEqual({
      server: 'TESTBOX', share: 'share', segments: ['a%20b.txt'],
    })
    // Round trip through the builders.
    const rel = ['d ü', 'f% g.txt']
    expect(splitFileUrl(fileUrlFor('S', 'share', rel))).toEqual({ server: 'S', share: 'share', segments: rel })
  })
})
