# BROWSER-01 — Complete same-origin HTTP reverse proxying — df1 evidence

**Item (verbatim):** *Complete same-origin HTTP reverse proxying. Preserve method/path/query/body/useful headers/status/streaming while removing only iframe-blocking headers.*

**Branch:** `df1/browser-01-same-origin-proxy` (base `origin/df1/integration` @ `3dbba43c2`) · **Date:** 2026-08-09 · **Playwright posture:** `deferred` (spec authored + registered in `MATRIX_SPECS`; probe-executable rule satisfied — ONE probe run per leg under the pw lease, per-leg outcomes classified below).

**Parity source:** legacy `server/proxy-router.ts:79–129` (HTTP half of `/api/proxy`), with `express.json({limit:'1mb'})` + `httpAuthMiddleware` mounted before it (`server/index.ts:186,209–212,863`).

## What was MISSING on base (gap audit vs legacy)

The base already had `crates/freshell-server/src/proxy.rs` (oracle §3.18 port). Gap-hunting against the legacy contract found **four real parity breaks**, each RED-proven before fixing:

| Gap | Base behavior | Legacy | Fix |
|---|---|---|---|
| G1 | `Path<String>` catch-all percent-**decoded** the tail → `%2F`→`/`, upstream saw a mutated route | raw `req.url` forwarded (`proxy-router.ts:99`) | port/rest parsed off the RAW `uri.path()` |
| G2 | `HeaderMap::insert` collapsed duplicate headers both directions → 2nd `Set-Cookie` won, login flows break | Node header arrays forwarded verbatim | `append` in both copy loops |
| G3 | `Bytes` extraction fully buffered the request body AND hit axum's 2 MiB `DefaultBodyLimit` → 413 on large uploads | `req.pipe(proxyReq)` streams any size | `Body` extraction → `reqwest::Body::wrap_stream`, attach only when a body is declared, original `content-length` forwarded (probe L5 semantics) |
| G4 | upstream `content-length` stripped from responses | `writeHead` forwards it | removal set = 3 iframe-blockers + only truly hop-by-hop framing (`connection`/`transfer-encoding`/`keep-alive`) |

