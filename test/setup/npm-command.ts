export type NpmExecFileCommand = {
  command: string
  args: string[]
}

export function resolveNpmExecFileCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  nodeExecPath = process.execPath,
): NpmExecFileCommand {
  const npmExecPath = env.npm_execpath
  if (npmExecPath && npmExecPath.endsWith('.js')) {
    return {
      command: nodeExecPath,
      args: [npmExecPath, ...args],
    }
  }

  return {
    command: platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
  }
}
