#!/usr/bin/env node
/**
 * Export recovered Playwright retry evidence as bounded structured log entries.
 *
 * Cloud Run discards a task filesystem after it exits. Cloud Logging retains
 * stdout, so retry-only failures need their first failure stack and the trace
 * archive copied there before a successful retry can hide the evidence.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const MAX_TRACE_BYTES = 8 * 1024 * 1024
const TRACE_CHUNK_BYTES = 120 * 1024
const MAX_ERROR_TEXT_BYTES = 64 * 1024

const [reportPath] = process.argv.slice(2)

if (!reportPath) {
  throw new Error('usage: e2e-cloud-retry-receipt.mjs <playwright-json-report>')
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const execution = process.env.CLOUD_RUN_EXECUTION ?? 'unknown-execution'
const taskIndex = Number.parseInt(process.env.CLOUD_RUN_TASK_INDEX ?? '0', 10)
const taskCount = Number.parseInt(process.env.CLOUD_RUN_TASK_COUNT ?? '1', 10)

function emit(entry) {
  process.stdout.write(`${JSON.stringify(entry)}\n`)
}

function boundedText(value) {
  const text = typeof value === 'string' ? value : ''
  const bytes = Buffer.byteLength(text)
  if (bytes <= MAX_ERROR_TEXT_BYTES) return { text, truncated: false }
  return {
    text: Buffer.from(text).subarray(0, MAX_ERROR_TEXT_BYTES).toString('utf8'),
    truncated: true,
  }
}

function errorEvidence(result) {
  const error = result.errors?.[0] ?? result.error ?? {}
  const message = boundedText(error.message)
  const stack = boundedText(error.stack ?? error.message)
  return {
    message: message.text,
    stack: stack.text,
    truncated: message.truncated || stack.truncated,
  }
}

function specsIn(suites) {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []),
    ...specsIn(suite.suites ?? []),
  ])
}

function traceAttachments(results) {
  return results.flatMap((result) => (result.attachments ?? []).filter((attachment) => (
    attachment.name === 'trace' || attachment.contentType === 'application/zip'
  )))
}

function artifactIdFor({ spec, test, attempt, traceIndex }) {
  const seed = [execution, taskIndex, spec.file ?? '', spec.line ?? 0, spec.title ?? '', test.projectName ?? '', attempt, traceIndex].join('\u0000')
  return `playwright-retry-trace-${createHash('sha256').update(seed).digest('hex').slice(0, 20)}`
}

function emitTrace({ attachment, artifactId }) {
  if (!attachment.path) {
    return { storage: 'cloud-logging-jsonl-chunks', artifactId, retained: false, reason: 'reporter attachment has no file path' }
  }

  let trace
  try {
    trace = readFileSync(attachment.path)
  } catch (error) {
    return {
      storage: 'cloud-logging-jsonl-chunks',
      artifactId,
      retained: false,
      reason: `could not read retry trace: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (trace.length > MAX_TRACE_BYTES) {
    return {
      storage: 'cloud-logging-jsonl-chunks',
      artifactId,
      retained: false,
      bytes: trace.length,
      maxBytes: MAX_TRACE_BYTES,
      reason: 'retry trace exceeds bounded Cloud Logging retention limit',
    }
  }

  const chunkCount = Math.max(1, Math.ceil(trace.length / TRACE_CHUNK_BYTES))
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * TRACE_CHUNK_BYTES
    const end = Math.min(start + TRACE_CHUNK_BYTES, trace.length)
    emit({
      severity: 'WARNING',
      event: 'e2e_playwright_retry_trace_chunk',
      execution,
      taskIndex,
      taskCount,
      artifactId,
      chunkIndex,
      chunkCount,
      encoding: 'base64',
      data: trace.subarray(start, end).toString('base64'),
    })
  }

  return {
    storage: 'cloud-logging-jsonl-chunks',
    artifactId,
    retained: true,
    bytes: trace.length,
    sha256: createHash('sha256').update(trace).digest('hex'),
    chunkCount,
    encoding: 'base64',
  }
}

for (const spec of specsIn(report.suites ?? [])) {
  for (const test of spec.tests ?? []) {
    const results = test.results ?? []
    const firstFailure = results.find((result) => result.status === 'failed' || result.status === 'timedOut')
    const recovered = firstFailure && results.some((result) => result.status === 'passed' && result.retry > firstFailure.retry)
    if (!recovered) continue

    const traces = traceAttachments(results)
    const trace = traces.length > 0
      ? emitTrace({
        attachment: traces[0],
        artifactId: artifactIdFor({ spec, test, attempt: firstFailure.retry, traceIndex: 0 }),
      })
      : {
        storage: 'cloud-logging-jsonl-chunks',
        retained: false,
        reason: 'Playwright report contained no trace attachment for the recovered retry',
      }

    emit({
      severity: 'WARNING',
      event: 'e2e_playwright_retry_evidence',
      execution,
      taskIndex,
      taskCount,
      attempt: firstFailure.retry,
      test: {
        file: spec.file ?? '',
        line: spec.line ?? 0,
        title: spec.title ?? '',
        project: test.projectName ?? '',
      },
      error: errorEvidence(firstFailure),
      trace,
    })
  }
}
