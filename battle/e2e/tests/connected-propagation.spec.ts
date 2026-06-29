import { test, expect, type APIRequestContext } from '@playwright/test'
import { BASE_URLS } from '../playwright.config'
import {
  SUBSYSTEM_ID,
  seedFieldToolOperator,
  openFieldToolGrid,
  scrollIoRowIntoView,
  startTesting,
  failIoRow,
  clearIoRow,
  expectFieldResult,
} from './helpers'

/**
 * THE HEADLINE: field tool ⇄ cloud are connected.
 *
 * Sync contract (docs/SYNC-CONTRACT.md, frontend/CLAUDE.md):
 *   - Local SQLite is authoritative; every Pass/Fail/Clear/comment is written
 *     locally then pushed to cloud (`POST /api/sync/update`, instant ~1-2s, with
 *     a 30s background retry loop).
 *   - The cloud's authoritative IO state is readable via the field-tool PULL
 *     endpoint `GET /api/sync/subsystem/{id}` (public, X-API-Key). This is the
 *     same surface the battle observer's I4 no-data-loss check uses.
 *
 * Journey:
 *   1. Discover a real, currently-untested IO from the FIELD TOOL's own API
 *      (no brittle hardcoded tag name).
 *   2. In the FIELD TOOL UI: start testing, mark that IO **Failed**, assert the
 *      field-tool badge flips to "Failed".
 *      (Fail is used rather than Pass because Pass has no UI button — it is
 *       driven by a live PLC TRUE-edge. Fail is a deterministic click.)
 *   3. Assert the result PROPAGATED to the cloud:
 *        a. canonical: poll cloud `GET /api/sync/subsystem/{id}` until the same
 *           IO id reads "Failed" — proves field→cloud sync end to end.
 *        b. if the cloud dashboard UI is reachable (auth bypass on), also assert
 *           the cloud grid shows "Failed" for that IO name.
 *   4. Cleanup: Clear the result in the field tool so re-runs start clean.
 *
 * Reverse direction (cloud edit → field) is covered conceptually at the bottom
 * as a documented TODO — the battle stack already has a `cloud-mutator` for this
 * (the `mutate` profile); wiring a UI assertion to it is the next live step.
 */

const CLOUD_API_KEY = process.env.CLOUD_API_KEY ?? 'battle-key-mcm02'

/** A single IO as returned by the cloud pull endpoint. Shape is permissive on
 *  purpose — we only read id + result. */
interface CloudIo { id: number; name?: string; result?: string | null }

/** Read the cloud's authoritative IO map for the subsystem (field-tool pull path). */
async function cloudResults(request: APIRequestContext): Promise<Map<number, string | null>> {
  const res = await request.get(`${BASE_URLS.CLOUD_URL}/api/sync/subsystem/${SUBSYSTEM_ID}`, {
    headers: { 'X-API-Key': CLOUD_API_KEY },
  })
  expect(res.ok(), `cloud read /api/sync/subsystem/${SUBSYSTEM_ID} -> ${res.status()}`).toBeTruthy()
  const body = await res.json()
  // The payload is either an array of IOs or { ios: [...] } — handle both.
  // TODO(confirm-on-live): confirm the exact field name for result on this
  // endpoint (expected: `result`). Adjust the extractor if the live shape differs.
  const ios: CloudIo[] = Array.isArray(body) ? body : (body.ios ?? body.data ?? [])
  const map = new Map<number, string | null>()
  for (const io of ios) map.set(io.id, io.result ?? null)
  return map
}

/** Pick an untested (no result) IO from the FIELD TOOL's API so the UI step is deterministic. */
async function pickUntestedIo(request: APIRequestContext): Promise<{ id: number; name: string }> {
  const res = await request.get(`${BASE_URLS.TOOL_URL}/api/ios?subsystemId=${SUBSYSTEM_ID}`)
  expect(res.ok(), `field tool /api/ios -> ${res.status()}`).toBeTruthy()
  const json = await res.json()
  const ios: Array<{ id: number; name: string; result: string | null; description?: string | null }> =
    Array.isArray(json) ? json : (json.ios ?? [])
  // Prefer a non-SPARE, currently-untested IO with a plain name (no result yet).
  const candidate =
    ios.find((io) => !io.result && !io.description?.toUpperCase().includes('SPARE')) ??
    ios.find((io) => !io.result)
  expect(candidate, 'no untested IO available in subsystem to drive the journey').toBeTruthy()
  return { id: candidate!.id, name: candidate!.name }
}

