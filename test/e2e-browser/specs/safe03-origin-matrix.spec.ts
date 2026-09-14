import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import type { E2eServerHandle } from '../helpers/external-target.js'
import { RawWsClient } from '../helpers/raw-clients.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

/**
 *
 * Full acceptance text: "Enforce WebSocket Origin policy. Accept configured
 * trusted origins and reject hostile/malformed origins before session state
 * is exposed." Validation note: "Open raw sockets with same-origin, allowed
 * remote, missing, `null`, and hostile origins, assert documented
 * accept/close behavior, and verify rejected clients receive no
 * ready/settings/terminal data."
 *
 * Prior state (crate-level only): `crates/freshell-ws/src/origin.rs`'s
 * `evaluate_origin`/`resolve_allowed_origins` and
 * `crates/freshell-ws/tests/origin_policy.rs`'s real-socket integration
 * tests prove this at the Rust level, but never from a Playwright `PW-RUST`
 * spec (HARNESS-05: raw sockets driven from within an owned Playwright
 * test).
 *
 * KNOWN DIVERGENCE (documented in `origin.rs`'s own module doc comment, not
 * (`server/auth.ts#isOriginAllowed`, `ws-handler.ts`) is explicitly
 * ADVISORY-ONLY -- it never closes a socket for a bad Origin, only logs a
 * warning, and still authenticates via the hello token. The Rust port
 * deliberately HARDENS this into a real enforced policy (closing with a new
 * 4011 code before any session state is sent) because the Rust server's
 * production bind is `0.0.0.0` (LAN-reachable), where advisory-only leaves a
 * DNS-rebinding path open. This spec therefore runs the SAME connection
 * the DIFFERENT, per-kind-correct outcome for the reject-path cases:
 * checklist item exists to close, rust proves the fix.
 *
 * NOT covered here:
 *   - "verify rejected clients receive no ... settings/terminal data": the
 *     origin_policy.rs real-socket tests already prove the very FIRST frame
 *     after a hello on a rejected connection is never `ready` (session
 *     state), and this spec's `connectWithOrigin` helper applies the same
 *     check at the Playwright layer. A full "no terminal.inventory ever
 *     arrives either" walk would require creating a terminal and racing a
 *     background broadcast against the close, which is a materially bigger
 *     scenario for a marginal increment of proof beyond "the very next
 *     frame is a close, not `ready`" -- left as a narrowing note, not
 *     fabricated.
 */

async function bootWithAllowedOrigins(
  allowedOrigins: string,
): Promise<E2eServerHandle> {
  const server = new RustServer({ env: { ALLOWED_ORIGINS: allowedOrigins }, startTimeoutMs: 60_000 })
  await server.start()
  return server
}

type OriginOutcome = 'ready' | { closeCode: number; closeReason: string }

/**
 * Open a raw WS connection with an explicit (or absent) `Origin` header and
 * send a well-formed `hello` with a VALID token immediately. The raw client
 * records the actual peer close frame, rather than translating a TCP end into
 * a synthetic `1006` close code as a convenience client library would.
 */
async function connectWithOrigin(wsUrl: string, token: string, origin: string | undefined): Promise<OriginOutcome> {
  const client = await RawWsClient.connect(wsUrl, origin === undefined ? undefined : { headers: { Origin: origin } })
  try {
    // Start observing before hello can cause an immediate server response.
    const outcome = client.waitForJsonMessageOrTerminal('ready', 10_000)
    client.hello(token, WS_PROTOCOL_VERSION)
    const observed = await outcome
    if (observed.kind === 'message') {
      await client.closeGracefully()
      return 'ready'
    }
    if (observed.terminal !== 'peer-close') {
      throw new Error(`Origin-policy connection ended without a close frame: ${observed.terminal}`)
    }
    return { closeCode: observed.close.code, closeReason: observed.close.reason }
  } finally {
    await client.dispose()
  }
}

const ALLOW_LISTED_REMOTE_ORIGIN = 'https://trusted.example'

test.describe.serial('SAFE-03 WS Origin policy matrix', () => {
  let server: E2eServerHandle

  test.beforeAll(async () => {
    server = await bootWithAllowedOrigins(ALLOW_LISTED_REMOTE_ORIGIN)
  })

  test.afterAll(async () => {
    await server.stop()
  })

  test('no Origin header is allowed through to the ready handshake', async () => {
    const outcome = await connectWithOrigin(server.info.wsUrl, server.info.token, undefined)
    expect(outcome).toBe('ready')
  })

  test('same-origin (Origin matches the request Host) is allowed', async () => {
    const sameOrigin = `http://127.0.0.1:${server.info.port}`
    const outcome = await connectWithOrigin(server.info.wsUrl, server.info.token, sameOrigin)
    expect(outcome).toBe('ready')
  })

  test('an allow-listed remote origin (configured via ALLOWED_ORIGINS) is allowed', async () => {
    const outcome = await connectWithOrigin(server.info.wsUrl, server.info.token, ALLOW_LISTED_REMOTE_ORIGIN)
    expect(outcome).toBe('ready')
  })

  test('a hostile origin (DNS-rebinding shape) is rejected before session state -- KNOWN DIVERGENCE vs legacy', async () => {
    const outcome = await connectWithOrigin(server.info.wsUrl, server.info.token, 'http://evil.example')
    expect(outcome).not.toBe('ready')
    const closed = outcome as { closeCode: number; closeReason: string }
    expect(closed.closeCode).toBe(4011)
    expect(closed.closeReason).toBe('Origin not allowed')
  })

  test('the literal `null` origin (sandboxed iframe / file://) is rejected -- KNOWN DIVERGENCE vs legacy', async () => {
    const outcome = await connectWithOrigin(server.info.wsUrl, server.info.token, 'null')
    expect(outcome).not.toBe('ready')
    const closed = outcome as { closeCode: number; closeReason: string }
    expect(closed.closeCode).toBe(4011)
    expect(closed.closeReason).toBe('Origin not allowed')
  })

  test('a malformed origin (not a URL at all) is rejected -- KNOWN DIVERGENCE vs legacy', async () => {
    const outcome = await connectWithOrigin(server.info.wsUrl, server.info.token, 'not-a-url')
    expect(outcome).not.toBe('ready')
    const closed = outcome as { closeCode: number; closeReason: string }
    expect(closed.closeCode).toBe(4011)
    expect(closed.closeReason).toBe('Origin not allowed')
  })
})
