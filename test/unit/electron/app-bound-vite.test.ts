import { describe, expect, it } from 'vitest'
import { launchChooserViteArgs } from '../../e2e-electron/launch-chooser-vite.js'

describe('app-bound chooser Vite ownership', () => {
  it('uses the fixture-selected strict port, so a foreign 5175 responder cannot be accepted', () => {
    const args = launchChooserViteArgs('/fixture/node_modules', '/fixture', 45123)
    expect(args).toContain('--strictPort')
    expect(args).toContain('--port')
    expect(args).toContain('45123')
    expect(args).not.toContain('5175')
  })
})
