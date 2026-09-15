import path from 'node:path'

/**
 * Environment for a hermetic Electron profile. On Windows, Node's
 * os.homedir() follows USERPROFILE/HOMEDRIVE+HOMEPATH rather than HOME.
 */
export function isolatedElectronHomeEnv(
  inherited: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited, HOME: homeDir }
  if (platform !== 'win32') return env

  const parsed = path.win32.parse(homeDir)
  const relative = path.win32.relative(parsed.root, homeDir)
  env.USERPROFILE = homeDir
  env.HOMEDRIVE = parsed.root.replace(/[\\/]$/, '')
  env.HOMEPATH = `\\${relative}`
  env.APPDATA = path.win32.join(homeDir, 'AppData', 'Roaming')
  env.LOCALAPPDATA = path.win32.join(homeDir, 'AppData', 'Local')
  return env
}

/** Mirrors Windows Node's documented USERPROFILE-first home resolution. */
export function desktopConfigPathForFixtureEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const home = platform === 'win32'
    ? env.USERPROFILE ?? path.win32.join(env.HOMEDRIVE ?? '', env.HOMEPATH ?? '')
    : env.HOME
  if (!home) throw new Error('fixture home is unavailable')
  return platform === 'win32'
    ? path.win32.join(home, '.freshell', 'desktop.json')
    : path.join(home, '.freshell', 'desktop.json')
}
