type EnvSource = Record<string, string | undefined>

// Kata 7mtf: the env-key model heuristic (resolveOpencodeLaunchModel →
// google/gemini-3-pro-preview / openai/gpt-5 / anthropic/claude-sonnet-4-5)
// was removed: the injected --model outranked opencode's own MRU model state,
// so every spawned pane ignored the user's remembered model. A fresh spawn
// with no explicit model now emits no --model flag at all (see
// resolveCodingCliCommand in terminal-registry.ts).

function resolveGoogleApiKey(env: EnvSource): string | undefined {
  return env.GOOGLE_GENERATIVE_AI_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY
}

export function getOpencodeEnvOverrides(env: EnvSource): Record<string, string> {
  const overrides: Record<string, string> = {}
  const googleApiKey = resolveGoogleApiKey(env)
  if (googleApiKey && !env.GOOGLE_GENERATIVE_AI_API_KEY) {
    overrides.GOOGLE_GENERATIVE_AI_API_KEY = googleApiKey
  }
  return overrides
}
