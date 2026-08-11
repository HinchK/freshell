import { describe, it, expect, afterEach } from 'vitest'
import {
  generateUpdateKeypair,
  minisignSign,
  minisignVerify,
  startUpdateFeed,
  type UpdateFeed,
} from './update-feed.js'

/**
 * HARNESS-06 signed-update-feed coverage. The manifest shape mirrors
 * crates/freshell-tauri/src/updater.rs's LatestManifest
 * ({version,notes,pub_date,platforms{<triple>:{signature,url}}}) and the
 * tauri v2 updater wire convention: manifest `signature` = base64 of the
 * ENTIRE minisign .sig file text; `pubkey` = base64 of the .pub file text.
 * `minisignVerify` is an INDEPENDENT verification path (parses pub/sig
 * texts, keynum match, artifact signature, trusted-comment global signature).
 */

const feeds: UpdateFeed[] = []
async function makeFeed(opts?: Parameters<typeof startUpdateFeed>[0]): Promise<UpdateFeed> {
  const f = await startUpdateFeed(opts)
  feeds.push(f)
  return f
}
afterEach(async () => {
  while (feeds.length) await feeds.pop()!.stop()
})

describe('harness-06 update-feed: keys + minisign wire format', () => {
  it('generates unique ed25519 keypairs with tauri-style base64(.pub text) config', () => {
    const a = generateUpdateKeypair()
    const b = generateUpdateKeypair()
    expect(a.tauriPubkeyConfig).not.toBe(b.tauriPubkeyConfig)
    const decoded = Buffer.from(a.tauriPubkeyConfig, 'base64').toString('utf8')
    expect(decoded).toBe(a.pubFileText)
    expect(a.pubFileText).toMatch(/^untrusted comment: minisign public key: [0-9A-F]{16}\n/)
    const lines = a.pubFileText.trim().split('\n')
    expect(lines).toHaveLength(2)
    const raw = Buffer.from(lines[1], 'base64')
    expect(raw.length).toBe(2 + 8 + 32) // "Ed" || keynum || pub32
    expect(raw.subarray(0, 2).toString('latin1')).toBe('Ed')
  })

  it('signs an artifact into the exact 4-line .sig text layout', async () => {
    const kp = generateUpdateKeypair()
    const data = Buffer.from('harmless fixture artifact v1\n')
    const sig = await minisignSign(kp, data, { fileName: 'fixture.zip' })
    const lines = sig.trim().split('\n')
    expect(lines[0]).toBe('untrusted comment: signature from minisign secret key')
    const sigRaw = Buffer.from(lines[1], 'base64')
    expect(sigRaw.length).toBe(2 + 8 + 64)
    expect(sigRaw.subarray(0, 2).toString('latin1')).toBe('Ed')
    expect(lines[2]).toMatch(/^trusted comment: timestamp:\d+\tfile:fixture\.zip$/)
    const globalRaw = Buffer.from(lines[3], 'base64')
    expect(globalRaw.length).toBe(64 + 8)
  })

  it('round-trips sign->verify with an independent verifier (artifact + trusted comment)', async () => {
    const kp = generateUpdateKeypair()
    const data = Buffer.from('harmless fixture artifact v2\n')
    const sig = await minisignSign(kp, data, { fileName: 'fixture.zip' })
    await expect(minisignVerify(kp.tauriPubkeyConfig, sig, data)).resolves.toBe(true)
  })

  it('rejects tampered artifacts, wrong keys, and trusted-comment edits', async () => {
    const kp = generateUpdateKeypair()
    const other = generateUpdateKeypair()
    const data = Buffer.from('harmless fixture artifact v3\n')
    const sig = await minisignSign(kp, data, { fileName: 'fixture.zip' })

    // Tampered artifact
    await expect(
      minisignVerify(kp.tauriPubkeyConfig, sig, Buffer.from('harmless fixture artifact v3!\n')),
    ).resolves.toBe(false)
    // Wrong key
    await expect(minisignVerify(other.tauriPubkeyConfig, sig, data)).resolves.toBe(false)
    // Trusted-comment edit breaks the global signature
    const tamperedComment = sig.replace(/timestamp:\d+/, 'timestamp:1')
    expect(tamperedComment).not.toBe(sig)
    await expect(minisignVerify(kp.tauriPubkeyConfig, tamperedComment, data)).resolves.toBe(false)
    // Malformed inputs reject, never throw
    await expect(minisignVerify(kp.tauriPubkeyConfig, 'garbage', data)).resolves.toBe(false)
    await expect(minisignVerify('garbage', sig, data)).resolves.toBe(false)
  })
})