Deliberate divergence (recorded, strictly stronger than legacy): Rust forwards raw JSON bodies byte-exact where legacy re-serialized compact JSON (and 413'd JSON >1MB inside `express.json`, pre-route). Any JSON parser sees an equivalent document; the wire-level unit tests pin the byte-exact behavior.

## Load-bearing audit (all empirically verified — `proxy.rs::lb_probes`)

L1 axum routes match percent-encoded paths AND `uri.path()` is raw/undecoded in the handler · L2 `HeaderMap::insert` replace-all vs `append` preserve-order · L3 `Bytes` 2 MiB cap (413) vs uncapped `Body` · L4 reqwest (default-features=false+stream+rustls) injects NO `accept-encoding` and does NO decompression (51-byte real gzip passthrough, byte-exact) · L5 `wrap_stream` + explicit `content-length` puts that exact length on the wire (no chunked) · L6 legacy `req.url` rawness (inspection, `proxy-router.ts:99`). Full ledger: `docs/plans/df1/BROWSER-01.md` §Load-bearing audit.

## PROVEN (green, x2 consecutive)

- **Unit/socket matrix (raw TCP both sides, zero framework normalization)** — `cargo test -p freshell-server proxy` → **24/24, two consecutive runs** (0.59s, 0.65s). Covers: every-method forwarding; 11-case byte-exact raw path+query matrix (encoded slash/space/percent/question-mark, UTF-8, plus/repeated/empty query keys, trailing slash, bare root); duplicate `set-cookie` + duplicate request headers preserved in wire order; 3 MiB upload with original `content-length` (no 413, no chunked re-frame); signal-gated incremental CHUNKED UPLOAD arrival (deadlock-guaranteed, no sleeps); statuses 201/302/404/418 verbatim with 302 `location` (redirects never followed); legacy-exact 400/401/502 JSON; cookie auth; useful-header passthrough with host rewrite + hop-by-hop drop; signal-gated response DRIP streaming (client sees chunk 1 while upstream holds chunk 2); HEAD without body-hang; byte-exact pretty-JSON/binary bodies; gzip passthrough with `content-encoding` intact; real-binary wiring (see next).
- **Black-box mounted-app proof** — `cargo test -p freshell-server --test browser01_proxy` → **1/1, two consecutive runs** (~0.25s each). Boots the REAL `freshell-server` binary (diag01 pattern), drives raw-socket GET (three-blocker strip, multi `set-cookie` + `content-length` survive the real rate-limit/charset layers) + POST (`/a%2Fb/c%20d?q=%2F&n=1+2` byte-exact) + 400/401/502 shapes.
- **Frozen-legacy control (scoped vitest)** — `npm run test:vitest -- run test/unit/server/proxy-router.test.ts` → **209/209 passed across 11 matched files** (legacy tree untouched, stays green).
- **Typecheck** — `npx tsc -p tsconfig.json --noEmit` ✓, `npx tsc -p tsconfig.server.json --noEmit` ✓, spec-attributed errors `npx tsc -p test/e2e-browser/tsconfig.browser01-check.json` → **0** · `cargo fmt --check` ✓ · `cargo clippy -p freshell-server --all-targets` **0 warnings**.

## Playwright spec (authored; probe-run classification)

`test/e2e-browser/specs/browser01-proxy.spec.ts`, registered in `MATRIX_SPECS` (one additive line — the ONLY shared-file edit). In-spec fixture serves an interactive page under `X-Frame-Options: DENY` + `CSP frame-ancestors 'none'` (+CSP-RO): renders in the Browser pane ONLY if exactly those headers are stripped. Through `frameLocator`: GET form → browser-visible `RAW:url=/query-submit?q=a%2Fb%2Bc+d`; POST form → browser-visible `POST-RECEIVED:message=hello+world&sigil=P%25ss%2F%26%3D%3F`; `fetch` echo → `"url":"/api/echo?x=%2F&plus=1+2"` + `sawCookie:true`; streaming route → `STREAM-FIRST;` visible then `STREAM-FIRST;STREAM-SECOND;`. Upstream capture assertions pin the exact raw inputs (incl. `freshell-auth` cookie on the iframe navigation).

Per-leg probe outcomes (pw lease, one probe per leg + confirmation):
- **legacy-chromium:** PASS ×2 (1.1m cold incl. client build; 30.4s warm) — true parity control, identical assertions green on legacy.
- **rust-chromium:** run 1 FAIL — cold-start artifact: the release-profile `freshell-server` build (`ensureRustServerBuilt`) exceeded the per-test window on first touch (same documented cold-run pattern as SAFE-01's annotation); runs 2–3 PASS (35.4s, 29.2s) with the current-branch binary. Classified environmental, not a spec/product failure.

## Review loop (2 rounds; Task-tool subagent unavailable in this environment → recorded structured fresh-eyes self-review fallback per dispatch)

- **Round 1 (product diff):** one finding — `[P3, pre-existing]` reqwest's builder defaults to system-proxy autodetection (`HTTP_PROXY`/`HTTPS_PROXY`), which could shunt the always-loopback upstream through an env proxy; legacy Node's `http.request` never consults env proxies. **Fixed:** `.no_proxy()` on the client builder (+comment), commit `review round 1`. No P0/P1/P2 findings in the G1–G4 diff.
- **Round 2 (test harness + spec):** one finding — the black-box test could orphan the spawned `freshell-server` on a panicking assert (std `Child` doesn't kill on drop). **Fixed:** kill-on-drop `ChildGuard`, commit `review round 2`. Spec + MATRIX registration + tsconfig gate reviewed clean.
- Loop closed: no remaining serious findings.

**Final verification at head `32301f6de`:** cargo proxy 24/24 · black-box 1/1 (×2 consecutive incl. earlier runs) · clippy 0 warnings · `cargo fmt --check` clean · spec-attributed tsc errors 0 · control vitest 209/209 · PW legacy PASS (30.3s) · PW rust PASS (55.4s, warm binary).

## What this item does NOT cover (owned by siblings)

- `BROWSER-02` WS-upgrade proxying (legacy `attachProxyUpgradeHandler`, `proxy-router.ts:144–219`) — separate item, untouched.
- `BROWSER-03/04` `/api/proxy/forward` TCP port-forward + destination/requester restrictions — `proxy.rs`'s module doc already scopes them out; unchanged.
- `BROWSER-05` failure/retry UI + screenshot determinism — client-side; untouched.

## Files

- `crates/freshell-server/src/proxy.rs` — the four fixes (~25 LOC of product change) + `wire_support` raw-socket fixtures + `lb_probes` + `socket_contract*` (24 tests).
- `crates/freshell-server/tests/browser01_proxy.rs` — black-box mounted-app proof (new).
- `test/e2e-browser/specs/browser01-proxy.spec.ts` + `tsconfig.browser01-check.json` (new); `playwright.config.ts` (one additive MATRIX_SPECS line).
- `docs/plans/df1/BROWSER-01.md` — plan + load-bearing ledger (new).

## GREEN COMMANDS (verifier: re-run at head SHA)

```bash
nice -n 19 cargo test -p freshell-server proxy
nice -n 19 cargo test -p freshell-server --test browser01_proxy
nice -n 19 cargo clippy -p freshell-server --all-targets
nice -n 19 cargo fmt -p freshell-server -- --check
npx tsc -p test/e2e-browser/tsconfig.browser01-check.json      # require: 0 lines attributed to specs/browser01-proxy.spec.ts
npm run test:vitest -- run test/unit/server/proxy-router.test.ts
nice -n 19 npx playwright test --config test/e2e-browser/playwright.config.ts specs/browser01-proxy.spec.ts --project=legacy-chromium --workers=1
nice -n 19 npx playwright test --config test/e2e-browser/playwright.config.ts specs/browser01-proxy.spec.ts --project=rust-chromium --workers=1
```
