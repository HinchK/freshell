import { expect, type Locator, type Page } from '@playwright/test'

/**
 * HARNESS-11 — accessible-interaction helpers for e2e specs.
 *
 * The gate contract (enforced statically by `a11y-selector-gate.ts`):
 * feature tests locate controls by **stable role + accessible name** (or a
 * label/title), never by CSS implementation details (classes, structure,
 * xpath, DOM traversal). These helpers are the sanctioned ergonomic path:
 *
 * - `byRole` / `byLabel` / `byTitle` are thin wrappers over Playwright's
 *   built-ins that REFUSE (synchronously — a programmer error, not a flaky
 *   test) to locate without a non-empty accessible name.
 * - `expectAccessible` asserts a control's computed ARIA role AND accessible
 *   name — the deliberate-failure surface for inaccessible controls.
 * - `focusByKeyboard` proves keyboard operability: Tab-navigation must
 *   actually reach the control.
 *
 * Playwright 1.58 notes: `page.accessibility` was removed; role/name checks
 * go through the first-party `toHaveRole` / `toHaveAccessibleName`
 * assertions, which compute against the browser's real accessibility tree.
 *
 * Gate policy + evidence: `docs/plans/df1-evidence/HARNESS-11.md`.
 */

export type AriaRole = Parameters<Page['getByRole']>[0]

export const SELECTOR_ENGINE_GUIDANCE =
  'HARNESS-11: feature tests must select by role + accessible name (byRole/getByRole, ' +
  'getByLabel, getByText), never by CSS implementation details (classes, structure, xpath). ' +
  'See docs/plans/df1-evidence/HARNESS-11.md. Genuinely non-accessible third-party widget ' +
  'roots (xterm.js terminal canvas, Monaco) carry a documented exemption in ' +
  'test/e2e-browser/helpers/a11y-selector-gate.ts.'

function requireName(kind: string, noun: string, name: string | RegExp): void {
  if (typeof name === 'string' && name.trim().length === 0) {
    throw new Error(
      `${kind} requires a non-empty accessible ${noun}. ` +
        'An empty one makes the locator match ANY (or no) candidate, which is exactly ' +
        'the instability this gate exists to prevent. ' +
        SELECTOR_ENGINE_GUIDANCE,
    )
  }
}

type GetByRoleOptions = {
  checked?: boolean
  disabled?: boolean
  exact?: boolean
  expanded?: boolean
  includeHidden?: boolean
  level?: number
  pressed?: boolean
  selected?: boolean
}

type RoleScope = Pick<Page, 'getByRole'>
type LabelScope = Pick<Page, 'getByLabel'>
type TitleScope = Pick<Page, 'getByTitle'>

/** Locate an element by ARIA role + REQUIRED accessible name. */
export function byRole(
  scope: RoleScope | Locator,
  role: AriaRole,
  name: string | RegExp,
  options?: GetByRoleOptions,
): Locator {
  requireName(`byRole('${role}')`, 'name', name)
  return scope.getByRole(role, { ...options, name })
}

/** Locate a form control by its REQUIRED accessible label. */
export function byLabel(
  scope: LabelScope | Locator,
  label: string | RegExp,
  options?: { exact?: boolean },
): Locator {
  requireName('byLabel', 'label', label)
  return scope.getByLabel(label, options)
}

/** Locate an element by its REQUIRED title attribute (accessible name source). */
export function byTitle(
  scope: TitleScope | Locator,
  title: string | RegExp,
  options?: { exact?: boolean },
): Locator {
  requireName('byTitle', 'title', title)
  return scope.getByTitle(title, options)
}

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g

/**
 * Build an anchored, fully-escaped RegExp for an exact accessible-name match
 * (`^Hide sidebar$`). Keeps specs free of hand-rolled (error-prone) escaping.
 */
export function ariaNamePattern(name: string): RegExp {
  const trimmed = name.trim()
  return new RegExp(`^${trimmed.replace(REGEXP_SPECIAL, '\\$&')}$`)
}

/**
 * Assert that a control is genuinely accessible: it resolves to the expected
 * ARIA role in the browser's accessibility tree AND exposes the expected
 * accessible name. Both are required — a control you cannot name is exactly
 * what the gate exists to catch. This is the deliberate-failure surface:
 * an inaccessible control (e.g. `<div onclick>`) rejects here.
 */
export async function expectAccessible(
  locator: Locator,
  expected: { role: AriaRole; name: string | RegExp },
  options?: { timeout?: number },
): Promise<void> {
  await expect(locator, 'expectable control must expose the expected ARIA role').toHaveRole(
    expected.role,
    options,
  )
  await expect(locator, 'expectable control must expose the expected accessible name').toHaveAccessibleName(
    expected.name,
    options,
  )
}

/**
 * Prove keyboard operability: press Tab (up to `maxTabs`) until the target
 * element literally holds `document.activeElement`. Throws with guidance when
 * focus never lands — e.g. a `<div onclick>` (not focusable) misses every
 * time, which is the gate's keyboard-leg deliberate failure.
 */
export async function focusByKeyboard(
  page: Page,
  locator: Locator,
  options?: { maxTabs?: number; tabKey?: string },
): Promise<void> {
  const maxTabs = options?.maxTabs ?? 60
  const tabKey = options?.tabKey ?? 'Tab'
  await expect(locator, 'focusByKeyboard target must exist and be visible').toBeVisible()
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press(tabKey)
    const focused = await locator
      .evaluate((el) => document.activeElement === el)
      .catch(() => false)
    if (focused) return
  }
  throw new Error(
    `focusByKeyboard: target never received keyboard focus after ${maxTabs} Tab presses. ` +
      'A control that cannot be reached by keyboard is not an accessible control. ' +
      SELECTOR_ENGINE_GUIDANCE,
  )
}
