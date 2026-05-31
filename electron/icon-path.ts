import fs from 'fs'
import path from 'path'

export interface ResolveTrayIconPathOptions {
  platform: NodeJS.Platform
  isDev: boolean
  moduleDir: string
  resourcesPath?: string
  existsSync?: (path: string) => boolean
}

export function getTrayIconName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'tray-icon-win.ico' : 'tray-icon.png'
}

export function resolveTrayIconPath({
  platform,
  isDev,
  moduleDir,
  resourcesPath,
  existsSync = fs.existsSync,
}: ResolveTrayIconPathOptions): string {
  const iconName = getTrayIconName(platform)
  const devIconPath = path.join(moduleDir, '..', '..', '..', 'assets', 'electron', iconName)

  if (isDev || existsSync(devIconPath)) {
    return devIconPath
  }

  if (!resourcesPath) {
    throw new Error('resourcesPath is required for packaged tray icon')
  }

  return path.join(resourcesPath, 'assets', iconName)
}
