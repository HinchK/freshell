# BROWSER-01 — Complete same-origin HTTP reverse proxying

**Item (verbatim):** *Complete same-origin HTTP reverse proxying. Preserve method/path/query/body/useful headers/status/streaming while removing only iframe-blocking headers.*

**Checklist Playwright validation (`PW-RUST`):** *Load a fixture that sets CSP/X-Frame-Options in a Browser pane, interact through `frameLocator`, issue GET/POST/streaming requests, and assert exact upstream inputs and visible responses.*

**Reconciliation state (2026-07-18):** **P** — loopback reverse-proxy exists (oracle §3.18, `crates/freshell-server/src/proxy.rs`); `browser-pane-screenshot.spec.ts` proves CSP/X-Frame content renders through a proxy **Node-only**. Missing: `PW-RUST` GET/POST/streaming upstream-input spec AND (found by this audit) four real parity gaps in the Rust port.

## Parity source: legacy `server/proxy-router.ts` (frozen)

The HTTP half (lines 79–129), mounted at `/api/proxy` (`server/index.ts:863`) behind
`httpAuthMiddleware` (`:212`) and after `express.json({ limit: '1mb' })` (`:186`):

| Behavior | Legacy code | Contract |
|---|---|---|
| Route | `router.use('/http/:port')` → `/api/proxy/http/<port>/<path…>` | port `1..=65535` else `400 {error:"Invalid port number"}` |
| Target | always `127.0.0.1:<port>` | loopback only |
| Method | `req.method` verbatim | all methods |
| Path+query | `req.url` — **raw, never percent-decoded** (`:99`) | byte-exact upstream path+query |
| Request headers | everything except `host` (rewritten to `127.0.0.1:<port>`), `connection`, `transfer-encoding` (`:90–93`); arrays preserved | "useful headers" incl. duplicates |
| Request body | `req.pipe(proxyReq)` — **streamed, size-unbounded** for non-JSON; `express.json` consumed JSON is re-serialized (`JSON.stringify`, ≤1MB else 413 before the route) (`:119–128`) | body preserved; streaming |
| Response status | `res.writeHead(proxyRes.statusCode ?? 502, …)` | verbatim |
| Response headers | stripped set = EXACTLY `{x-frame-options, content-security-policy, content-security-policy-report-only}` (`:19–23`); everything else forwarded incl. multi-`set-cookie` arrays, `content-length` | remove only iframe-blockers |
| Response body | `proxyRes.pipe(res)` | streamed |
| Upstream down | `502 {error:"Failed to connect to localhost:<port>"}` (`:113`) | shape-exact |
| Auth | `/api` middleware 401 `{error:"Unauthorized"}` | cookie or `x-auth-token` |
| Redirects | none followed (raw `http.request`) | 3xx visible to iframe |

## Gaps found in the current Rust port (`crates/freshell-server/src/proxy.rs`)

| # | Gap | Legacy | Current Rust | Fix |
|---|---|---|---|---|
| G1 | **Percent-encoding corruption** | raw `req.url` forwarded | `Path<String>` catch-all percent-**decodes** `%2F`→`/`, `%25`→`%`; reqwest then re-serializes — upstream sees a different path for reserved chars | Parse `<port>`/`<rest>` off the RAW `uri.path()` (strip `/api/proxy/http/` byte-wise); append raw `uri.query()` |
| G2 | **Duplicate header collapse** (both directions) | Node arrays preserved (`set-cookie` multi-value) | `HeaderMap::insert` replaces all existing values — second of two `Set-Cookie` wins; login flows break | `append` everywhere |
| G3 | **Request body buffered + 2MB cap** | streamed, unbounded | `body: Bytes` extractor = full buffer AND axum `DefaultBodyLimit` (2MB) → 413 on large bodies | extract `body: Body`, `into_data_stream()` → `reqwest::Body::wrap_stream`; forward incoming `content-length` (legacy parity) |
| G4 | **`content-length` response header stripped** | forwarded | in `HOP_BY_HOP_RESPONSE_HEADERS` | forward it (bytes are untouched — reqwest has no gzip/brotli features enabled, so no decompression — the value stays accurate); keep stripping only `connection`/`transfer-encoding`/`keep-alive` (hyper recomputes framing; forwarding those double-frames) |

Already-correct, pin with tests: any-method, query passthrough, status passthrough, 3-header strip, 400/401/502 shapes, `host` rewrite, redirect non-following, `connection`/`transfer-encoding` request-side drop.

