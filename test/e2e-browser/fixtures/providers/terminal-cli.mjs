// HARNESS-03 — shared terminal-CLI adapter for the deterministic provider
// fixtures (claude / gemini / kimi / amplifier). Renders the engine's
// normalized events the way a real interactive provider CLI looks on a PTY:
//
//   launch     argv-driven identity: mirror of the existing e2e fakes
//              (`fake-claude-cli.mjs`, `fake-amplifier-cli.mjs`):
//                resume  -> "<provider>: resumed session <id>"     (+ resume event)
//                fresh with explicit id (e.g. claude --session-id)
//                        -> "<provider>: session <id> started"     (+ session event)
//                bare    -> just the prompt                       (+ session event, minted id)
//   prompt     "<provider>> " (the existing fakes' `claude> ` shape)
//   per stdin line ("a turn"): if a program rule matches the line it OWNS the
//              turn's event shape; otherwise the default pair fires: activity
//              "working on it..." -> completion as a BARE BEL + "turn done."
//              (the LEADING-BEL chunk the turn-complete tracker consumes,
//              fake-bel-cli.mjs / shared/turn-complete-signal.ts semantics).
//   approval/question -> deterministic greppable single lines that read like
//              the real CLIs' permission/elicitation prompts.
//   crash      the process exits with the scripted code (the wire signal IS
//              the exit; the ledger already holds the crash event).
import { randomUUID } from 'node:crypto'
import {
  appendLaunchLedger,
  FixtureEngine,
  keepAlive,
  lineDriver,
  loadProgram,
} from './fixture-core.mjs'

/** Default launch detection: `--resume <id>` anywhere; `--session-id <id>` as an explicit fresh id. */
export function defaultDetectLaunch(argv, sessionId) {
  const resumeIdx = argv.indexOf('--resume')
  if (resumeIdx !== -1) return { kind: 'resume', id: argv[resumeIdx + 1] ?? '' }
  const sessionIdx = argv.indexOf('--session-id')
  if (sessionIdx !== -1) return { kind: 'fresh', id: argv[sessionIdx + 1] ?? sessionId }
  return { kind: 'fresh', id: sessionId, silent: true }
}

function renderTerminalEvent(provider, event) {
  const { kind, data } = event
  switch (kind) {
    case 'session':
      if (!data.silent) process.stdout.write(`${provider}: session ${data.id} started\r\n`)
      break
    case 'resume':
      process.stdout.write(`${provider}: resumed session ${data.id}\r\n`)
      break
    case 'activity':
      process.stdout.write(`${data.text ?? 'working on it...'}\r\n`)
      break
    case 'approval':
      process.stdout.write(
        `approval requested [${data.id}] ${data.tool ?? 'tool'}: ${data.input ?? ''} (y/n)\r\n`,
      )
      break
    case 'question':
      process.stdout.write(`question [${data.id}] ${data.text ?? ''}\r\n`)
      break
    case 'completion':
      // Bare BEL first (tracker-eligible leading BEL), then the done marker —
      // written as one chunk pair exactly like fake-bel-cli.mjs.
      process.stdout.write('\x07')
      process.stdout.write(`${data.text ?? 'turn done.'}\r\n`)
      break
    case 'marker':
      process.stdout.write(`${data.text ?? ''}\r\n`)
      break
    case 'crash':
      process.stdout.write(`${provider}: simulated crash\r\n`)
      break
    default:
      break
  }
}

/**
 * @param {{ provider: string,
 *           detectLaunch?: (argv: string[], sessionId: string) => object }} opts
 */
export async function runTerminalCli({ provider, detectLaunch = defaultDetectLaunch }) {
  const argv = process.argv.slice(2)
  const env = process.env
  appendLaunchLedger({ provider, argv, env })
  const program = loadProgram(env)
  const sessionId = program.sessionId ?? randomUUID()

  const engine = new FixtureEngine({
    provider,
    program,
    env,
    write: (event) => renderTerminalEvent(provider, event),
  })

  const launch = detectLaunch(argv, sessionId)
  if (launch.kind === 'resume') {
    await engine.emitResume(launch.id)
  } else {
    // Bare launches print only the prompt (the existing fakes' behavior);
    // the session identity still lands in the event ledger. An explicit id
    // prints the "<provider>: session <id> started" marker (fake-claude-cli).
    await engine.emitEvent('session', { id: launch.id, silent: Boolean(launch.silent) }, 'argv')
  }
  process.stdout.write(`${provider}> \r\n`)

  await engine.start()

  lineDriver(async (line) => {
    // A matching rule OWNS the turn (its author controls the full event
    // shape); the canned busy->BEL completion pair is the default only for
    // lines no rule matched.
    const emitted = await engine.handleStdinLine(line)
    if (emitted.size === 0) {
      await engine.emitEvent('activity', { state: 'busy' }, 'stdin:default')
      await engine.emitEvent('completion', { subtype: 'success' }, 'stdin:default')
    }
  })
  keepAlive()
}
