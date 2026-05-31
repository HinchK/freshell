import { Router } from 'express'

export interface HealthRouterOptions {
  appVersion: string
  instanceId: string
  isReady: () => boolean
  startedAt: Date
}

export function createHealthRouter(options: HealthRouterOptions): Router {
  const router = Router()

  router.get('/', (_req, res) => {
    res.json({
      app: 'freshell',
      ok: true,
      requiresAuth: true,
      version: options.appVersion,
      ready: options.isReady(),
      instanceId: options.instanceId,
      startedAt: options.startedAt.toISOString(),
    })
  })

  return router
}