Deliberate divergences (recorded, better-than-legacy): Rust forwards **raw JSON bytes** (legacy re-serializes compact-JSON ≤1MB, 413 beyond) — every JSON parser sees an equivalent document; large-JSON 413 is a legacy `express.json` artifact, not proxy behavior, and the streamed Rust path has no such cap.

## Architecture

One module, `crates/freshell-server/src/proxy.rs`, keeps its public surface
(`ProxyState::new`, `router`) — the diffs are inside: raw-tail parsing off `uri`,
`append`-based header copies, streamed request body, widened response-header forwarding.
`reqwest` stays `default-features=false, features=["stream","rustls"]` (no transparent
compression; validated by probe L4). No client-side changes: `BrowserPane`'s
`buildHttpProxyUrl` already preserves `pathname + search + hash` byte-exact.

## Tests (proof stack, deterministic-first)

**A. In-module socket tests** (`proxy.rs` `#[cfg(test)]`, `#[tokio::test]`, real
`127.0.0.1:0` sockets): a raw-TCP upstream fixture scripts verbatim response bytes and
captures verbatim request bytes (no framework normalization); a raw-TCP client sends
verbatim request bytes (duplicate headers, escaped paths) and parses the full response.
Covers G1–G4 + all pinned behaviors, including:

- methods: GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS all forwarded;
- G1 paths: `/a%2Fb`, `/hello%20world`, `/%25`, `/caf%C3%A9`, unicode raw — upstream
  receives byte-exact; query `?x=%2F&a=1&a=2&b=+` byte-exact;
- G2: two `set-cookie` responses → client receives both; duplicate request header →
  upstream receives both;
- G3: 3MiB body streams through with original `content-length` (pre-fix: 413);
  chunked upload arrives incrementally (chunk 1 observable upstream before chunk 2
  sent — no sleeps, signal-gated);
- G4/response: `content-length` preserved; gzip `content-encoding` + gzipped bytes pass
  through untouched; only the 3 iframe headers removed; streaming response drip —
  client sees chunk 1 before upstream writes chunk 2 (oneshot-gated, no sleeps);
- status: 201/302(with Location)/404 verbatim; 400/401/502 shapes;
- `content-encoding: gzip` passthrough (L4 probe double-as-contract).

**B. Black-box binary test** (`crates/freshell-server/tests/browser01_proxy.rs`, diag01
pattern): boot the REAL `freshell-server` binary (temp HOME, ephemeral port,
`AUTH_TOKEN`), in-process raw-TCP upstream fixture; assert through the actual mounted
app: XFO/CSP stripped GET renders, POST byte-exact echo, multi-`set-cookie` both arrive,
401/400/502 shapes. Proves main.rs wiring, not just the module.

**C. Playwright spec** (`test/e2e-browser/specs/browser01-proxy.spec.ts`, authored —
probe-executable: ONE run per leg under the pw lease, per-leg outcomes classified;
registered in `MATRIX_SPECS`): in-spec fixture upstream (CSP/XFO page with a POST form +
an SSE-ish drip endpoint + an echo endpoint reporting exact method/path/query/headers/
body); drive a real Browser pane, `frameLocator` interactions; assert upstream-captured
exact inputs and visible iframe responses on both `legacy-chromium` (parity control)
and `rust-chromium`.

## TDD task order (commit each)

1. **L-probes (load-bearing validation)** — throwaway tests validating: L1 axum raw-path
   availability in handler + route matches encoded paths; L2 `HeaderMap::insert` collapse;
   L3 `Bytes` 2MB cap / `Body` uncapped; L4 reqwest no-injection/no-decompress;
   L5 wrap_stream + explicit content-length honored. Recorded in §Load-bearing audit
   (results appended to this file + evidence doc).
2. **G2 fix** (header append, both directions) — red test first (multi set-cookie), fix, green.
3. **G1 fix** (raw path/query) — red: `%2F` upstream capture mismatch; fix; green.
4. **G3 fix** (streamed request body) — red: 3MiB 413 + incremental-upload; fix; green.
5. **G4 fix** (forward content-length; hop list trim) — red: content-length dropped; fix; green.
6. **B. black-box binary test** — red on fresh checkout of pre-fix code would fail;
   authored after unit greens, proves wiring.
7. **C. PW spec** authored + registered; one probe run per leg; classify.
8. fmt/clippy/typecheck clean; focused greens ×2; evidence doc; review loop.

## Acceptance evidence (what "complete" means here)

Every parity-table row proven green on Rust (A/B), the PW-RUST spec authored + probe-run
with per-leg classification (C), `MATRIX_SPECS` registration additive, and the evidence
doc `docs/plans/df1-evidence/BROWSER-01.md` carrying the verdict matrix + green commands.
