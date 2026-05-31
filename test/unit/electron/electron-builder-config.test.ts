import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

describe('electron-builder Windows config', () => {
  it('builds the Windows installer without the portable self-extracting target', () => {
    const config = readFileSync(
      path.join(PROJECT_ROOT, 'electron-builder.yml'),
      'utf-8',
    )

    expect(config).toMatch(/win:\n(?:.*\n)*?  target:\n(?:.*\n)*?    - nsis/)
    expect(config).not.toMatch(/win:\n(?:.*\n)*?  target:\n(?:.*\n)*?    - portable/)
    expect(config).not.toMatch(/^portable:/m)
  })

  it('does not request the portable target from the Windows package script', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
    ) as { scripts: Record<string, string> }

    expect(packageJson.scripts['electron:build:win']).toContain('--win nsis')
    expect(packageJson.scripts['electron:build:win']).not.toContain('portable')
  })

  it('does not require publish metadata for local package builds', () => {
    const config = readFileSync(
      path.join(PROJECT_ROOT, 'electron-builder.yml'),
      'utf-8',
    )

    expect(config).toMatch(/^publish: null$/m)
  })

  it('packages launch chooser assets as extra resources', () => {
    const config = readFileSync(
      path.join(PROJECT_ROOT, 'electron-builder.yml'),
      'utf-8',
    )

    expect(config).toMatch(
      /extraResources:\n(?:.*\n)*?  - from: dist\/launch-chooser\n    to: launch-chooser/,
    )
  })

  it('uses a silent-install friendly NSIS flow', () => {
    const config = readFileSync(
      path.join(PROJECT_ROOT, 'electron-builder.yml'),
      'utf-8',
    )

    expect(config).toMatch(
      /^nsis:\n  oneClick: true\n  runAfterFinish: true\n  include: assets\/electron\/installer\.nsh$/m,
    )
    expect(config).not.toContain('allowToChangeInstallationDirectory')
  })

  it('lets the built-in NSIS completion flow launch the installed app', () => {
    const include = readFileSync(
      path.join(PROJECT_ROOT, 'assets', 'electron', 'installer.nsh'),
      'utf-8',
    )

    expect(include).toContain('!macro customInstall')
    expect(include).not.toContain('SetErrorLevel 0')
    expect(include).not.toContain("System::Call 'kernel32::ExitProcess(i 0)'")
  })

  it('quits before installation when Freshell is already running', () => {
    const include = readFileSync(
      path.join(PROJECT_ROOT, 'assets', 'electron', 'installer.nsh'),
      'utf-8',
    )

    expect(include).toContain('!macro customInit')
    expect(include).toContain('!macro customCheckAppRunning')
    expect(include).toContain('${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0')
    expect(include).toContain('Quit ${PRODUCT_NAME} before running this installer.')
    expect(include).toContain('SetErrorLevel 1')
    expect(include).not.toContain('taskkill')
  })

  it('can provision remote desktop config from silent installer args', () => {
    const include = readFileSync(
      path.join(PROJECT_ROOT, 'assets', 'electron', 'installer.nsh'),
      'utf-8',
    )

    expect(include).toContain('${StdUtils.GetParameter} $0 "FRESHELL_REMOTE_URL" ""')
    expect(include).toContain('${StdUtils.GetParameter} $1 "FRESHELL_TOKEN" ""')
    expect(include).toContain('FileOpen $2 "$PROFILE\\.freshell\\desktop.json" w')
    expect(include).toContain('$\\"serverMode$\\": $\\"remote$\\",')
    expect(include).toContain('$\\"remoteUrl$\\": $\\"$0$\\",')
    expect(include).toContain('$\\"remoteToken$\\": $\\"$1$\\",')
    expect(include).toContain('$\\"setupCompleted$\\": true')
  })
})
