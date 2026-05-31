import { normalizeServerUrl } from './launch-discovery.js'
import type { DesktopConfig, LaunchChoice, LaunchChoiceResult } from './types.js'

export interface ChooseLaunchOptionHandlerOptions {
  patchDesktopConfig: (patch: Partial<DesktopConfig>) => Promise<DesktopConfig | void>
  restartMain: () => Promise<void> | void
  getCurrentPort: () => number
  validateServerAuth?: (url: string, token: string) => Promise<boolean>
}

export function createChooseLaunchOptionHandler(options: ChooseLaunchOptionHandlerOptions) {
  return async (_event: unknown, choice: LaunchChoice): Promise<LaunchChoiceResult> => {
    if (choice.kind === 'remote' || choice.kind === 'connect') {
      if (!choice.url) {
        return { ok: false, error: 'Choose a server URL.' }
      }

      const url = normalizeServerUrl(choice.url)
      const token = choice.token?.trim()
      if (choice.requiresAuth !== false) {
        if (!token) {
          return { ok: false, error: `Enter a token for ${url}` }
        }

        if (options.validateServerAuth) {
          let authenticated = false
          try {
            authenticated = await options.validateServerAuth(url, token)
          } catch {
            authenticated = false
          }
          if (!authenticated) {
            return { ok: false, error: 'The server rejected that token.' }
          }
        }
      }

      await options.patchDesktopConfig({
        serverMode: 'remote',
        remoteUrl: url,
        remoteToken: token,
        alwaysAskOnLaunch: choice.alwaysAskOnLaunch,
        setupCompleted: true,
      })
    } else {
      await options.patchDesktopConfig({
        serverMode: 'app-bound',
        port: choice.port ?? options.getCurrentPort(),
        alwaysAskOnLaunch: choice.alwaysAskOnLaunch,
        setupCompleted: true,
      })
    }

    await options.restartMain()
    return { ok: true }
  }
}
