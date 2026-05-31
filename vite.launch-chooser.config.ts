import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'electron/launch-chooser'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist/launch-chooser'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5175,
  },
  resolve: {
    alias: {
      '@electron': path.resolve(__dirname, './electron'),
    },
  },
  css: {
    postcss: {
      plugins: [
        (await import('tailwindcss')).default({
          config: path.resolve(__dirname, 'tailwind.config.wizard.js'),
        }),
        (await import('autoprefixer')).default,
      ],
    },
  },
})
