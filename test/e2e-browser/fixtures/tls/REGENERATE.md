# HARNESS-06 test TLS assets — DO NOT TRUST

Committed, deliberately PUBLIC test-only key material for the trusted-HTTPS
fixture (TAURI-14 / BROWSER-03 lanes). The CA is named
`Freshell E2E Test CA (DO NOT TRUST)`; nothing on any real system should ever
add it to a trust store outside a throwaway test process. Committing the
private halves is safe **because these keys protect nothing** — their only
purpose is to be presented by fixture servers and verified (or rejected) by
fixture clients. Validity: 100 years from 2026-08-09 (never expires mid-test).

Files:
- `ca.key.pem` / `ca.cert.pem` — the throwaway test CA (CA:TRUE).
- `localhost.key.pem` / `localhost.cert.pem` — leaf signed by the CA;
  SAN `DNS:localhost, IP:127.0.0.1, IP:0:0:0:0:0:0:0:1`; `serverAuth` EKU.
- `untrusted.key.pem` / `untrusted.cert.pem` — an UNRELATED self-signed cert
  (the "untrusted certificate" negative leg: rejects even with the CA pinned).

Regenerate (from this directory, requires openssl ≥ 3.0):

```bash
openssl req -x509 -newkey rsa:2048 -sha256 -days 36500 -nodes \
  -subj "/CN=Freshell E2E Test CA (DO NOT TRUST)/O=Freshell Test Fixtures" \
  -keyout ca.key.pem -out ca.cert.pem \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"

openssl req -newkey rsa:2048 -nodes \
  -subj "/CN=localhost/O=Freshell Test Fixtures" \
  -keyout localhost.key.pem -out localhost.csr.pem
printf "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:0:0:0:0:0:0:0:1\n" > san.cnf
openssl x509 -req -in localhost.csr.pem -CA ca.cert.pem -CAkey ca.key.pem \
  -CAcreateserial -days 36500 -sha256 -extfile san.cnf -out localhost.cert.pem

openssl req -x509 -newkey rsa:2048 -sha256 -days 36500 -nodes \
  -subj "/CN=untrusted.fixture.invalid/O=DO NOT TRUST" \
  -keyout untrusted.key.pem -out untrusted.cert.pem

rm -f localhost.csr.pem san.cnf ca.cert.srl
```

Committed certs are used verbatim (no runtime openssl dependency): the loader
reads them with plain `fs`. Regeneration is only needed if the fixture policy
changes (e.g., new SANs); San values asserted by
`helpers/harness-06/https.test.ts` must then be updated in lockstep.
