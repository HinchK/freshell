/** Verify an unpacked Electron runtime before an installer is published. */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  FORBIDDEN_RUNTIME_NAMES,
  RUNTIME_LAYOUT,
  findUnapprovedRuntimePaths,
  getRuntimeAllowlist,
  getRuntimePaths,
  sha256File,
  type ElectronRuntimeArch,
  type ElectronRuntimePlatform,
} from './prepare-electron-runtime.js'

const AUTHENTICATION_REFUSAL = 'AUTH_TOKEN is required. Refusing to start without authentication.'
const PROBE_TIMEOUT_MS = 5_000

export interface ElectronArtifactProbeOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
}

export interface ElectronArtifactProbeResult {
  status: number | null
  stdout: string
  stderr: string
  signal?: NodeJS.Signals | null
  error?: Error
}

export interface VerifyElectronArtifactOptions {
  probe?: (command: string, options: ElectronArtifactProbeOptions) => ElectronArtifactProbeResult
  probeTimeoutMs?: number
  hostPlatform?: NodeJS.Platform
  /** Expected artifact architecture; matched against the staging receipt when provided. */
  arch?: ElectronRuntimeArch | string
}

export interface ElectronArtifactVerificationReceipt {
  ok: true
  artifactPath: string
  platform: ElectronRuntimePlatform
  executed: boolean
  requiredFiles: string[]
  forbiddenFiles: string[]
}

function walkFiles(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute, relative)
      else files.push(relative)
    }
  }
  walk(root, '')
  return files.sort()
}

function isForbidden(relativePath: string): boolean {
  const normalized = relativePath.replaceAll(path.sep, '/')
  if (normalized.endsWith('.node')) return true
  return FORBIDDEN_RUNTIME_NAMES.some((name) =>
    normalized === name || normalized.startsWith(`${name}/`) || normalized.includes(`/${name}/`),
  )
}

function checkBinaryFormat(binaryPath: string, platform: ElectronRuntimePlatform): void {
  const bytes = readFileSync(binaryPath).subarray(0, 4)
  const isElf = bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
  const isWindows = bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a
  const magic = bytes.readUInt32BE(0)
  const isMachO = magic === 0xfeedface || magic === 0xcefaedfe || magic === 0xfeedfacf || magic === 0xcffaedfe
  if ((platform === 'linux' && !isElf) || (platform === 'win32' && !isWindows) || (platform === 'darwin' && !isMachO)) {
    throw new Error(`Rust server binary has the wrong format for ${platform}`)
  }
}

function createProbeEnvironment(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('FRESHELL_')) delete env[key]
  }
  for (const key of [
    'AUTH_TOKEN',
    'NODE_ENV',
    'NODE_PATH',
    'PORT',
    'HOST',
    'DOTENV_CONFIG_PATH',
    'XDG_CONFIG_HOME',
    'APPDATA',
    'LOCALAPPDATA',
  ]) delete env[key]
  // Point conventional config roots at the empty probe directory so a host
  // user's ~/.freshell cannot make the missing-token check pass accidentally.
  env.HOME = cwd
  env.USERPROFILE = cwd
  env.XDG_CONFIG_HOME = cwd
  env.APPDATA = cwd
  env.LOCALAPPDATA = cwd
  return env
}

function defaultProbe(command: string, options: ElectronArtifactProbeOptions): ElectronArtifactProbeResult {
  const result = spawnSync(command, [], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signal: result.signal,
    error: result.error,
  }
}

function readPackageName(packageJsonPath: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown }
    return typeof value.name === 'string' ? value.name : undefined
  } catch {
    return undefined
  }
}

function readPackageVersion(packageJsonPath: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown }
    return typeof value.version === 'string' && value.version.length > 0 ? value.version : undefined
  } catch {
    return undefined
  }
}

/**
 * The staged runtime is produced with zero links, and Electron-builder's
 * copier can only preserve what it is given; a link in a final artifact
 * means the tree was corrupted or partially moved, which can invalidate
 * resolution exactly where it hurts.  Reject links outright: broken,
 * cyclic, and escaping targets are all covered by refusing links at all.
 */
function assertNoArtifactLinks(root: string): void {
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const stats = lstatSync(absolute)
      if (stats.isSymbolicLink()) {
        throw new Error(`Electron artifact contains a link: ${absolute}`)
      }
      if (stats.isDirectory()) walk(absolute)
    }
  }
  walk(root)
}

interface ExportedIdentity {
  name?: unknown
  version?: unknown
}

/**
 * Validate the artifact against the stager's receipt: package-manager
 * identity, recorded platform/arch, release metadata cross-checked against
 * the actual staged manifests, and a content-hash comparison for every
 * file the stager recorded.  The artifact may contain additional
 * electron-builder resources (the allowlist governs those); it must not
 * lose or alter any staged runtime file.
 */
