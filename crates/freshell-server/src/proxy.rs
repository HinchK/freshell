//! The browser-pane HTTP reverse proxy (Phase 3.18).
//!
//! Ports the HTTP half of `server/proxy-router.ts` (`router.use('/http/:port')`,
//! line 84): a same-origin reverse proxy for **loopback** URLs the SPA's
//! `BrowserPane` renders inside its iframe. The pane rewrites a
//! `http://localhost:<port>/<path>` URL to `/api/proxy/http/<port>/<path>`
//! (`src/components/panes/BrowserPane.tsx#buildHttpProxyUrl`, line 110) so the
//! iframe stays same-origin with Freshell. The proxy then **strips the
//! iframe-blocking response headers** (`X-Frame-Options`,
//! `Content-Security-Policy`, `Content-Security-Policy-Report-Only` —
//! `proxy-router.ts:19`) so dev servers that would otherwise refuse to be framed
//! render, and the screenshot chain can reach their content.
//!
//! ## Faithful behaviour (matches `proxy-router.ts`)
//! * Target is always `127.0.0.1:<port>` (never a remote host).
//! * `<port>` must be `1..=65535`, else `400 { error: "Invalid port number" }`.
//! * The upstream request carries the incoming method + body and the incoming
//!   headers minus hop-by-hop framing (`host` is set to the target;
//!   `connection` / `transfer-encoding` are dropped — `proxy-router.ts:90-93`).
//! * The response echoes the upstream status + headers **minus** the three
//!   iframe-blocking headers (and minus the framing headers `hyper` recomputes),
//!   streaming the body through unchanged.
//! * An upstream connection failure is `502 { error: "Failed to connect to
//!   localhost:<port>" }` (`proxy-router.ts:113`).
//!
//! ## Auth
//! Gated exactly like the original: the proxy is mounted under `/api`, behind
//! `server/auth.ts#httpAuthMiddleware`. The iframe navigates same-origin, so the
//! browser sends the `freshell-auth` cookie the SPA set (`src/lib/auth.ts:14`);
//! [`crate::boot::is_authed`] accepts that cookie (or the `x-auth-token` header).
//!
//! Everything here is ADDITIVE port code; no `server/` or `shared/` is touched.
//! The `/api/proxy/forward` TCP port-forward + the WS-upgrade proxy (remote-only
//! paths that require `netsh`/socket relay) are intentionally NOT ported here —
//! they are unused by the loopback e2e and are a later, safety-gated step.

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use serde_json::json;

/// Response headers that prevent iframe embedding — stripped so proxied content
/// renders (`proxy-router.ts#IFRAME_BLOCKED_HEADERS`, line 19).
const IFRAME_BLOCKED_HEADERS: [&str; 3] = [
    "x-frame-options",
    "content-security-policy",
    "content-security-policy-report-only",
];

/// Hop-by-hop / framing response headers `hyper` recomputes for the outgoing
/// response; forwarding them verbatim alongside a streamed body would double-frame.
const HOP_BY_HOP_RESPONSE_HEADERS: [&str; 4] = [
    "connection",
    "transfer-encoding",
    "content-length",
    "keep-alive",
];

/// Request headers dropped before forwarding upstream (`proxy-router.ts:91-93`:
/// `host` is rewritten to the target; `connection`/`transfer-encoding` dropped).
const STRIPPED_REQUEST_HEADERS: [&str; 3] = ["host", "connection", "transfer-encoding"];

/// Shared, cheaply-cloneable state for the proxy surface.
#[derive(Clone)]
pub struct ProxyState {
    /// The required auth token (`AUTH_TOKEN`) — the gate for every route here.
    pub auth_token: Arc<String>,
    /// A shared, connection-pooling loopback HTTP client (redirects disabled so
    /// the iframe sees the target's real 3xx, matching Node's `http.request`).
    pub client: reqwest::Client,
}

impl ProxyState {
    /// Build the proxy state with a loopback-only reqwest client.
    pub fn new(auth_token: Arc<String>) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default();
        Self { auth_token, client }
    }
}

/// The proxy sub-router, pre-bound to its state (mergeable into the app).
///
/// A single catch-all mirrors Express's `router.use('/http/:port')` prefix match:
/// it serves the bare `/api/proxy/http/<port>`, the common trailing-slash form the
/// SPA emits (`/api/proxy/http/<port>/`, since `BrowserPane` always appends at
/// least `pathname="/"`, `BrowserPane.tsx:122`), and any deeper
/// `/api/proxy/http/<port>/<path…>`. Parsing the `<port>` off the tail ourselves
/// avoids axum's catch-all requiring a non-empty tail segment.
pub fn router(state: ProxyState) -> Router {
    Router::new()
        .route("/api/proxy/http/{*tail}", any(proxy))
        .with_state(state)
}

