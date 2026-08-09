import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import { X509Certificate, createHash } from 'node:crypto'
import { startTargetServer, type TargetServer, type TlsKeyPair } from './target-server.js'

/**
 * HARNESS-06 trusted-HTTPS fixture.
 *
 * Loads the committed test CA / localhost leaf / unrelated self-signed leaf
 * from `fixtures/tls/` (see that directory's REGENERATE.md — test-only
 * material, DO NOT TRUST), boots the deterministic target-server handler over
 * TLS on an ephemeral loopback port, and provides the trust probe (`fetchWithCa`)
 * the TAURI-14 / BROWSER-03 lanes parameterize:
 *
 *   trusted leaf + fixture CA pinned  -> succeeds (the "trusted HTTPS" leg)
 *   trusted leaf + NO CA              -> rejects (system default store)
 *   untrusted leaf + fixture CA       -> rejects (unrelated self-signed cert)
 */

export interface TlsAssets {
  /** PEM — the throwaway test CA. Add to a client trust store to TRUST the leaf. */
  caCert: string
  server: TlsKeyPair
  untrusted: TlsKeyPair
  /** base64 SPKI (sha256) of the leaf — Chromium --ignore-certificate-errors-spn-list form. */
  serverSpkiSha256B64: string
}

export interface HttpsTarget {
  port: number
  baseUrl: string
  wsUrl: string
  target: TargetServer
  stop: () => Promise<void>
}

export interface CaFetchResult {
  status: number
  body: string
  /** PEM of the peer's leaf certificate (what the trust decision evaluated). */
  peerCertificates: string
}

const TLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/tls',
)

export function loadTestTlsAssets(): TlsAssets {
  const read = (name: string): string => fs.readFileSync(path.join(TLS_DIR, name), 'utf8')
  const serverCert = read('localhost.cert.pem')
  const leaf = new X509Certificate(serverCert)
  const spki = leaf.publicKey.export({ format: 'der', type: 'spki' })
  return {
    caCert: read('ca.cert.pem'),
    server: { key: read('localhost.key.pem'), cert: serverCert },
    untrusted: { key: read('untrusted.key.pem'), cert: read('untrusted.cert.pem') },
    serverSpkiSha256B64: createHash('sha256').update(spki).digest('base64'),
  }
}

/** Boot the target-server handler over TLS on 127.0.0.1:<ephemeral>. */
export async function startHttpsTarget(kind: 'trusted' | 'untrusted'): Promise<HttpsTarget> {
  const assets = loadTestTlsAssets()
  const tlsPair = kind === 'trusted' ? assets.server : assets.untrusted
  const target = await startTargetServer({ tls: tlsPair })
  return {
    port: target.port,
    baseUrl: target.baseUrl,
    wsUrl: target.wsUrl,
    target,
    stop: () => target.stop(),
  }
}

/**
 * GET `url` with an explicit trust decision: `ca` pins the fixture CA, its
 * ABSENCE uses the Node default store (which does NOT trust the fixture CA —
 * the negative leg). Rejects (throws the TLS error with `.code`) on any
 * verification failure. Captures the peer leaf PEM for assertions.
 */
export async function fetchWithCa(url: string, ca?: string): Promise<CaFetchResult> {
  const parsed = new URL(url)
  return new Promise<CaFetchResult>((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port || 443),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        ca: ca ? [ca] : undefined,
        servername: parsed.hostname === 'localhost' ? 'localhost' : undefined,
      },
      (res) => {
        // Capture the peer certificate NOW — res.socket may be released before
        // the 'end' listener runs (agent pooling), which would throw and leave
        // the promise unsettled.
        const socket = res.socket
        const peerRaw =
          socket && typeof (socket as import('tls').TLSSocket).getPeerCertificate === 'function'
            ? ((socket as import('tls').TLSSocket).getPeerCertificate()?.raw as Buffer | undefined)
            : undefined
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            peerCertificates: peerRaw ? new X509Certificate(peerRaw).toString() : '',
          })
        })
      },
    )
    req.once('error', reject)
    req.end()
  })
}
