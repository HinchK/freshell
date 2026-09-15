#!/usr/bin/env node
/** Validate the task-completion and retry-evidence JSON entries from Cloud Logging. */
import { readFileSync } from 'node:fs'

const [execution, expectedTaskCountText] = process.argv.slice(2)
const expectedTaskCount = Number.parseInt(expectedTaskCountText ?? '', 10)

if (!execution || !Number.isInteger(expectedTaskCount) || expectedTaskCount < 1) {
  throw new Error('usage: e2e-cloud-structured-receipts.mjs <execution> <expected-task-count>')
}

const entries = JSON.parse(readFileSync(0, 'utf8'))
if (!Array.isArray(entries)) throw new Error('Cloud Logging response must be a JSON array')

const payloads = entries.map((entry, index) => {
  const payload = entry?.jsonPayload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Cloud Logging entry ${index} has no jsonPayload object`)
  }
  return payload
})

const completions = payloads.filter((payload) => payload.event === 'e2e_playwright_task_complete')
const retryEvidence = payloads.filter((payload) => payload.event === 'e2e_playwright_retry_evidence')

if (completions.length !== expectedTaskCount) {
  throw new Error(`expected ${expectedTaskCount} task completion receipt(s), found ${completions.length}`)
}

const taskIndexes = new Set()
const recoveredRetryCountByTask = new Map()
let recoveredRetryCount = 0
for (const completion of completions) {
  if (completion.execution !== execution || completion.taskCount !== expectedTaskCount
    || !Number.isInteger(completion.taskIndex) || completion.taskIndex < 0 || completion.taskIndex >= expectedTaskCount
    || !Number.isInteger(completion.recoveredRetryCount) || completion.recoveredRetryCount < 0) {
    throw new Error('task completion receipt has invalid execution, task identity, or retry count')
  }
  if (taskIndexes.has(completion.taskIndex)) throw new Error(`duplicate task completion receipt for task ${completion.taskIndex}`)
  taskIndexes.add(completion.taskIndex)
  recoveredRetryCountByTask.set(completion.taskIndex, completion.recoveredRetryCount)
  recoveredRetryCount += completion.recoveredRetryCount
}

for (let taskIndex = 0; taskIndex < expectedTaskCount; taskIndex += 1) {
  if (!taskIndexes.has(taskIndex)) throw new Error(`missing task completion receipt for task ${taskIndex}`)
}

const retryEvidenceCountByTask = new Map()
for (const evidence of retryEvidence) {
  if (evidence.execution !== execution || evidence.taskCount !== expectedTaskCount
    || !Number.isInteger(evidence.taskIndex) || evidence.taskIndex < 0 || evidence.taskIndex >= expectedTaskCount
    || !Number.isInteger(evidence.failureAttempt) || evidence.failureAttempt < 0
    || !evidence.error || typeof evidence.error.stack !== 'string'
    || !evidence.trace || typeof evidence.trace !== 'object'
    || evidence.trace.traceAttempt !== evidence.failureAttempt) {
    throw new Error('retry evidence has invalid task identity or failure/trace association')
  }
  retryEvidenceCountByTask.set(evidence.taskIndex, (retryEvidenceCountByTask.get(evidence.taskIndex) ?? 0) + 1)
}

for (let taskIndex = 0; taskIndex < expectedTaskCount; taskIndex += 1) {
  const expectedEvidenceCount = recoveredRetryCountByTask.get(taskIndex)
  const actualEvidenceCount = retryEvidenceCountByTask.get(taskIndex) ?? 0
  if (actualEvidenceCount !== expectedEvidenceCount) {
    throw new Error(`task ${taskIndex} completion reports ${expectedEvidenceCount} recovered retry/retries but found ${actualEvidenceCount} evidence record(s)`)
  }
}

process.stdout.write(`${JSON.stringify({
  execution,
  taskCount: expectedTaskCount,
  recoveredRetryCount,
  retryEvidence,
})}\n`)
