import { defineConfig } from '@playwright/test'

/**
 * E2E config for the guided-mode fault-path suite.
 *
 * Deliberately does NOT start a server: these tests run against an already-
 * running DEV instance (npm run dev → Vite 5173 / API 3020) or the battle
 * rig's tool container. Never point BASE_URL at production — the spec
 * itself also refuses known prod hosts.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173',
    headless: true,
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
