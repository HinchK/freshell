import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'

/**
 * HARNESS-06 signed-update-feed fixture.
 *
 * Serves a `tauri-plugin-updater`-shaped feed:
 *   GET /latest.json           {version, notes, pub_date, platforms{<triple>:{signature,url}}}
 *   GET /artifacts/<name>      the harmless signed artifact bytes (application/octet-stream)
 *   GET /github/releases/latest  {tag_name:'v<version>', html_url} — the shape the Rust
 *                                server's /api/version updateCheck consumes
 *                                (crates/freshell-server/src/updater.rs GitHubRelease).
 *
 * Wire conventions (tauri v2 updater; confirmed in the checklist ledger L4/L5):
 *   - manifest `signature` = base64 of the ENTIRE minisign `.sig` file TEXT.
 *   - `pubkey` (tauri.conf.json) = base64 of the minisign `.pub` file TEXT.
 *   - `.pub` text: `untrusted comment: minisign public key: <KEYNUM16>\n` +
 *                  base64(`"Ed"‖keynum8‖pub32`).
 *   - `.sig` text: `untrusted comment: signature from minisign secret key\n` +
 *                  base64(`"Ed"‖keynum8‖sig64`) + `\n` +
 *                  `trusted comment: timestamp:<unix>\tfile:<name>\n` +
 *                  base64(`globalsig64‖keynum8`), where
 *                  globalsig = Ed25519_sign(sk, sig64 ‖ trustedCommentText).
 *
 * `minisignVerify` below is an INDEPENDENT verifier (not the signer's code
 * path): it parses both texts, checks the embedded keynum match, verifies the
 * artifact signature AND the trusted-comment global signature. Native
 * `tauri signer` / real `tauri-plugin-updater` consumption remains in the
 * host-limited UPDATE-* lanes; wire-format regressions are caught here.
 *
 * Keys are generated per run (node:crypto Ed25519 + JWK raw-key export) so no
 * private material is ever committed.
 */

const b64 = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString('base64')
const fromB64 = (s: string): Buffer => Buffer.from(s, 'base64')

export interface UpdateKeypair {
  /** node:crypto private key (Ed25519) — test-only, runtime-generated. */
  privateKey: crypto.KeyObject
  /** raw 32-byte public key */
  publicKeyRaw: Buffer
  /** 8-byte key identifier embedded in both .pub and .sig texts */
  keynum: Buffer
  /** minisign `.pub` file text */
  pubFileText: string
  /** tauri.conf.json `plugins.updater.pubkey` value (= base64 of pubFileText) */
  tauriPubkeyConfig: string
}

export function generateUpdateKeypair(): UpdateKeypair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string }
  const publicKeyRaw = Buffer.from(jwk.x, 'base64url')
  if (publicKeyRaw.length !== 32) throw new Error('unexpected ed25519 public key length')
  const keynum = crypto.randomBytes(8)
  const keynumHex = keynum.toString('hex').toUpperCase()
  const pubLine = b64(Buffer.concat([Buffer.from('Ed', 'latin1'), keynum, publicKeyRaw]))
  const pubFileText = `untrusted comment: minisign public key: ${keynumHex}\n${pubLine}\n`
  return {
    privateKey,
    publicKeyRaw,
    keynum,
    pubFileText,
    tauriPubkeyConfig: b64(Buffer.from(pubFileText, 'utf8')),
  }
}

export async function minisignSign(
  kp: UpdateKeypair,
  data: Buffer,
  opts: { fileName?: string; unixTime?: number } = {},
): Promise<string> {
  const fileName = opts.fileName ?? 'artifact'
  const sig64 = crypto.sign(null, data, kp.privateKey)
  const trusted = `trusted comment: timestamp:${opts.unixTime ?? Math.floor(Date.now() / 1000)}\tfile:${fileName}`
  const globalSig = crypto.sign(null, Buffer.concat([sig64, Buffer.from(trusted, 'utf8')]), kp.privateKey)
  return [
    'untrusted comment: signature from minisign secret key',
    b64(Buffer.concat([Buffer.from('Ed', 'latin1'), kp.keynum, sig64])),
    trusted,
    b64(Buffer.concat([globalSig, kp.keynum])),
    '',
  ].join('\n')
}

/**
 * Independent minisign verification for fixture assertions. Returns false on
 * ANY mismatch or malformed input (never throws).
 */
