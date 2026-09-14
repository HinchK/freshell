import { afterEach, describe, expect, it } from 'vitest'
import type { Page } from '@playwright/test'
import {
  DEFAULT_WS_READY_TIMEOUT_MS,
  TestHarness,
  resolveWsReadyTimeoutMs,
} from './test-harness'

const ENV_VAR = 'FRESHELL_E2E_WS_READY_TIMEOUT_MS'

/**
 * A fake Page that records the full argument tuple of each waitForFunction
 * call. The tuple shape IS the contract under test: Playwright's
 * waitForFunction(pageFunction, arg, options) only honors a timeout passed
 * as the third argument. The historical two-arg call bound the timeout
 * object to the predicate's argument, making every explicit window
 * decorative (the real window was Playwright's 30s default — the j90s
 * load-bearing ledger, LB-1).
 */
function fakePage() {
  const calls: unknown[][] = []
  const page = {
    waitForFunction: (...args: unknown[]) => {
      calls.push(args)
      return Promise.resolve()
    },
  }
  return { page: page as unknown as Page, calls }
}

afterEach(() => {
  delete process.env[ENV_VAR]
})

describe('resolveWsReadyTimeoutMs', () => {
  it('defaults to the 30s window that preserves the historical real window when the env var is unset', () => {
    expect(resolveWsReadyTimeoutMs(undefined, {})).toBe(DEFAULT_WS_READY_TIMEOUT_MS)
    expect(DEFAULT_WS_READY_TIMEOUT_MS).toBe(30_000)
  })

  it('uses the env value when set and no explicit timeout is given', () => {
    expect(resolveWsReadyTimeoutMs(undefined, { [ENV_VAR]: '45000' })).toBe(45_000)
  })

  it('lets an explicit per-call timeout win over the env value', () => {
    expect(resolveWsReadyTimeoutMs(20_000, { [ENV_VAR]: '45000' })).toBe(20_000)
  })

  it('falls back to the default for empty, non-numeric, or non-positive env values', () => {
    expect(resolveWsReadyTimeoutMs(undefined, { [ENV_VAR]: '' })).toBe(DEFAULT_WS_READY_TIMEOUT_MS)
    expect(resolveWsReadyTimeoutMs(undefined, { [ENV_VAR]: 'abc' })).toBe(DEFAULT_WS_READY_TIMEOUT_MS)
    expect(resolveWsReadyTimeoutMs(undefined, { [ENV_VAR]: '0' })).toBe(DEFAULT_WS_READY_TIMEOUT_MS)
    expect(resolveWsReadyTimeoutMs(undefined, { [ENV_VAR]: '-5' })).toBe(DEFAULT_WS_READY_TIMEOUT_MS)
  })
})

describe('TestHarness.waitForConnection timeout wiring', () => {
  it('binds the default window (+1s slack) as waitForFunction OPTIONS', async () => {
    const { page, calls } = fakePage()
    await new TestHarness(page).waitForConnection()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(3)
    expect(calls[0][1]).toBeUndefined()
    expect(calls[0][2]).toEqual({ timeout: DEFAULT_WS_READY_TIMEOUT_MS + 1000 })
  })

  it('binds the env-scaled window as options when no explicit timeout is given', async () => {
    process.env[ENV_VAR] = '45000'
    const { page, calls } = fakePage()
    await new TestHarness(page).waitForConnection()
    expect(calls[0][1]).toBeUndefined()
    expect(calls[0][2]).toEqual({ timeout: 46_000 })
  })

  it('keeps an explicit timeout authoritative over the env var', async () => {
    process.env[ENV_VAR] = '45000'
    const { page, calls } = fakePage()
    await new TestHarness(page).waitForConnection(20_000)
    expect(calls[0][2]).toEqual({ timeout: 21_000 })
  })
})