function validateArtifactReceipt(
  root: string,
  paths: ReturnType<typeof getRuntimePaths>,
  platform: ElectronRuntimePlatform,
  options: VerifyElectronArtifactOptions,
  stagedMcpVersion: string | undefined,
): void {
  const receiptPath = path.join(root, RUNTIME_LAYOUT.receipt)
  let receipt: Record<string, unknown>
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>
  } catch {
    throw new Error(`Electron artifact is missing a parsable staging receipt: ${RUNTIME_LAYOUT.receipt}`)
  }

  const failures: string[] = []
  if (receipt.severity !== 'info') failures.push('staging receipt severity must be "info"')
  if (receipt.event !== 'electron_runtime_prepared') failures.push('staging receipt event must be "electron_runtime_prepared"')
  if (receipt.platform !== platform) {
    failures.push(`staging receipt platform ${String(receipt.platform)} does not match the artifact platform ${platform}`)
  }
  if (options.arch !== undefined && receipt.arch !== options.arch) {
    failures.push(`staging receipt arch ${String(receipt.arch)} does not match the requested arch ${String(options.arch)}`)
  }

  const packageManager = receipt.packageManager
  if (
    !packageManager || typeof packageManager !== 'object'
    || (packageManager as { name?: unknown }).name !== 'pnpm'
    || typeof (packageManager as { version?: unknown }).version !== 'string'
    || (packageManager as { version?: unknown }).version === ''
  ) {
    failures.push('staging receipt packageManager must be { name: "pnpm", version: <string> }')
  }

  const releaseVersion = typeof receipt.releaseVersion === 'string' && receipt.releaseVersion.length > 0
    ? receipt.releaseVersion
    : undefined
  if (!releaseVersion) {
    failures.push('staging receipt releaseVersion must be a nonempty string')
  } else {
    if (stagedMcpVersion && releaseVersion !== stagedMcpVersion) {
      failures.push(`staging receipt releaseVersion ${releaseVersion} does not match the staged MCP version ${stagedMcpVersion}`)
    }
  }

  const exported = Array.isArray(receipt.exportedPackages) ? receipt.exportedPackages as ExportedIdentity[] : []
  const stagedIdentity = exported.find((identity) => identity?.name === 'freshell')
  if (!stagedIdentity || stagedIdentity.version !== releaseVersion) {
    failures.push('staging receipt exportedPackages must include { name: "freshell" } with the staged release version')
  }
  const sidecarIdentity = exported.find((identity) => identity?.name === 'freshell-claude-sidecar')
  const sidecarVersion = readPackageVersion(path.join(paths.claudeSidecarDir, 'package.json'))
  if (!sidecarIdentity || typeof sidecarIdentity.version !== 'string' || !sidecarVersion || sidecarIdentity.version !== sidecarVersion) {
    failures.push(`staging receipt freshell-claude-sidecar identity ${String(sidecarIdentity?.version)} does not match the staged sidecar manifest ${String(sidecarVersion)}`)
  }

  const fileHashes = receipt.fileHashes
  if (!fileHashes || typeof fileHashes !== 'object' || Array.isArray(fileHashes)) {
    failures.push('staging receipt fileHashes must be an object')
  } else {
    const entries = Object.entries(fileHashes as Record<string, unknown>)
    if (entries.length === 0) {
      failures.push('staging receipt fileHashes must not be empty')
    }
    for (const [relative, expected] of entries) {
      if (typeof expected !== 'string' || relative.startsWith('/') || relative.split('/').includes('..')) {
        failures.push(`staging receipt lists an invalid path: ${relative}`)
        continue
      }
      const target = path.join(root, relative)
      if (!existsSync(target)) {
        failures.push(`staging receipt file is missing from the artifact: ${relative}`)
        continue
      }
      if (sha256File(target) !== expected) {
        failures.push(`staging receipt hash mismatch for ${relative}`)
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Electron artifact staging receipt validation failed: ${failures.join('; ')}`)
  }
}

export function verifyElectronArtifact(
  artifactPath: string,
  platform: ElectronRuntimePlatform,
  options: VerifyElectronArtifactOptions = {},
): ElectronArtifactVerificationReceipt {
  const root = path.resolve(artifactPath)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Electron artifact directory is missing: ${root}`)
  const paths = getRuntimePaths(root, platform)
  const allowlist = getRuntimeAllowlist(platform)
  const required = [...allowlist.requiredFiles]
  for (const relative of required) {
    if (!existsSync(path.join(root, relative))) throw new Error(`Electron artifact is missing required file: ${relative}`)
  }
  if (readPackageName(paths.mcpPackageJson) !== 'freshell') throw new Error('Electron MCP package metadata must use name "freshell"')
  const mcpVersion = (() => {
    try {
      const value = JSON.parse(readFileSync(paths.mcpPackageJson, 'utf8')) as { version?: unknown }
      return typeof value.version === 'string' && value.version.length > 0 ? value.version : undefined
    } catch {
      return undefined
    }
  })()
  if (!mcpVersion) throw new Error('Electron MCP package metadata must include a release version')

  assertNoArtifactLinks(root)

  const artifactFiles = walkFiles(root)
  const forbidden = artifactFiles.filter(isForbidden)
  if (forbidden.length > 0) throw new Error(`Electron artifact contains forbidden files: ${forbidden.join(', ')}`)
  const unapproved = findUnapprovedRuntimePaths(artifactFiles, platform)
  if (unapproved.length > 0) throw new Error(`Electron artifact contains unapproved files: ${unapproved.join(', ')}`)
  validateArtifactReceipt(root, paths, platform, options, mcpVersion)

  const serverBinary = path.join(root, allowlist.serverBinary)
  checkBinaryFormat(serverBinary, platform)
  const hostPlatform = options.hostPlatform ?? process.platform
  // Windows filesystems do not retain POSIX executable bits, including when
  // inspecting a foreign artifact. Native POSIX artifacts still require them.
  if (hostPlatform !== 'win32' && platform !== 'win32' && (statSync(serverBinary).mode & 0o111) === 0) {
    throw new Error('Rust server binary is not executable')
  }

  if (platform !== hostPlatform) {
    return {
      ok: true,
      artifactPath: root,
      platform,
      executed: false,
      requiredFiles: required,
      forbiddenFiles: [],
    }
  }

  const probeCwd = mkdtempSync(path.join(tmpdir(), 'freshell-electron-probe-'))
  const timeout = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  let result: ElectronArtifactProbeResult
  try {
    result = (options.probe ?? defaultProbe)(serverBinary, {
      cwd: probeCwd,
      env: createProbeEnvironment(probeCwd),
      timeout,
    })
  } finally {
    rmSync(probeCwd, { recursive: true, force: true })
  }
  const output = `${result.stdout}\n${result.stderr}`
  if (result.error) throw new Error(`Rust server execution probe failed: ${result.error.message}`)
  if (result.status !== 1) throw new Error(`Rust server execution probe must exit with code 1, received ${String(result.status)}`)
  if (!output.includes(AUTHENTICATION_REFUSAL)) {
    throw new Error('Rust server execution probe did not report the expected authentication refusal')
  }
  if (/\blisten(?:ing)?\b/i.test(output)) {
    throw new Error('Rust server execution probe emitted a listen event before refusing authentication')
  }
  return {
    ok: true,
    artifactPath: root,
    platform,
    executed: true,
    requiredFiles: required,
    forbiddenFiles: [],
  }
}

export function resolveDefaultArtifactPath(
  platform: NodeJS.Platform,
  arch: ElectronRuntimeArch | string = process.arch,
): string {
  if (platform === 'darwin') {
    const macDirectory = arch === 'arm64' ? 'mac-arm64' : 'mac'
    return path.join(process.cwd(), 'release', macDirectory, 'Freshell.app', 'Contents', 'Resources')
  }
  if (platform === 'win32') {
    const winDirectory = arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked'
    return path.join(process.cwd(), 'release', winDirectory, 'resources')
  }
  const linuxDirectory = arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked'
  return path.join(process.cwd(), 'release', linuxDirectory, 'resources')
}

function parsePlatform(value: string | undefined): ElectronRuntimePlatform {
  const platform = value ?? process.platform
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') throw new Error(`Unsupported Electron artifact platform: ${platform}`)
  return platform
}

function parseArch(value: string | undefined): ElectronRuntimeArch {
  const arch = value ?? process.arch
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`Unsupported Electron artifact architecture: ${arch}`)
  return arch
}

