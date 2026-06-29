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

test.describe('cloud dashboard — smoke', () => {
  // Establish a dev-admin session before each UI test so the NextAuth middleware
  // (which gates all dashboard routes) lets us through. No-op if the cloud isn't
  // in dev mode — the per-test isAuthWalled() branches still handle that case.
  test.beforeEach(async ({ page }) => {
    await signInCloudDevAdmin(page, BASE_URLS.CLOUD_URL).catch(() => false)
  })

  test('home loads (project directory or signin)', async ({ page }) => {
    await page.goto('/')
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
    await page.goto('/project/1/detail')

    if (await isAuthWalled(page)) {
      test.skip(true, 'Cloud auth wall active — run with CLOUD_DEV_BYPASS=1 to test the dashboard UI.')
      return
    }

    // The detail grid shares the row class convention with the field tool
    // (row-passed / row-failed / row-default) and renders result Badges.
    // Assert the grid surfaced data: either a result/Not Tested badge is visible
    // or at least one IO row exists.
    // TODO(confirm-on-live): confirm the grid container/row selector; the cloud
    // grid is virtualised (absolutely-positioned rows) like the field tool.
    const anyResultBadge = page.getByText(/^(Passed|Failed|Not Tested)$/).first()
    await expect(anyResultBadge).toBeVisible({ timeout: 30_000 })
  })

  test('basic navigation: home → project → detail', async ({ page }) => {
    await page.goto('/')
    if (await isAuthWalled(page)) {
      test.skip(true, 'Cloud auth wall active — run with CLOUD_DEV_BYPASS=1 to test navigation.')
      return
    }

    // Click into a project. Cards expose an "Open" button that routes to
    // /project/{id}/detail (see components/project-list.tsx).
    // TODO(confirm-on-live): if the card itself is the click target rather than
    // an "Open" button, switch to clicking the card's heading link.
    const openBtn = page.getByRole('button', { name: /open/i }).first()
    await expect(openBtn).toBeVisible({ timeout: 20_000 })
    await openBtn.click()

    await expect(page).toHaveURL(/\/project\/\d+\/detail/, { timeout: 20_000 })
    await expect(page.getByText(/^(Passed|Failed|Not Tested)$/).first()).toBeVisible({ timeout: 30_000 })
  })

  test('public sync read API is reachable (the connection backbone)', async ({ request }) => {
    // This is the always-public surface the field tool + observer use. It is the
    // canonical proof the cloud holds subsystem state regardless of the UI auth
    // wall. Requires the project API key (battle default: ***REMOVED***).
    const apiKey = process.env.CLOUD_API_KEY ?? '***REMOVED***'
    const res = await request.get(`${BASE_URLS.CLOUD_URL}/api/sync/subsystem/${SUBSYSTEM_ID}`, {
      headers: { 'X-API-Key': apiKey },
    })
    expect(res.ok(), `GET /api/sync/subsystem/${SUBSYSTEM_ID} -> ${res.status()}`).toBeTruthy()
    const body = await res.json()
    // Shape is the field tool's pull payload; just assert it parsed to an object/array.
    expect(body).toBeTruthy()
  })
})
