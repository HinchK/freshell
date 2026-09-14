import path from 'node:path'

export function launchChooserViteArgs(viteRoot: string, projectRoot: string, port: number): string[] {
  return [
    path.join(viteRoot, 'vite/bin/vite.js'),
    '--config', path.join(projectRoot, 'config/vite/vite.launch-chooser.config.ts'),
    '--port', String(port), '--strictPort',
  ]
}
