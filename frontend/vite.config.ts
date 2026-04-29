import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { execSync } from 'child_process'

let gitHash = 'dev'
let gitTag = ''
let buildDate = new Date().toISOString()
try {
  gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
} catch {}
try {
  gitTag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8', shell: true }).trim()
} catch {
  gitTag = '' // No tags found — will fall back to build-{hash}
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  define: {
    'import.meta.env.VITE_BUILD_HASH': JSON.stringify(gitHash),
    'import.meta.env.VITE_BUILD_DATE': JSON.stringify(buildDate),
    'import.meta.env.VITE_BUILD_VERSION': JSON.stringify(gitTag || `build-${gitHash}`),
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': `http://localhost:${process.env.PORT || '3000'}`,
      '/ws': { target: `ws://localhost:${process.env.PORT || '3000'}`, ws: true },
    },
  },
})
