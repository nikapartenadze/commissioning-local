import { test, expect } from '@playwright/test'
import { BASE_URLS } from '../playwright.config'
import { SUBSYSTEM_ID, signInCloudDevAdmin } from './helpers'

/**
 * Cloud dashboard smoke journeys (commissioning-cloud, Next.js, host :13001).
 *
 * AUTH CAVEAT (read before debugging a "redirected to /auth/signin" failure):
 *   The battle stack runs the cloud with NODE_ENV=production by default, and
 *   DEV_BYPASS_AUTH is only set under the `delta`/`mutate`-style scenarios.
 *   In that default, all dashboard UI routes (`/`, `/project/[id]/...`) are
 *   behind a NextAuth session and redirect to `/auth/signin`. `/api/sync/*` is
 *   the ONLY always-public surface (field tools authenticate with X-API-Key).
 *
 *   To exercise the full UI journey, bring the stack up with the cloud auth
 *   bypass enabled (see battle/e2e/README.md):
 *       CLOUD_NODE_ENV=development  CLOUD_DEV_BYPASS=1
 *   These map to the cloud service's NODE_ENV / DEV_BYPASS_AUTH env in
 *   docker-compose.battle.yml.
 *
 * This spec is written to be HONEST about that gate: it detects the signin
 * redirect and, when present, skips the authed-only assertions with a clear
 * message rather than producing a misleading green/red.
 */

test.use({ baseURL: BASE_URLS.CLOUD_URL })

/** True if the cloud bounced us to the auth wall (production / no bypass). */
async function isAuthWalled(page: import('@playwright/test').Page): Promise<boolean> {
  return /\/auth\/signin/.test(page.url())
}

// The battle cloud-dev image runs `next dev`, which COMPILES each route on its
// first request — the first /, /project/[id], /project/[id]/detail and
// /api/auth/* hits can take 20-40s. Warm them once up-front (long timeout) so
// the per-test navigations are fast and deterministic, not flaky.
test.describe('cloud dashboard — smoke', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    try {
      await signInCloudDevAdmin(page, BASE_URLS.CLOUD_URL).catch(() => false)
      for (const path of ['/', '/project/1', '/project/1/detail']) {
        await page
          .goto(`${BASE_URLS.CLOUD_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
          .catch(() => { /* warmup is best-effort */ })
      }
    } finally {
      await ctx.close()
    }
  })

  // Establish a dev-admin session before each UI test so the NextAuth middleware
  // (which gates all dashboard routes) lets us through. No-op if the cloud isn't
  // in dev mode — the per-test isAuthWalled() branches still handle that case.
  test.beforeEach(async ({ page }) => {
    await signInCloudDevAdmin(page, BASE_URLS.CLOUD_URL).catch(() => false)
  })

  test('home loads (project directory or signin)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    // Either the project directory renders, or we are redirected to signin.
    // Both are valid "the app is up" outcomes — assert the app responded with
    // a recognisable shell, not a 5xx/blank.
    if (await isAuthWalled(page)) {
      // Auth wall is itself a working page — confirm the signin surface renders.
      await expect(page).toHaveURL(/\/auth\/signin/)
      await expect(page.locator('body')).not.toBeEmpty()
      test.info().annotations.push({
        type: 'note',
        description: 'Cloud is auth-walled (production default). Set CLOUD_DEV_BYPASS=1 + CLOUD_NODE_ENV=development to test the dashboard UI.',
      })
      return
    }
    // Authed: the project directory should show at least one project card.
    // Project 1 is seeded; cards render the project name in an h3.
    await expect(page.locator('h3').first()).toBeVisible({ timeout: 20_000 })
  })

  test('project detail IO grid renders for project 1', async ({ page }) => {
    await page.goto('/project/1/detail', { waitUntil: 'domcontentloaded' })

    if (await isAuthWalled(page)) {
      test.skip(true, 'Cloud auth wall active — run with CLOUD_DEV_BYPASS=1 to test the dashboard UI.')
      return
    }

    // Confirmed on a live run (2026-06-29): the detail header always renders the
    // project name + an IO-count summary like "505 IO · 484P · 20F · 1NT", which
    // is proof the grid loaded its data. The per-row result Badges DO render but
    // the grid is virtualised AND the Filters panel can overlay them, so the
    // first matched badge is often `hidden` (a strict-mode visibility miss).
    // Assert the always-visible header summary instead.
    await expect(page.getByRole('heading', { name: /BATTLE MCM02|MCM/i }).first())
      .toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/\d+\s*IO\b/).first()).toBeVisible({ timeout: 30_000 })
  })

  test('basic navigation: home → project → detail', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    if (await isAuthWalled(page)) {
      test.skip(true, 'Cloud auth wall active — run with CLOUD_DEV_BYPASS=1 to test navigation.')
      return
    }

    // Click into a project. Cards expose an "Open" button (confirmed live) that
    // routes to /project/{id}/detail.
    const openBtn = page.getByRole('button', { name: /open/i }).first()
    await expect(openBtn).toBeVisible({ timeout: 20_000 })
    await openBtn.click()

    await expect(page).toHaveURL(/\/project\/\d+\/detail/, { timeout: 20_000 })
    // Same as the detail test: assert the always-visible IO-count header summary
    // rather than a virtualised (often hidden) result badge.
    await expect(page.getByText(/\d+\s*IO\b/).first()).toBeVisible({ timeout: 30_000 })
  })

  test('public sync read API is reachable (the connection backbone)', async ({ request }) => {
    // This is the always-public surface the field tool + observer use. It is the
    // canonical proof the cloud holds subsystem state regardless of the UI auth
    // wall. Requires the project API key (battle default: battle-key-mcm02).
    const apiKey = process.env.CLOUD_API_KEY ?? 'battle-key-mcm02'
    const res = await request.get(`${BASE_URLS.CLOUD_URL}/api/sync/subsystem/${SUBSYSTEM_ID}`, {
      headers: { 'X-API-Key': apiKey },
    })
    expect(res.ok(), `GET /api/sync/subsystem/${SUBSYSTEM_ID} -> ${res.status()}`).toBeTruthy()
    const body = await res.json()
    // Shape is the field tool's pull payload; just assert it parsed to an object/array.
    expect(body).toBeTruthy()
  })
})