export async function minisignVerify(
  tauriPubkeyConfig: string,
  sigFileText: string,
  data: Buffer,
): Promise<boolean> {
  try {
    // Parse the public key text.
    const pubText = Buffer.from(tauriPubkeyConfig, 'base64').toString('utf8')
    const pubLines = pubText.trim().split('\n')
    if (pubLines.length !== 2 || !pubLines[0].startsWith('untrusted comment:')) return false
    const pubRaw = fromB64(pubLines[1])
    if (pubRaw.length !== 42 || pubRaw.subarray(0, 2).toString('latin1') !== 'Ed') return false
    const pubKeynum = pubRaw.subarray(2, 10)
    const pub32 = pubRaw.subarray(10, 42)
    const keyObject = crypto.createPublicKey({
      format: 'jwk',
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pub32).toString('base64url') },
    })

    // Parse the signature text.
    const sigLines = sigFileText.trim().split('\n')
    if (sigLines.length !== 4) return false
    if (sigLines[0] !== 'untrusted comment: signature from minisign secret key') return false
    const sigRaw = fromB64(sigLines[1])
    if (sigRaw.length !== 74 || sigRaw.subarray(0, 2).toString('latin1') !== 'Ed') return false
    const sigKeynum = sigRaw.subarray(2, 10)
    const sig64 = sigRaw.subarray(10, 74)
    if (!sigKeynum.equals(pubKeynum)) return false
    const trusted = sigLines[2]
    if (!trusted.startsWith('trusted comment: ')) return false
    const globalRaw = fromB64(sigLines[3])
    if (globalRaw.length !== 72) return false
    const globalSig = globalRaw.subarray(0, 64)
    if (!globalRaw.subarray(64, 72).equals(pubKeynum)) return false

    // Verify the artifact signature AND the trusted-comment global signature.
    if (!crypto.verify(null, data, keyObject, sig64)) return false
    if (!crypto.verify(null, Buffer.concat([sig64, Buffer.from(trusted, 'utf8')]), keyObject, globalSig)) {
      return false
    }
    return true
  } catch {
    return false
  }
}

export interface UpdateFeedOptions {
  /** The version the feed advertises (caller's equal/older/newer legs pick this). */
  version: string
  /** Target triple keys present in the platforms map. Default: linux + windows x64. */
  targets?: string[]
  artifactName?: string
  /** The bytes that are SIGNED (and, unless tampered, served). Default: harmless marker. */
  artifactBytes?: Buffer
  /** The armed keypair (default: generated). */
  keypair?: UpdateKeypair
  /** Sign with a DIFFERENT keypair than the armed one (wrong-key leg). */
  signWithKeypair?: UpdateKeypair
  /** Serve bytes that differ from the signed bytes (corrupt-download leg). */
  tamperArtifact?: boolean
  pubDate?: string
}

export interface UpdateFeed {
  port: number
  baseUrl: string
  manifestUrl: string
  artifactName: string
  /** The bytes that were SIGNED (the harmless artifact's intended content). */
  artifactBytes: Buffer
  keypair: UpdateKeypair
  stop: () => Promise<void>
}

export async function startUpdateFeed(opts: UpdateFeedOptions): Promise<UpdateFeed> {
  if (!opts.version) throw new Error('startUpdateFeed requires a version')
  const keypair = opts.keypair ?? generateUpdateKeypair()
  const signer = opts.signWithKeypair ?? keypair
  const artifactName = opts.artifactName ?? `freshell-fixture_${opts.version}.zip`
  const artifactBytes = opts.artifactBytes ?? Buffer.from(
    `FRESHELL-HARNESS-06-FIXTURE-ARTIFACT\nversion=${opts.version}\n`
    + 'This bundle is inert test content signed by a throwaway ed25519 key.\n',
    'utf8',
  )
  const targets = opts.targets ?? ['linux-x86_64', 'windows-x86_64']
  const servedBytes = opts.tamperArtifact
    ? Buffer.concat([artifactBytes, Buffer.from('\nTAMPERED\n')])
    : artifactBytes
  const sockets = new Set<net.Socket>()

  const sigText = await minisignSign(signer, artifactBytes, { fileName: artifactName })
  const signatureField = b64(Buffer.from(sigText, 'utf8'))

  let port = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/latest.json') {
      const platforms: Record<string, { signature: string; url: string }> = {}
      for (const t of targets) {
        platforms[t] = {
          signature: signatureField,
          url: `http://127.0.0.1:${port}/artifacts/${encodeURIComponent(artifactName)}`,
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        version: opts.version,
        notes: 'harness-06 fixture update feed (harmless signed artifact)',
        pub_date: opts.pubDate ?? '2026-08-09T00:00:00Z',
        platforms,
      }))
      return
    }
    if (url.pathname === `/artifacts/${encodeURIComponent(artifactName)}` || url.pathname === `/artifacts/${artifactName}`) {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': servedBytes.length,
      })
      res.end(servedBytes)
      return
    }
    if (url.pathname === '/github/releases/latest') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        tag_name: `v${opts.version}`,
        html_url: `http://127.0.0.1:${port}/releases/tag/v${opts.version}`,
      }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found', path: url.pathname }))
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('update-feed failed to bind')
  port = addr.port

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    manifestUrl: `http://127.0.0.1:${port}/latest.json`,
    artifactName,
    artifactBytes,
    keypair,
    stop: async () => {
      for (const s of sockets) { try { s.destroy() } catch { /* closed */ } }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
