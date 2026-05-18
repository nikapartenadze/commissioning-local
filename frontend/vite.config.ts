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

// APP_VERSION (set by BUILD-INSTALLER.bat / BUILD-PORTABLE.bat) is the source
// of truth for installer version. Prefer it so the UI badge matches the
// installer .exe name without requiring a git tag bump for every build.
const envVersion = (process.env.APP_VERSION || '').trim()
const buildVersion = envVersion
  ? (envVersion.startsWith('v') ? envVersion : `v${envVersion}`)
  : (gitTag || `build-${gitHash}`)

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
    'import.meta.env.VITE_BUILD_VERSION': JSON.stringify(buildVersion),
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
