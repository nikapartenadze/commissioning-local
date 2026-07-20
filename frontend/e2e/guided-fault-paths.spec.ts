/**
 * Guided Mode — fault-path E2E.
 *
 * WHY THIS FILE EXISTS
 * guided-task-runner.tsx is ~1500 lines and had NO test coverage. Both CRITICAL
 * defects found in the 2026-07-20 audit lived in it, and every fix below is a
 * behaviour that only appears when a request FAILS — which unit tests in a
 * `node` vitest env cannot reach and a human cannot easily trigger on a healthy
 * rig. Playwright's request interception forces each fault deterministically.
 *
 * SCOPE: read-only against the app. It records no results and writes nothing to
 * the PLC; the only mutation is a firmware verdict, which by design persists
 * nothing. Never point this at production — see BASE_URL.
 *
 * RUN:
 *   npx playwright test e2e/guided-fault-paths.spec.ts
 *   BASE_URL=http://localhost:5173 SUBSYSTEM_ID=40 npx playwright test e2e/...
 */
import { test, expect, type Page } from '@playwright/test'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const SUBSYSTEM_ID = process.env.SUBSYSTEM_ID ?? '40'
const GUIDED = `${BASE_URL}/commissioning/${SUBSYSTEM_ID}/guided`

// Refuse to run against anything that looks like production.
test.beforeAll(() => {
  if (/autstand\.com|45\.153\.24\.190/i.test(BASE_URL)) {
    throw new Error(`Refusing to run fault-injection E2E against ${BASE_URL}`)
  }
})

async function openGuided(page: Page) {
  await page.goto(GUIDED, { waitUntil: 'domcontentloaded' })
  // exact: the readiness banner also contains "guided mode is not fully set up",
  // which makes a substring match ambiguous under Playwright strict mode.
  await expect(page.getByText('GUIDED MODE', { exact: true })).toBeVisible({ timeout: 20_000 })
}

/** The task pool, read straight from the API (the server is the source of truth). */
async function taskState(page: Page, taskIdPrefix: string) {
  const res = await page.request.get(
    `${BASE_URL}/api/guided/tasks?subsystemId=${SUBSYSTEM_ID}`,
  )
  const body = await res.json()
  return body.tasks?.find((t: any) => t.id.startsWith(taskIdPrefix))?.state ?? null
}

test.describe('firmware verdict (CRITICAL regression lock)', () => {
  /**
   * Before the fix: RECORD FAIL matched no branch in persistResult, made ZERO
   * network calls, showed "Device failed, added to punchlist", and completed
   * the task — making a FAIL byte-identical to a PASS.
   */
  test('a FAIL is honest and leaves the task OPEN', async ({ page }) => {
    await openGuided(page)
    const fail = page.getByRole('button', { name: 'RECORD FAIL' })
    test.skip(!(await fail.count()), 'firmware task not the active step on this rig')

    await fail.click()

    // The popup must NOT claim a punchlist entry that was never created.
    await expect(page.getByText(/NON-COMPLIANT/i)).toBeVisible()
    await expect(page.getByText(/stays open/i)).toBeVisible()
    await expect(page.getByText(/added to punchlist/i)).toHaveCount(0)

    await page.getByRole('button', { name: 'OK' }).click()

    // The decisive assertion: a failed firmware check is NOT done.
    await expect
      .poll(() => taskState(page, 'firmware_check:'), { timeout: 15_000 })
      .toBe('available')
  })
})