/// `/api/proxy/http/{*tail}` where `tail` is `<port>` or `<port>/<path…>`.
async fn proxy(
    State(state): State<ProxyState>,
    Path(tail): Path<String>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: axum::body::Bytes,
) -> Response {
    // Split `<port>` off the front; the remainder (possibly empty) is the upstream
    // path. `5173` → ("5173",""); `5173/` → ("5173",""); `5173/a/b` → ("5173","a/b").
    let (port_raw, rest) = match tail.split_once('/') {
        Some((port, rest)) => (port, rest),
        None => (tail.as_str(), ""),
    };
    forward(
        state,
        port_raw.to_string(),
        rest.to_string(),
        method,
        headers,
        uri,
        body,
    )
    .await
}

/// The shared forward path.
async fn forward(
    state: ProxyState,
    port_raw: String,
    rest: String,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: axum::body::Bytes,
) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }

    // Validate the port exactly like the original (`Number.isInteger` + 1..=65535).
    let target_port: u32 = match port_raw.parse::<u32>() {
        Ok(p) if (1..=65535).contains(&p) => p,
        _ => return bad_request("Invalid port number"),
    };

    // Build the upstream URL: http://127.0.0.1:<port>/<rest>?<query>.
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let target_url = format!("http://127.0.0.1:{target_port}/{rest}{query}");

    // Convert the incoming method + headers to the upstream request. `host` is set
    // by reqwest to the target; hop-by-hop framing headers are dropped.
    let mut req = state.client.request(method, &target_url);
    let mut fwd_headers = HeaderMap::new();
    for (name, value) in headers.iter() {
        if STRIPPED_REQUEST_HEADERS.contains(&name.as_str()) {
            continue;
        }
        fwd_headers.insert(name.clone(), value.clone());
    }
    req = req.headers(fwd_headers);
    if !body.is_empty() {
        req = req.body(body);
    }

    let upstream = match req.send().await {
        Ok(resp) => resp,
        Err(_) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("Failed to connect to localhost:{target_port}") })),
            )
                .into_response();
        }
    };

    // Rebuild the response: same status, headers minus the iframe-blockers and the
    // framing headers hyper recomputes, streaming the body through unchanged.
    let status = upstream.status();
    let mut out_headers = HeaderMap::new();
    for (name, value) in upstream.headers().iter() {
        let lname = name.as_str().to_ascii_lowercase();
        if IFRAME_BLOCKED_HEADERS.contains(&lname.as_str())
            || HOP_BY_HOP_RESPONSE_HEADERS.contains(&lname.as_str())
        {
            continue;
        }
        if let (Ok(hn), Ok(hv)) = (
            HeaderName::from_bytes(name.as_ref()),
            HeaderValue::from_bytes(value.as_ref()),
        ) {
            out_headers.insert(hn, hv);
        }
    }

    let body = Body::from_stream(upstream.bytes_stream());
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = out_headers;
    response
}

/// `401 { "error": "Unauthorized" }` — byte-shape-equal to the original's reject.
fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Unauthorized" })),
    )
        .into_response()
}

