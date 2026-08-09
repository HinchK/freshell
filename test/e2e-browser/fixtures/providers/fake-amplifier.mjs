#!/usr/bin/env node
// HARNESS-03 deterministic fake `amplifier` terminal CLI. Same engine as the
// other terminal fixtures; only the launch-argv detection differs: the real
// amplifier resume shape is `session resume --full-history <id>` with the id
// LAST (fake-amplifier-cli.mjs:70-73), so `--resume` semantics would be wrong
// here.
import { runTerminalCli, defaultDetectLaunch } from './terminal-cli.mjs'

await runTerminalCli({
  provider: 'amplifier',
  detectLaunch: (argv, sessionId) =>
    argv[0] === 'session' && argv[1] === 'resume'
      ? { kind: 'resume', id: argv[argv.length - 1] ?? '' }
      : defaultDetectLaunch(argv, sessionId),
})
