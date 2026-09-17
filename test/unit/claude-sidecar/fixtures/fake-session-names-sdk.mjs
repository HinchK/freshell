// The injected SDK call boundary for the session-names helper tests — the
// same env-seam pattern as the sidecar's fake-query-module. Exports ONLY the
// two metadata functions the helper consumes; refuses to load when the
// ambient project-key override leaked into the child env un-removed (the
// Rust parent must set OR remove CLAUDE_CODE_PROJECT_DIR_NAME deliberately).

const seenEnv = {
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  projectDirName: process.env.CLAUDE_CODE_PROJECT_DIR_NAME ?? null,
}

export async function getSessionInfo(sessionId, options) {
  if (options && 'sessionStore' in options) {
    throw new Error('the alpha sessionStore option must never be passed')
  }
  // The store-wide ambiguity probe arrives with NO options object at all.
  if (options === undefined) {
    if (process.env.FRESHELL_FAKE_SDK_AMBIGUOUS === '1') {
      return {
        sessionId,
        summary: 'other copy',
        lastModified: 9999999999999,
        fileSize: 1,
        customTitle: null,
      }
    }
    return {
      sessionId,
      summary: 'Fake summary',
      lastModified: 1750000000000,
      fileSize: 4096,
      customTitle: 'Fake Custom Title',
      firstPrompt: 'hello',
    }
  }
  if (!sessionId || !options?.dir) {
    throw new Error('getSessionInfo requires sessionId and dir')
  }
  if (sessionId === 'ffffffff-0000-0000-0000-000000000000') {
    return undefined
  }
  if (sessionId === 'boom') {
    throw new Error('sdk exploded')
  }
  return {
    sessionId,
    summary: 'Fake summary',
    lastModified: 1750000000000,
    fileSize: 4096,
    customTitle: 'Fake Custom Title',
    firstPrompt: 'hello',
  }
}

export async function renameSession(sessionId, title, options) {
  if (!sessionId || !title || !options?.dir) {
    throw new Error('renameSession requires sessionId, title and dir')
  }
  if (sessionId === 'ffffffff-0000-0000-0000-000000000000') {
    throw new Error('no such session')
  }
  return undefined
}