/// `400 { "error": <msg> }` — the original's invalid-port reject shape.
fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iframe_blocked_headers_are_the_original_set() {
        // The three headers the original strips (case-insensitive).
        assert!(IFRAME_BLOCKED_HEADERS.contains(&"x-frame-options"));
        assert!(IFRAME_BLOCKED_HEADERS.contains(&"content-security-policy"));
        assert!(IFRAME_BLOCKED_HEADERS.contains(&"content-security-policy-report-only"));
    }

    #[test]
    fn port_validation_matches_original_bounds() {
        for (raw, ok) in [
            ("0", false),
            ("1", true),
            ("65535", true),
            ("65536", false),
            ("-1", false),
            ("abc", false),
            ("", false),
        ] {
            let parsed = raw.parse::<u32>().ok().filter(|p| (1..=65535).contains(p));
            assert_eq!(parsed.is_some(), ok, "port {raw:?}");
        }
    }

    #[test]
    fn tail_splits_port_from_path() {
        // The single catch-all parses `<port>` off the front; the remainder is the
        // upstream path. Covers the SPA's common trailing-slash form.
        let cases = [
            ("5173", "5173", ""),
            ("5173/", "5173", ""),
            ("5173/index.html", "5173", "index.html"),
            ("8080/assets/a.js", "8080", "assets/a.js"),
        ];
        for (tail, port, rest) in cases {
            let (p, r) = match tail.split_once('/') {
                Some((p, r)) => (p, r),
                None => (tail, ""),
            };
            assert_eq!(p, port, "tail {tail:?}");
            assert_eq!(r, rest, "tail {tail:?}");
        }
    }

    #[test]
    fn target_url_composes_path_and_query() {
        // rest has no leading slash (axum strips it); query carries the `?`.
        let rest = "index.html";
        let query = "?v=1";
        assert_eq!(
            format!("http://127.0.0.1:{}/{}{}", 5173u32, rest, query),
            "http://127.0.0.1:5173/index.html?v=1"
        );
        // Bare root (no rest, no query).
        assert_eq!(
            format!("http://127.0.0.1:{}/{}{}", 8080u32, "", ""),
            "http://127.0.0.1:8080/"
        );
    }
}

// ── Load-bearing probes (BROWSER-01, `docs/plans/df1/BROWSER-01.md`) ─────────
//
// One-shot EMPIRICAL validations of the assumptions the BROWSER-01 design
// rests on (plan §L1..L5). They deliberately probe framework behavior
// (axum routing/extraction, `http::HeaderMap`, reqwest body handling) rather
// than proxy correctness — the durable contract tests live in
// `mod socket_contract`. Raw sockets everywhere: no framework client/server
// on either side of the wire, so nothing normalizes the bytes being proven.
#[cfg(test)]
mod lb_probes {
    use super::*;

    const TEST_TOKEN: &str = "lb-probe-token-0123456789abcdef";

    // ── Raw-wire helpers ────────────────────────────────────────────────────

    /// One side of a raw TCP conversation plus a read-ahead buffer, so a
    /// single `read()` that straddles the head/body boundary loses nothing.
    struct Wire {
        stream: tokio::net::TcpStream,
        buf: Vec<u8>,
    }

    fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
        if needle.is_empty() || hay.len() < needle.len() {
            return None;
        }
        hay.windows(needle.len()).position(|w| w == needle)
    }

    /// Parse `\r\n`-terminated head bytes into (first line, ordered headers).
    /// Duplicate headers are preserved in wire order.
    fn parse_head(raw: &[u8]) -> (String, Vec<(String, String)>) {
        let text = String::from_utf8_lossy(raw);
        let mut lines = text.split("\r\n");
        let first = lines.next().unwrap_or("").to_string();
        let headers = lines
            .take_while(|l| !l.is_empty())
            .filter_map(|l| {
                l.split_once(':')
                    .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
            })
            .collect();
        (first, headers)
    }

    fn header_values<'a>(
        headers: &'a [(String, String)],
        name: &'a str,
    ) -> impl Iterator<Item = &'a str> {
        headers
            .iter()
            .filter(move |(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    impl Wire {
        fn new(stream: tokio::net::TcpStream) -> Self {
            Self {
                stream,
                buf: Vec::new(),
            }
        }

        async fn write_all(&mut self, bytes: &[u8]) {
            use tokio::io::AsyncWriteExt;
            self.stream.write_all(bytes).await.unwrap();
        }

        /// Read until `needle` (inclusive) and return it, retaining any
        /// over-read bytes in the buffer.
        async fn read_until(&mut self, needle: &[u8]) -> Vec<u8> {
            use tokio::io::AsyncReadExt;
            loop {
                if let Some(pos) = find_subslice(&self.buf, needle) {
                    let end = pos + needle.len();
                    return self.buf.drain(..end).collect();
                }
                let mut tmp = [0u8; 8192];
                let n = self.stream.read(&mut tmp).await.unwrap();
                if n == 0 {
                    return std::mem::take(&mut self.buf);
                }
                self.buf.extend_from_slice(&tmp[..n]);
            }
        }

        async fn read_n(&mut self, n: usize) -> Vec<u8> {
            use tokio::io::AsyncReadExt;
            while self.buf.len() < n {
                let mut tmp = [0u8; 8192];
                let r = self.stream.read(&mut tmp).await.unwrap();
                if r == 0 {
                    break;
                }
                self.buf.extend_from_slice(&tmp[..r]);
            }
            let take = self.buf.len().min(n);
            self.buf.drain(..take).collect()
        }

        async fn read_to_eof(&mut self) -> Vec<u8> {
            use tokio::io::AsyncReadExt;
            let mut tmp = [0u8; 8192];
            loop {
                match self.stream.read(&mut tmp).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => self.buf.extend_from_slice(&tmp[..n]),
                }
            }
            std::mem::take(&mut self.buf)
        }

        /// Read one RFC 7230 chunked body (with optional trailer lines) and
        /// return the reassembled payload.
        async fn read_chunked(&mut self) -> Vec<u8> {
            let mut body = Vec::new();
            loop {
                let size_line = self.read_until(b"\r\n").await;
                let size_text = String::from_utf8_lossy(&size_line);
                let size_text = size_text.trim();
                let size = usize::from_str_radix(
                    size_text.split(';').next().unwrap_or("").trim(),
                    16,
                )
                .unwrap_or_else(|_| panic!("bad chunk size line {size_text:?}"));
                if size == 0 {
                    // Trailer lines until a bare CRLF (common case: none).
                    loop {
                        let line = self.read_until(b"\r\n").await;
                        if line == b"\r\n" {
                            break;
                        }
                    }
                    break;
                }
                body.extend_from_slice(&self.read_n(size).await);
                let crlf = self.read_n(2).await;
                assert_eq!(crlf, b"\r\n", "chunk terminator");
            }
            body
        }
    }

    /// A request as captured verbatim by the raw upstream fixture.
    #[derive(Debug, Default)]
    struct CapturedRequest {
        request_line: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl CapturedRequest {
        fn raw_target(&self) -> &str {
            self.request_line.split(' ').nth(1).unwrap_or("")
        }
        fn header_values<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> {
            header_values(&self.headers, name)
        }
    }

    /// Read one full request (head + framed body) from a wire.
    async fn read_request(wire: &mut Wire) -> CapturedRequest {
        let head = wire.read_until(b"\r\n\r\n").await;
        let (request_line, headers) = parse_head(&head);
        let body = if header_values(&headers, "transfer-encoding").any(|v| v.contains("chunked")) {
            wire.read_chunked().await
        } else if let Some(cl) = header_values(&headers, "content-length").next() {
            wire.read_n(cl.parse().expect("content-length integer")).await
        } else {
            Vec::new()
        };
        CapturedRequest {
            request_line,
            headers,
            body,
        }
    }

    /// A full response as captured on the client side.
    #[derive(Debug)]
    struct RawResponse {
        status_line: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl RawResponse {
        fn status_code(&self) -> u16 {
            self.status_line
                .split(' ')
                .nth(1)
                .and_then(|c| c.parse().ok())
                .expect("status code")
        }
        fn header_values<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> {
            header_values(&self.headers, name)
        }
    }

    /// Send verbatim request bytes and read the full framed response.
    async fn raw_exchange(port: u16, request: &[u8]) -> RawResponse {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            let mut wire = Wire::new(stream);
            wire.write_all(request).await;
            let head = wire.read_until(b"\r\n\r\n").await;
            let (status_line, headers) = parse_head(&head);
            let body = if header_values(&headers, "transfer-encoding").any(|v| v.contains("chunked"))
            {
                wire.read_chunked().await
            } else if let Some(cl) = header_values(&headers, "content-length").next() {
                wire.read_n(cl.parse().expect("content-length integer")).await
            } else {
                wire.read_to_eof().await
            };
            RawResponse {
                status_line,
                headers,
                body,
            }
        })
        .await
        .expect("exchange timed out")
    }

    /// Bind `127.0.0.1:0` synchronously (usable before the runtime schedules
    /// the accept loop) and spawn one task per accepted connection.
    fn spawn_raw_listener<F, Fut>(handler: F) -> u16
    where
        F: Fn(Wire) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let h = Arc::clone(&handler);
                tokio::spawn(async move { h(Wire::new(stream)).await });
            }
        });
        port
    }

    /// Spawn the REAL proxy router (production state constructor) on an
    /// ephemeral loopback port.
    async fn spawn_proxy() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = router(ProxyState::new(Arc::new(TEST_TOKEN.to_string())));
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            axum::serve(listener, app.into_make_service()).await.unwrap();
        });
        port
    }

    /// Spawn an arbitrary standalone axum router on an ephemeral port.
    async fn spawn_app(app: Router) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            axum::serve(listener, app.into_make_service()).await.unwrap();
        });
        port
    }

    /// Static client→proxy head for `path`. `connection: close` gives the
    /// response a deterministic EOF. Ends with the blank line that terminates
    /// the head. Callers append body bytes for body-bearing requests (with a
    /// matching `content-length` or chunked framing added to the head).
    fn proxy_head(port: u16, method: &str, upstream_port: u16, path_and_query: &str) -> Vec<u8> {
        format!(
            "{method} /api/proxy/http/{upstream_port}{path_and_query} HTTP/1.1\r\n\
             host: 127.0.0.1:{port}\r\n\
             x-auth-token: {TEST_TOKEN}\r\n\
             connection: close\r\n\r\n",
        )
        .into_bytes()
    }

    // ── L0 sanity: a plain GET passes through the proxy at all ────────────
    #[tokio::test]
    async fn l0_sanity_plain_get_through_proxy() {
        let upstream_port = spawn_raw_listener(move |mut wire| async move {
            let _req = read_request(&mut wire).await;
            wire.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello")
                .await;
        });
        let proxy_port = spawn_proxy().await;
        let resp = raw_exchange(proxy_port, &proxy_head(proxy_port, "GET", upstream_port, "/")).await;
        assert_eq!(resp.status_code(), 200);
        assert_eq!(resp.body, b"hello");
    }

    // ── L1: axum matches percent-ENCODED paths and `uri.path()` is raw ─────
    //
    // The G1 fix parses `<port>`/`<rest>` off the raw URI instead of the
    // decoded `Path<String>` catch-all. Load-bearing: if axum rejected encoded
    // paths at routing time or handed the handler a decoded URI, the fix would
    // have to move elsewhere entirely.
    #[tokio::test]
    async fn l1_route_matches_encoded_path_and_uri_path_is_raw() {
        let app = Router::new().route(
            "/api/proxy/http/{*tail}",
            any(|uri: Uri| async move { uri.path().to_string() }),
        );
        let port = spawn_app(app).await;
        let resp = raw_exchange(
            port,
            b"GET /api/proxy/http/5173/a%2Fb/c%20d?q=%2F HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n",
        )
        .await;
        assert_eq!(resp.status_code(), 200, "route must match an encoded path");
        assert_eq!(
            String::from_utf8(resp.body).unwrap(),
            "/api/proxy/http/5173/a%2Fb/c%20d",
            "uri.path() must be the RAW, undecoded path"
        );
    }

    // ── L2: `HeaderMap::insert` collapses; `append` preserves ──────────────
    //
    // Confirms G2's mechanism: the current proxy copies headers with
    // `insert`, which REPLACES all existing values (multi `Set-Cookie` dies).
    #[test]
    fn l2_headermap_insert_collapses_append_preserves() {
        let mut collapsed = HeaderMap::new();
        collapsed.insert(
            HeaderName::from_static("x-dupe"),
            HeaderValue::from_static("one"),
        );
        collapsed.insert(
            HeaderName::from_static("x-dupe"),
            HeaderValue::from_static("two"),
        );
        assert_eq!(
            collapsed.get_all("x-dupe").iter().count(),
            1,
            "insert REPLACES every existing value for the name"
        );

        let mut preserved = HeaderMap::new();
        preserved.append(
            HeaderName::from_static("x-dupe"),
            HeaderValue::from_static("one"),
        );
        preserved.append(
            HeaderName::from_static("x-dupe"),
            HeaderValue::from_static("two"),
        );
        let values: Vec<_> = preserved
            .get_all("x-dupe")
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect();
        assert_eq!(values, ["one", "two"], "append preserves order + values");
    }

    // ── L3: `Bytes` extraction is DefaultBodyLimit-capped; `Body` is not ────
    //
    // The G3 fix streams `axum::body::Body` instead of buffering `Bytes`.
    // Load-bearing: confirms the observed 413 mechanism and that extracting
    // `Body` directly really sidesteps the limit (no extra layer needed).
    #[tokio::test]
    async fn l3_bytes_extractor_hits_default_body_limit_body_extractor_does_not() {
        let big = vec![b'x'; 3 * 1024 * 1024];

        let bytes_app = Router::new().route(
            "/t",
            any(|body: axum::body::Bytes| async move { body.len().to_string() }),
        );
        let port = spawn_app(bytes_app).await;
        let mut req = format!(
            "POST /t HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            big.len()
        )
        .into_bytes();
        req.extend_from_slice(&big);
        let resp = raw_exchange(port, &req).await;
        assert_eq!(
            resp.status_code(),
            413,
            "Bytes extraction must hit axum's 2 MiB DefaultBodyLimit"
        );

        let body_app = Router::new().route(
            "/t",
            any(|body: Body| async move {
                let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
                bytes.len().to_string()
            }),
        );
        let port = spawn_app(body_app).await;
        let resp = raw_exchange(port, &req).await;
        assert_eq!(resp.status_code(), 200, "Body extraction is uncapped");
        assert_eq!(resp.body.len().to_string().len() > 0, true);
        assert_eq!(String::from_utf8(resp.body).unwrap(), big.len().to_string());
    }

    // ── L4: reqwest injects NO accept-encoding and performs NO decompression ─
    //
    // The proxy forwards whatever the client sent (gzip included) byte-exact.
    // Load-bearing: if reqwest auto-added `Accept-Encoding` or transparently
    // decompressed, forwarded `content-encoding` + body bytes would disagree.
    // (Cargo already shows `default-features=false` without compression
    // features; this probe proves the runtime behavior, not the manifest.)
    #[tokio::test]
    async fn l4_reqwest_no_accept_encoding_injection_and_no_decompression() {
        // Real gzip bytes of "proxied-gzip-payload-0123456789" (gzip -n).
        const GZIP: [u8; 51] = [
            0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x2b, 0x28, 0xca, 0xaf,
            0xc8, 0x4c, 0x4d, 0xd1, 0x4d, 0xaf, 0xca, 0x2c, 0xd0, 0x2d, 0x48, 0xac, 0xcc, 0xc9,
            0x4f, 0x4c, 0xd1, 0x35, 0x30, 0x34, 0x32, 0x36, 0x31, 0x35, 0x33, 0xb7, 0xb0, 0x04,
            0x00, 0x0d, 0xae, 0xc4, 0xd7, 0x1f, 0x00, 0x00, 0x00,
        ];
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cap = Arc::clone(&captured);
        let upstream_port = spawn_raw_listener(move |mut wire| {
            let cap = Arc::clone(&cap);
            async move {
                let req = read_request(&mut wire).await;
                cap.lock().await.push(req);
                let mut resp =
                    b"HTTP/1.1 200 OK\r\ncontent-encoding: gzip\r\ncontent-length: 51\r\n\r\n"
                        .to_vec();
                resp.extend_from_slice(&GZIP);
                wire.write_all(&resp).await;
            }
        });
        let proxy_port = spawn_proxy().await;
        // NOTE: the client deliberately sends NO accept-encoding.
        let resp = raw_exchange(proxy_port, &proxy_head(proxy_port, "GET", upstream_port, "/")).await;
        assert_eq!(resp.status_code(), 200);
        let got = captured.lock().await;
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0].header_values("accept-encoding").count(),
            0,
            "reqwest must NOT inject accept-encoding; got {:?}",
            got[0].headers
        );
        assert_eq!(
            resp.header_values("content-encoding").collect::<Vec<_>>(),
            vec!["gzip"],
            "content-encoding header must survive"
        );
        assert_eq!(
            resp.body,
            GZIP,
            "gzip body bytes must pass through untouched (no decompression)"
        );
    }

    // ── L5: reqwest honors an explicit content-length with a streamed body ──
    //
    // The G3 fix streams the incoming body via `Body::wrap_stream` while
    // forwarding the client's original `content-length` (legacy parity). If
    // reqwest overrode or ignored the explicit header, swe would fall back to
    // chunked (still spec-legal, but a parity wobble worth knowing upfront).
    #[tokio::test]
    async fn l5_wrap_stream_honors_explicit_content_length() {
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cap = Arc::clone(&captured);
        let upstream_port = spawn_raw_listener(move |mut wire| {
            let cap = Arc::clone(&cap);
            async move {
                let req = read_request(&mut wire).await;
                cap.lock().await.push(req);
                wire.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                    .await;
            }
        });

        let stream = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(
            axum::body::Bytes::from_static(b"hello world"),
        )]);
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("http://127.0.0.1:{upstream_port}/x"))
            .header("content-length", "11")
            .body(reqwest::Body::wrap_stream(stream))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let got = captured.lock().await;
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0].header_values("content-length").collect::<Vec<_>>(),
            vec!["11"],
            "explicit content-length must reach the wire; got {:?}",
            got[0].headers
        );
        assert_eq!(
            got[0].header_values("transfer-encoding").count(),
            0,
            "no chunked framing when content-length is known"
        );
        assert_eq!(got[0].body, b"hello world");
    }
}
