import { describe, expect, it } from 'vitest'
import {
  desktopConfigPathForFixtureEnv,
  isolatedElectronHomeEnv,
} from '../../e2e-electron/fixture-home-env.js'

describe('Electron fixture Windows profile isolation', () => {
  it('makes Windows desktop config resolution use the temporary USERPROFILE, never inherited HOME', () => {
    const fixtureHome = 'C:\\freshell-test-home'
    const realHome = 'C:\\Users\\Dan'
    const env = isolatedElectronHomeEnv({ HOME: realHome, USERPROFILE: realHome }, fixtureHome, 'win32')

    expect(env.USERPROFILE).toBe(fixtureHome)
    expect(env.HOMEDRIVE).toBe('C:')
    expect(env.HOMEPATH).toBe('\\freshell-test-home')
    expect(env.APPDATA).toBe('C:\\freshell-test-home\\AppData\\Roaming')
    expect(desktopConfigPathForFixtureEnv(env, 'win32')).toBe('C:\\freshell-test-home\\.freshell\\desktop.json')
    expect(desktopConfigPathForFixtureEnv(env, 'win32')).not.toContain('Users\\Dan')
  })
})