/** Resolve an explicit artifact override without consulting host architecture. */
export function resolveArtifactPath(
  override: string | undefined,
  platform: ElectronRuntimePlatform,
  architecture: string | undefined,
): string {
  if (override !== undefined) return override
  return resolveDefaultArtifactPath(platform, parseArch(architecture))
}

function main(): void {
  const args = process.argv.slice(2)
  const pathArg = args[0] && !args[0].startsWith('--') ? args[0] : undefined
  const platformArgIndex = args.indexOf('--platform')
  const platform = parsePlatform(platformArgIndex >= 0 ? args[platformArgIndex + 1] : undefined)
  const archArgIndex = args.indexOf('--arch')
  const archArg = archArgIndex >= 0 ? args[archArgIndex + 1] : undefined
  const artifactOverride = pathArg ?? process.env.ELECTRON_ARTIFACT_PATH
  const artifactPath = resolveArtifactPath(
    artifactOverride,
    platform,
    archArg,
  )
  const receipt = verifyElectronArtifact(
    artifactPath,
    platform,
    archArg !== undefined ? { arch: parseArch(archArg) } : {},
  )
  process.stdout.write(`${JSON.stringify({ severity: 'info', event: 'electron_artifact_verified', ...receipt })}\n`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown Electron artifact verification failure'
    process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'electron_artifact_verification_failed', message })}\n`)
    process.exitCode = 1
  }
}