describe('harness-06 update-feed: feed server (latest.json + artifact + github leg)', () => {
  it('serves a Tauri-shaped latest.json and the exact artifact bytes; signature verifies', async () => {
    const feed = await makeFeed({ version: '0.8.1' })
    expect(feed.artifactBytes.length).toBeGreaterThan(10)

    const manifest = (await (await fetch(feed.manifestUrl)).json()) as {
      version: string
      notes: string
      pub_date: string
      platforms: Record<string, { signature: string; url: string }>
    }
    expect(manifest.version).toBe('0.8.1')
    expect(manifest.notes.length).toBeGreaterThan(0)
    expect(manifest.pub_date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(Object.keys(manifest.platforms).sort()).toEqual(['linux-x86_64', 'windows-x86_64'])
    const entry = manifest.platforms['linux-x86_64']
    expect(entry.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/artifacts\//)

    // manifest signature = base64 of the .sig TEXT (tauri convention)
    const sigText = Buffer.from(entry.signature, 'base64').toString('utf8')
    expect(sigText).toContain('untrusted comment: signature')

    const download = await fetch(entry.url)
    expect(download.status).toBe(200)
    const bytes = Buffer.from(await download.arrayBuffer())
    expect(bytes.equals(feed.artifactBytes)).toBe(true)

    await expect(minisignVerify(feed.keypair.tauriPubkeyConfig, sigText, bytes)).resolves.toBe(true)
  })

  it('signWith lets a spec publish a feed signed by the WRONG key (must fail vs the armed key)', async () => {
    const armed = generateUpdateKeypair()
    const wrong = generateUpdateKeypair()
    const feed = await makeFeed({ version: '9.9.9', keypair: armed, signWithKeypair: wrong })
    const manifest = (await (await fetch(feed.manifestUrl)).json()) as {
      platforms: Record<string, { signature: string; url: string }>
    }
    const sigText = Buffer.from(manifest.platforms['linux-x86_64'].signature, 'base64').toString('utf8')
    await expect(minisignVerify(armed.tauriPubkeyConfig, sigText, feed.artifactBytes)).resolves.toBe(false)
    await expect(minisignVerify(wrong.tauriPubkeyConfig, sigText, feed.artifactBytes)).resolves.toBe(true)
  })

  it('tamperArtifact serves bytes that fail signature verification (corrupt download)', async () => {
    const feed = await makeFeed({ version: '0.8.2', tamperArtifact: true })
    const manifest = (await (await fetch(feed.manifestUrl)).json()) as {
      platforms: Record<string, { signature: string; url: string }>
    }
    const entry = manifest.platforms['windows-x86_64']
    const bytes = Buffer.from(await (await fetch(entry.url)).arrayBuffer())
    expect(bytes.equals(feed.artifactBytes)).toBe(false) // served bytes differ from signed bytes
    const sigText = Buffer.from(entry.signature, 'base64').toString('utf8')
    await expect(minisignVerify(feed.keypair.tauriPubkeyConfig, sigText, bytes)).resolves.toBe(false)
  })

  it('supports arbitrary version/platform shapes (equal/older/wrong-platform legs live in callers)', async () => {
    const feed = await makeFeed({ version: '0.7.5', targets: ['windows-x86_64'] })
    const manifest = (await (await fetch(feed.manifestUrl)).json()) as {
      version: string
      platforms: Record<string, unknown>
    }
    expect(manifest.version).toBe('0.7.5')
    expect(Object.keys(manifest.platforms)).toEqual(['windows-x86_64'])
  })

  it('serves the legacy-GitHub releases/latest shape (server updateCheck leg)', async () => {
    const feed = await makeFeed({ version: '1.2.3' })
    const body = (await (await fetch(`${feed.baseUrl}/github/releases/latest`)).json()) as {
      tag_name: string
      html_url: string
    }
    expect(body.tag_name).toBe('v1.2.3')
    expect(body.html_url).toContain('/releases/tag/v1.2.3')
  })
})
