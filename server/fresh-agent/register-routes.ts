import type { Express } from 'express'

import type { FreshAgentRuntimeManager } from './runtime-manager.js'
import { createFreshAgentRouter } from './router.js'

export function registerFreshAgentThreadRoutes(
  app: Pick<Express, 'use'>,
  deps: { runtimeManager: FreshAgentRuntimeManager },
): void {
  app.use('/api', createFreshAgentRouter({
    runtimeManager: deps.runtimeManager,
  }))
}
