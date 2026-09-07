type TerminalCaptureHandler = {
  suspendWebgl: () => boolean
  resumeWebgl: () => void
}

const terminalCaptureHandlers = new Map<string, TerminalCaptureHandler>()

function afterPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

export function registerTerminalCaptureHandler(paneId: string, handler: TerminalCaptureHandler): () => void {
  terminalCaptureHandlers.set(paneId, handler)
  return () => {
    const current = terminalCaptureHandlers.get(paneId)
    if (current === handler) {
      terminalCaptureHandlers.delete(paneId)
    }
  }
}

// Reference counting for overlapping suspensions: captures are serialized
// through a queue, but a capture that blew its deadline is abandoned by the
// tail and may resume WHILE its successor holds a suspension. Each suspend
// increments the depth; resumes only release the renderers when the LAST one
// lands, and each resumer is idempotent (its own end-of-capture call and the
// abandon fence can both reach it).
let suspensionDepth = 0
let suspendedPaneIds: string[] = []

export async function suspendTerminalRenderersForScreenshot(): Promise<() => Promise<void>> {
  if (suspensionDepth === 0) {
    const ids: string[] = []
    for (const [paneId, handler] of terminalCaptureHandlers) {
      try {
        if (handler.suspendWebgl()) {
          ids.push(paneId)
        }
      } catch {
        // Best effort only.
      }
    }
    suspendedPaneIds = ids
    if (ids.length > 0) {
      await afterPaint()
    }
  }
  suspensionDepth += 1

  let resumed = false
  return async () => {
    if (resumed) return
    resumed = true
    suspensionDepth -= 1
    if (suspensionDepth > 0) return

    const paneIds = suspendedPaneIds
    suspendedPaneIds = []
    for (const paneId of paneIds) {
      try {
        terminalCaptureHandlers.get(paneId)?.resumeWebgl()
      } catch {
        // Best effort only.
      }
    }

    if (paneIds.length > 0) {
      await afterPaint()
    }
  }
}
