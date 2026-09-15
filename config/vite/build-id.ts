import { execFileSync } from 'node:child_process'

const BUILD_COMMIT_PATTERN = /^[0-9a-f]{40}$/

/**
 * Return the explicit artifact provenance only when it is a full lowercase
 * Git object id. This is a build input (not a runtime setting): Cloud Build
 * receives it without copying checkout metadata into the image.
 */
export function resolveBuildCommitOverride(value = process.env.FRESHELL_BUILD_COMMIT): string | undefined {
  return value && BUILD_COMMIT_PATTERN.test(value) ? value : undefined
}

/** Match the Rust compile-time stamp; git-less bundles leave reload detection inert. */
export function computeClientBuildId(cwd: string): string {
  const override = resolveBuildCommitOverride()
  if (override) return override

  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).toString().trim()
    return BUILD_COMMIT_PATTERN.test(sha) ? sha : 'unknown'
  } catch {
    return 'unknown'
  }
}
