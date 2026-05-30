import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'

export async function openPanePicker(page: Page): Promise<Locator> {
  const existingPicker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  if (await existingPicker.isVisible().catch(() => false)) {
    return existingPicker
  }

  const termContainer = page.locator('.xterm').first()
  if (await termContainer.isVisible().catch(() => false)) {
    await termContainer.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /split horizontally/i }).click()
  } else {
    await page.getByRole('button', { name: /add pane/i }).click()
  }

  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  await expect(picker).toBeVisible({ timeout: 10_000 })
  return picker
}

export async function clickFirstVisibleShellOption(page: Page): Promise<string> {
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 5_000 })
      return name
    }
  }

  throw new Error(`No shell option was visible in the pane picker. Checked: ${shellNames.join(', ')}`)
}
