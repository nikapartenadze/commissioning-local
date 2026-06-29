import { type Page, type Locator, expect } from '@playwright/test'

/**
 * Shared helpers + the connection contract constants for the battle E2E suite.
 *
 * Selector notes (confirmed against the field-tool source 2026-06-29):
 *   - The field tool has NO data-testid attributes. It uses `data-tour="..."`
 *     hooks (io-grid, start-button, plc-status, cloud-status) plus role/text.
 *   - The IO grid is virtualised (absolutely-positioned <div> rows, not a
 *     <table>), so only on-screen rows exist in the DOM — a row must be
 *     scrolled/searched into view before it can be located.
 *   - Marking an IO **Pass** has no dedicated button — it is driven by a live
 *     PLC TRUE-edge while testing is active. **Fail** IS a clickable icon
 *     button (red AlertTriangle) once testing is started. So UI-driven
 *     mutations in these specs use Fail, which is deterministic.
 */

// Battle seed: project 1, subsystem 38 (real MCM02 data, ~1184 IOs).
export const SUBSYSTEM_ID = process.env.E2E_SUBSYSTEM_ID ?? '38'

// Operator identity is gated by a NamePrompt modal on first visit; the field
// tool persists the chosen name in localStorage['tester-name'] (see
// frontend/lib/user-context.tsx). Pre-seeding it skips the modal.
export const TESTER_NAME = process.env.E2E_TESTER_NAME ?? 'Playwright E2E'

/**
 * Bypass the field tool's "Who is testing?" NamePrompt by pre-seeding the
 * operator name into localStorage BEFORE any page script runs.
 * Must be called before `page.goto`.
 */
export async function seedFieldToolOperator(page: Page, name: string = TESTER_NAME) {
  await page.addInitScript((n) => {
    window.localStorage.setItem('tester-name', n)
  }, name)
}

/** Open the field-tool IO grid for a subsystem and wait for it to render. */
export async function openFieldToolGrid(page: Page, baseUrl: string, subsystemId = SUBSYSTEM_ID) {
  await page.goto(`${baseUrl}/commissioning/${subsystemId}`)
  // The grid container carries data-tour="io-grid".
  await expect(page.locator('[data-tour="io-grid"]')).toBeVisible({ timeout: 30_000 })
}

/**
 * Locate a virtualised IO row by its IO name. The row is the flex container
 * that holds a monospace cell with the exact IO name text.
 *
 * TODO(confirm-on-live): the exact ancestor depth of the row wrapper relative
 * to the name cell can shift if the grid markup changes. Verify against a live
 * run that this resolves to the ROW (the element carrying row-passed/row-failed
 * + the Fail/Clear buttons), not just the name cell. The grid is virtualised,
 * so call scrollIoRowIntoView() first for rows below the fold.
 */
export function ioRow(page: Page, ioName: string): Locator {
  // The name lives in a mono cell; the row is the nearest ancestor that also
  // contains the action buttons. `data-index` marks each virtual row wrapper.
  return page
    .locator('[data-tour="io-grid"] [data-index]')
    .filter({ hasText: ioName })
    .first()
}

/**
 * Scroll the virtualised grid until a row with the given IO name is rendered.
 * Returns the row locator. Bounded so a typo can't loop forever.
 */
export async function scrollIoRowIntoView(page: Page, ioName: string): Promise<Locator> {
  const grid = page.locator('[data-tour="io-grid"]')
  const row = ioRow(page, ioName)
  for (let i = 0; i < 40; i++) {
    if (await row.count()) {
      await row.scrollIntoViewIfNeeded()
      return row
    }
    await grid.evaluate((el) => el.scrollBy(0, el.clientHeight * 0.8))
    await page.waitForTimeout(150)
  }
  throw new Error(`IO row "${ioName}" not found after scrolling the grid`)
}

/** Start testing mode (enables the Fail/Clear buttons). Idempotent-ish. */
export async function startTesting(page: Page) {
  const startBtn = page.locator('[data-tour="start-button"]')
  await expect(startBtn).toBeVisible()
  // Button text toggles START → STOP. Only click when it shows START.
  if (await startBtn.getByText('START', { exact: false }).count()) {
    await startBtn.click()
    await expect(startBtn.getByText('STOP', { exact: false })).toBeVisible({ timeout: 15_000 })
  }
}

/** Click the red Fail button on a given IO row (requires testing mode on). */
export async function failIoRow(row: Locator) {
  // Fail button: ghost icon button with title containing "Failed" (red AlertTriangle).
  const failBtn = row.locator('button[title*="Failed"], button.text-red-600').first()
  await failBtn.click()
}

/** Click the blue Clear button on a given IO row. */
export async function clearIoRow(row: Locator) {
  const clearBtn = row.locator('button[title="Clear"], button.text-blue-500').first()
  await clearBtn.click()
}

/** Assert a field-tool IO row shows a given result badge ("Passed" | "Failed"). */
export async function expectFieldResult(row: Locator, result: 'Passed' | 'Failed') {
  await expect(row.getByText(result, { exact: true })).toBeVisible()
}

/**
 * Sign in to the cloud dashboard via the dev-admin NextAuth credentials provider.
 *
 * Confirmed against commissioning-cloud source (2026-06-29):
 *   - lib/auth.ts registers a `dev-admin` CredentialsProvider ONLY when
 *     NODE_ENV=development AND DEV_BYPASS_AUTH=true (the battle cloud-dev image
 *     run with CLOUD_NODE_ENV=development + CLOUD_DEV_BYPASS=true).
 *   - middleware.ts redirects every dashboard route to /auth/signin UNLESS a
 *     NextAuth JWT cookie is present — the env flag alone does NOT create a
 *     session, so we must actually sign in.
 *   - The signin PAGE only shows the dev-admin button when the *build-time*
 *     NEXT_PUBLIC_DEV_BYPASS_AUTH=true, which the battle image does not set, so
 *     we drive the NextAuth credentials callback directly (CSRF → callback),
 *     which works whenever the provider is registered.
 *
 * Returns true if a session cookie was established, false if dev-admin is not
 * available (cloud not in dev mode) — callers then keep the API-only path.
 */
export async function signInCloudDevAdmin(page: Page, cloudUrl: string): Promise<boolean> {
  const ctx = page.context()
  // 1. CSRF token (NextAuth requires it on the credentials callback POST).
  const csrfRes = await ctx.request.get(`${cloudUrl}/api/auth/csrf`)
  if (!csrfRes.ok()) return false
  const { csrfToken } = await csrfRes.json()
  if (!csrfToken) return false

  // 2. POST the dev-admin credentials callback (no credentials fields needed —
  //    the provider's authorize() returns the synthetic admin unconditionally).
  const cbRes = await ctx.request.post(`${cloudUrl}/api/auth/callback/dev-admin`, {
    form: { csrfToken, json: 'true', callbackUrl: `${cloudUrl}/` },
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,
  })
  // NextAuth returns 200/302 and Set-Cookie for the session on success.
  const sessionOk = cbRes.status() < 400 || cbRes.status() === 302

  // 3. Verify a real session exists (the cookie is now on the shared context).
  const sessionRes = await ctx.request.get(`${cloudUrl}/api/auth/session`)
  if (!sessionRes.ok()) return false
  const session = await sessionRes.json().catch(() => null)
  return Boolean(sessionOk && session && session.user)
}