test.describe('D4/D5 safety gates must fail CLOSED, not open', () => {
  /**
   * Before the fix the poll did `if (!r.ok) return /* keep last status *\/`, so
   * a ring that faulted AFTER the poll died still rendered "RING NOMINAL" and
   * the blocking overlay never appeared. Staleness must be surfaced, never
   * papered over with the last good reading.
   */
  test('a dead status poll degrades the ring chip to NO READING', async ({ page }) => {
    // Serve one healthy reading so the chip has something good to go stale.
    let healthyServed = false
    await page.route('**/api/guided/system-status*', async (route) => {
      if (!healthyServed) {
        healthyServed = true
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ring: { state: 'nominal' }, systemRunning: true }),
        })
      }
      return route.abort('failed') // poll is now dead
    })

    await openGuided(page)
    await expect(page.getByText(/DPM RING NOMINAL/i)).toBeVisible({ timeout: 15_000 })

    // STALE_AFTER_MS is 20s (4 missed 5s polls); allow margin.
    await expect(page.getByText(/DPM RING\s*[—-]\s*NO READING/i)).toBeVisible({
      timeout: 45_000,
    })
    // It must NOT still be asserting health.
    await expect(page.getByText(/DPM RING NOMINAL/i)).toHaveCount(0)
  })
})

test.describe('failed writes are surfaced, never silent', () => {
  /**
   * fire-output was fire-and-forget. With the PLC down the route returns 503,
   * nothing energises, and the tester — seeing a dark beacon — records a Fail
   * against a HEALTHY device while the real fault goes unrecorded.
   */
  test('a 503 on fire-output warns and tells the tester NOT to record a Fail', async ({ page }) => {
    await page.route('**/api/ios/*/fire-output', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'PLC not connected' }),
      }),
    )
    await openGuided(page)
    const fire = page.getByRole('button', { name: 'FIRE OUTPUT' })
    test.skip(!(await fire.count()), 'no output step in this rig’s pool')

    await fire.click()
    await expect(page.getByText(/Output was NOT fired/i)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/do NOT record a Fail/i)).toBeVisible()
  })

  /** The skip dialog closed on a 400, discarding the tester's reason silently. */
  test('a rejected skip keeps the task active and says so', async ({ page }) => {
    await page.route('**/api/guided/tasks/skip', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Reason too long' }),
      }),
    )
    await openGuided(page)
    const skip = page.getByRole('button', { name: 'SKIP TASK' })
    test.skip(!(await skip.count()), 'no skippable task active')

    await skip.click()
    const dialog = page.locator('.gt-skip-dialog')
    await expect(dialog).toBeVisible()

    // A preset must be chosen or "Skip Task" stays disabled (reason required).
    await dialog.locator('.gt-skip-preset').first().click()
    // Scope to the dialog: the runner's own trigger is also named "SKIP TASK".
    await dialog.getByRole('button', { name: 'Skip Task' }).click()

    await expect(page.getByText(/Task was NOT skipped/i)).toBeVisible({ timeout: 10_000 })
    // And the dialog must stay open — the tester's reason is not discarded.
    await expect(dialog).toBeVisible()
  })

  /**
   * Guided WROTE into the L2 outbox but never drained it — replayL2Outbox was
   * called only from the FV Validation view, so a guided-only tester's failed
   * functional check sat in localStorage forever and was recovered only by
   * chance, if that tablet later happened to open the FV grid.
   *
   * Tested by planting a pending edit BEFORE load (the state a tester would
   * leave behind after a failed save) and asserting the runner drains it on
   * mount. Doing it this way tests the replay wiring itself and does not
   * depend on a functional task being workable in whatever rig we point at.
   */
  test('a pending outbox edit is replayed on mount', async ({ page }) => {
    let replayAttempts = 0
    await page.route('**/api/l2/cell', (route) => {
      replayAttempts++
      return route.fulfill({ status: 500, body: '{}' })
    })

    await page.addInitScript(() => {
      window.localStorage.setItem(
        'l2-cell-outbox-v1',
        JSON.stringify({
          '9999:8888': {
            deviceId: 9999,
            columnId: 8888,
            value: 'Pass',
            updatedBy: 'e2e',
            ts: Date.now(),
            attempts: 0,
          },
        }),
      )
    })

    await openGuided(page)

    // The decisive assertion: the runner drains the outbox WITHOUT the tester
    // ever visiting the FV grid. Before the fix this stayed at 0 forever.
    await expect.poll(() => replayAttempts, { timeout: 30_000 }).toBeGreaterThan(0)
  })
})
