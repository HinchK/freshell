import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import {
  ariaNamePattern,
  byRole,
  expectAccessible,
  focusByKeyboard,
} from '../helpers/accessible-interactions.js'
import { scanSource } from '../helpers/a11y-selector-gate.js'

/**
 * HARNESS-11 — accessibility selector gate, helper self-test.
 *
 * Checklist validation: "A helper self-test uses only roles/labels/keyboard
 * on existing main UI controls and deliberately fails on an inaccessible
 * fixture control."
 *
 * Three legs:
 *
 * - LEG A (green): drives REAL main UI controls using only role + accessible
 *   name + keyboard. Every interaction goes through the sanctioned helpers;
 *   this spec carries zero raw CSS selectors of its own.
 * - LEG B (red, captured): three deliberate failures against an
 *   intentionally INACCESSIBLE fixture control (a `<div onclick>`): the
 *   role+name assertion rejects, keyboard focus can never land on it, and
 *   name-less role selection throws synchronously. Each failure is captured
 *   via `rejects.toThrow`/`toThrow`, so this suite stays green while proving
 *   the gate fails hard exactly where it must.
 * - LEG C (static bite): the same gate policy module that the CLI ratchets
 *   with denies the committed CSS-dependent probe fixture and passes the
 *   committed role/name probe fixture.
 *
 * Server-kind: this is a CLIENT-side contract; it runs once under the
 * default `chromium` project (auto-matched — no playwright.config.ts entry).
 * Gate policy + baseline: docs/plans/df1-evidence/HARNESS-11.md.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROBES = path.resolve(__dirname, '../fixtures/a11y-gate')

test.describe('HARNESS-11 accessibility selector gate — helper self-test', () => {
  test('leg A: real main UI controls via roles, accessible names, and keyboard only', async ({
    freshellPage,
  }) => {
    // Hide sidebar: role + accessible name assertion, then keyboard operation.
    const hideSidebar = byRole(freshellPage, 'button', ariaNamePattern('Hide sidebar'))
    await expectAccessible(hideSidebar, { role: 'button', name: 'Hide sidebar' })

    await focusByKeyboard(freshellPage, hideSidebar, { maxTabs: 120 })
    await freshellPage.keyboard.press('Enter')

    // Sidebar collapse swaps the control to "Show sidebar" — prove the swap
    // through the accessibility tree, not the DOM classes.
    const showSidebar = byRole(freshellPage, 'button', ariaNamePattern('Show sidebar'))
    await expectAccessible(showSidebar, { role: 'button', name: 'Show sidebar' })
    await expect(hideSidebar).toBeHidden()

    // Restore the sidebar for readability of later interactions.
    await showSidebar.click()
    await expectAccessible(hideSidebar, { role: 'button', name: 'Hide sidebar' })

    // A second independent main control: the tab strip's "New shell tab".
    const newShellTab = byRole(freshellPage, 'button', ariaNamePattern('New shell tab'))
    await expectAccessible(newShellTab, { role: 'button', name: 'New shell tab' })
  })

  test('leg B: deliberately fails on an inaccessible fixture control', async ({ page }) => {
    // The canonical WCAG failure mode: a clickable div with zero semantics.
    await page.setContent(
      '<main><div class="btn btn-primary shiny-gradient" onclick="void 0">Deploy build</div></main>',
    )
    // Located by user-visible TEXT (a gate-clean selector) so the failure
    // below is attributable to the inaccessible CONTROL, never the selector.
    const fakeButton = page.getByText('Deploy build')
    await expect(fakeButton).toBeVisible()

    // Deliberate failure 1 — the role+accessible-name assertion rejects it:
    // a div computes to role 'generic' and exposes no accessible name.
    await expect(
      expectAccessible(fakeButton, { role: 'button', name: 'Deploy build' }, { timeout: 3_000 }),
    ).rejects.toThrow(/toHaveRole|expected ARIA role/)

    // Deliberate failure 2 — keyboard Tab focus can never land on a div.
    await expect(focusByKeyboard(page, fakeButton, { maxTabs: 5 })).rejects.toThrow(
      /never received keyboard focus/,
    )

    // Deliberate failure 3 — name-less role selection refuses synchronously.
    expect(() => byRole(page, 'button', '')).toThrow(/non-empty accessible name/)
  })

  test('leg C: static gate bites on the committed probe fixtures', () => {
    const badSource = readFileSync(path.join(PROBES, 'css-dependent.bad.ts'), 'utf8')
    const bad = scanSource(badSource, 'fixtures/a11y-gate/css-dependent.bad.ts')
    expect(bad.length).toBe(6)
    expect(new Set(bad.map((v) => v.code))).toEqual(
      new Set(['structural-combinator', 'css-class', 'xpath', 'parent-traversal', 'structural-pseudo']),
    )

    const goodSource = readFileSync(path.join(PROBES, 'role-name.good.ts'), 'utf8')
    expect(scanSource(goodSource, 'fixtures/a11y-gate/role-name.good.ts')).toEqual([])
  })
})