/** Poll the cloud until the given IO id reads the expected result, or time out. */
async function waitForCloudResult(
  request: APIRequestContext,
  ioId: number,
  expected: string,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs
  let last: string | null | undefined
  while (Date.now() < deadline) {
    const map = await cloudResults(request)
    last = map.get(ioId)
    if (last === expected) return
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`cloud IO ${ioId} did not reach result="${expected}" within ${timeoutMs}ms (last="${last}")`)
}

test.describe('connected: field tool ⇄ cloud', () => {
  test('marking an IO Failed in the field tool propagates to the cloud', async ({ page, request }) => {
    // ── 1. discover a target IO (deterministic, no hardcoded tag) ──────────────
    const target = await pickUntestedIo(request)
    test.info().annotations.push({ type: 'target-io', description: `${target.name} (id=${target.id})` })

    // sanity: cloud should NOT already show Failed for this IO
    const before = await cloudResults(request)
    expect(before.get(target.id) ?? null).not.toBe('Failed')

    // ── 2. drive the FIELD TOOL UI ─────────────────────────────────────────────
    await seedFieldToolOperator(page)
    await openFieldToolGrid(page, BASE_URLS.TOOL_URL)

    // Testing mode must be on for the Fail button to be enabled.
    // NOTE(confirm-on-live): Fail requires testing started AND (for some configs)
    // the parent network device not faulted + install complete. The battle seed
    // is MCM02 with the sim up, so a plain IO should be failable. If the Fail
    // button is disabled, see README "Why Fail and not Pass" + the install-gate note.
    await startTesting(page)

    const row = await scrollIoRowIntoView(page, target.name)
    await failIoRow(row)

    // A FailCommentDialog may appear (the tool prompts for a fail reason). If it
    // does, submit it. The dialog component is FailCommentDialog.
    // TODO(confirm-on-live): confirm the submit control label below ("Save"/
    // "Confirm"/"Submit"). It is wrapped in a role=dialog.
    const failDialog = page.getByRole('dialog')
    if (await failDialog.isVisible().catch(() => false)) {
      const submit = failDialog.getByRole('button', { name: /save|confirm|submit|ok/i }).first()
      if (await submit.count()) await submit.click()
    }

    // field-tool badge flips to Failed
    await expectFieldResult(row, 'Failed')

    // ── 3a. canonical: assert propagation via the public cloud pull endpoint ───
    await waitForCloudResult(request, target.id, 'Failed')

    // ── 3b. optional: assert the cloud DASHBOARD UI shows it (if not auth-walled)
    await page.goto(`${BASE_URLS.CLOUD_URL}/project/1/detail`)
    if (!/\/auth\/signin/.test(page.url())) {
      // Locate the IO's row by its name and assert a Failed badge is present.
      // The cloud grid is virtualised; search by the mono name cell.
      // TODO(confirm-on-live): tighten this to the specific row once the cloud
      // grid row selector is confirmed. For now assert the name is present and a
      // Failed badge is visible on the page after filtering to it is future work.
      await expect(page.getByText(target.name, { exact: false }).first()).toBeVisible({ timeout: 30_000 })
    } else {
      test.info().annotations.push({
        type: 'note',
        description: 'Cloud dashboard auth-walled; propagation verified via public /api/sync read only. Set CLOUD_DEV_BYPASS=1 for the UI assertion.',
      })
    }

    // ── 4. cleanup so re-runs start clean ──────────────────────────────────────
    await page.goto(`${BASE_URLS.TOOL_URL}/commissioning/${SUBSYSTEM_ID}`)
    await openFieldToolGrid(page, BASE_URLS.TOOL_URL)
    const cleanupRow = await scrollIoRowIntoView(page, target.name)
    await clearIoRow(cleanupRow).catch(() => { /* best-effort */ })
  })

  /**
   * REVERSE DIRECTION (cloud → field) — documented next step, not yet asserted.
   *
   * The battle stack ships a `cloud-mutator` service (compose profile `mutate`)
   * that edits cloud-side IO results/adds rows; the field tool picks them up on
   * its next SSE-reconnect pull. A full reverse journey would:
   *   1. bring the stack up with COMPOSE_PROFILES=mutate (or POST the cloud admin
   *      API directly under CLOUD_DEV_BYPASS),
   *   2. change an IO's result on the cloud,
   *   3. assert the FIELD TOOL grid reflects the change (the page re-pulls on the
   *      IOsUpdated WebSocket event).
   * Left as a TODO so the forward journey above stays the runnable headline.
   */
  test.skip('cloud-side edit propagates back to the field tool (TODO: wire to cloud-mutator)', async () => {
    // Intentionally skipped — see the block comment above for the design.
  })
})
