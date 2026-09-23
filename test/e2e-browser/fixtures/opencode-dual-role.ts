import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// The serve role targets the DB-realistic dual-role fake (fake-opencode.cjs —
// corrected per the T2 validation: the originally sketched
// fake-opencode-server.mjs does not exist at this path, and the in-memory
// providers/fake-opencode-server.mjs is NOT usable through the Rust
// ServeManager). fake-opencode.cjs HAS /global/health (fake-opencode.cjs:716-719
// — the ServeManager health probe requires it, serve.rs:775-778), POST /session
// (durable ses_http_* rows in opencode.db), and the FAKE_OPENCODE_AUDIT_LOG
// ledger (launch/shutdown rows — the daemon-health assertion surface). It is
// the fake all 13 existing freshopencode Rust e2e specs point OPENCODE_CMD at.
export const FAKE_OPENCODE_SERVE = path.resolve(
  __dirname, 'fake-opencode.cjs',
)

/**
 * Install a DUAL-ROLE `opencode` binary into `binDir`: argv containing
 * `serve` routes to the fake serve daemon (HTTP+SSE); everything else execs
 * the given terminal fake (`terminalSource`, an .mjs path). Required by
 * kata b8ke's two-device OpenCode scenario: the shared `opencode serve`
 * daemon and the terminal `opencode` TUI are BOTH selected through
 * OPENCODE_CMD, so one shim must serve both roles.
 *
 * The dispatch key is the `serve` positional token (T2 probe-proven): the
 * serve lane always spawns `serve` as its first argument
 * (crates/freshell-opencode/src/transport.rs:229-237), while the terminal
 * lane's pinned argv goldens (G-O1/G-O3, cli_launch_goldens.rs) have NO
 * positional subcommand — `--port` appears in BOTH lanes and is NOT a
 * valid dispatch key.
 */
export async function installDualRoleOpencodeCli(
  binDir: string,
  terminalSource: string,
): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'opencode')
  const script = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const argv = process.argv.slice(2)
if (argv.includes('serve')) {
  const result = spawnSync(process.execPath, [${JSON.stringify(FAKE_OPENCODE_SERVE)}, ...argv], { stdio: 'inherit', env: process.env })
  process.exit(result.status ?? 1)
}
const result = spawnSync(process.execPath, [${JSON.stringify(terminalSource)}, ...argv], { stdio: 'inherit', env: process.env })
process.exit(result.status ?? 1)
`
  await fs.writeFile(target, script, 'utf-8')
  await fs.chmod(target, 0o755)
  return target
}
