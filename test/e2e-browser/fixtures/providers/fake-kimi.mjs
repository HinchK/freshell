#!/usr/bin/env node
// HARNESS-03 deterministic fake `kimi` terminal CLI. Records argv/env to the
// launch ledger and renders the scripted event program (session, activity,
// approval, question, completion, crash, resume) per terminal-cli.mjs.
// Hermetic: never resolves or spawns a real provider binary.
import { runTerminalCli } from './terminal-cli.mjs'

await runTerminalCli({ provider: 'kimi' })
