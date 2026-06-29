import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright E2E config for the commissioning BATTLE stack.
 *
 * The stack (battle/docker-compose.battle.yml, run as `docker compose -p battle`)
 * brings up the CONNECTED system:
 *   - tool   = field tool (Express + Vite React UI)  → host http://localhost:13000
 *   - cloud  = commissioning-cloud (Next.js dashboard) → host http://localhost:13001
 *   - plc-sim, seeder, etc. (project 1 / subsystem 38 — real MCM02 data)
 *
 * Both base URLs are env-parameterised so the same suite runs:
 *   - locally against the published host ports (defaults below), and
 *   - inside CI on the battle docker network (set TOOL_URL=http://tool:3000,
 *     CLOUD_URL=http://cloud:3000 when the runner shares the `battle` network).
 *
 * Artifacts (video, screenshots, traces, html + json reports) are written under
 * a directory the battle CI artifact export already collects (`battle-artifacts/`).
 */

const TOOL_URL = process.env.TOOL_URL ?? 'http://localhost:13000'
const CLOUD_URL = process.env.CLOUD_URL ?? 'http://localhost:13001'

// Keep all outputs under battle-artifacts/ so the existing GitLab `artifacts:
// paths: [battle-artifacts/]` rule (see .gitlab-ci.yml .battle-base) picks them up.
const ARTIFACT_ROOT = process.env.E2E_ARTIFACT_DIR ?? '../../battle-artifacts/e2e'

export default defineConfig({
  testDir: './tests',
  // The stack is heavy (1184 IOs, PLC sim, sync). Give journeys room.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Connected-sync assertions are inherently timing-sensitive (push → cloud
  // receive). Serialize to avoid two specs mutating the same subsystem at once.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  outputDir: `${ARTIFACT_ROOT}/test-results`,

  reporter: [
    ['list'],
    ['html', { outputFolder: `${ARTIFACT_ROOT}/html-report`, open: 'never' }],
    ['json', { outputFile: `${ARTIFACT_ROOT}/results.json` }],
  ],

  use: {
    // Per-spec base URL is set via test.use({ baseURL }) — leave a sensible default.
    baseURL: TOOL_URL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    video: 'on',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    // The battle stack is HTTP-only and self-signed-free; relax just in case.
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})

// Re-export the resolved base URLs so specs can import them rather than
// re-reading env (single source of truth).
export const BASE_URLS = { TOOL_URL, CLOUD_URL }
