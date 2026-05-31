import path from 'path'
import { describe, expect, it } from 'vitest'
import { getTrayIconName, resolveTrayIconPath } from '../../../electron/icon-path.js'

describe('Electron icon paths', () => {
  it('uses a Windows ICO for the Windows tray', () => {
    expect(getTrayIconName('win32')).toBe('tray-icon-win.ico')
  })

  it('uses a PNG tray icon on non-Windows platforms', () => {
    expect(getTrayIconName('linux')).toBe('tray-icon.png')
    expect(getTrayIconName('darwin')).toBe('tray-icon.png')
  })

  it('resolves the dev tray icon from the repository assets directory', () => {
    const moduleDir = path.join('/repo', 'dist', 'electron', 'electron')

    expect(
      resolveTrayIconPath({
        platform: 'win32',
        isDev: true,
        moduleDir,
        resourcesPath: undefined,
        existsSync: () => false,
      }),
    ).toBe(path.join('/repo', 'assets', 'electron', 'tray-icon-win.ico'))
  })

  it('resolves packaged tray icons from extraResources', () => {
    const moduleDir = path.join('/app', 'resources', 'app.asar', 'dist', 'electron', 'electron')

    expect(
      resolveTrayIconPath({
        platform: 'win32',
        isDev: false,
        moduleDir,
        resourcesPath: path.join('/app', 'resources'),
        existsSync: () => false,
      }),
    ).toBe(path.join('/app', 'resources', 'assets', 'tray-icon-win.ico'))
  })

  it('supports local packaged-like runs from dist without ELECTRON_DEV', () => {
    const moduleDir = path.join('/repo', 'dist', 'electron', 'electron')

    expect(
      resolveTrayIconPath({
        platform: 'linux',
        isDev: false,
        moduleDir,
        resourcesPath: undefined,
        existsSync: (candidate) =>
          candidate === path.join('/repo', 'assets', 'electron', 'tray-icon.png'),
      }),
    ).toBe(path.join('/repo', 'assets', 'electron', 'tray-icon.png'))
  })

  it('throws when a packaged tray icon cannot be resolved without resourcesPath', () => {
    expect(() =>
      resolveTrayIconPath({
        platform: 'linux',
        isDev: false,
        moduleDir: path.join('/app', 'resources', 'app.asar', 'dist', 'electron', 'electron'),
        resourcesPath: undefined,
        existsSync: () => false,
      }),
    ).toThrow('resourcesPath is required')
  })
})
