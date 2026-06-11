// Capture branded screenshots for the user guide PDF.
import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'

const SHOTS = path.resolve('demo/shots')
fs.mkdirSync(SHOTS, { recursive: true })
const BASE = 'http://localhost:5173'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const FAKE = {
  success: true, count: 6, mcms: [
    { subsystemId: '101', name: 'MCM01', ip: '192.168.5.106', path: '1,0', enabled: true, connected: true,  status: 'connected',  tagCount: 342 },
    { subsystemId: '102', name: 'MCM02', ip: '192.168.20.40', path: '1,0', enabled: true, connected: false, status: 'connecting', tagCount: 0 },
    { subsystemId: '103', name: 'MCM03', ip: '192.168.20.41', path: '1,0', enabled: true, connected: true,  status: 'connected',  tagCount: 287 },
    { subsystemId: '104', name: 'MCM04', ip: '192.168.20.42', path: '1,0', enabled: true, connected: false, status: 'disconnected', tagCount: 0 },
    { subsystemId: '105', name: 'MCM05', ip: '192.168.20.43', path: '1,0', enabled: true, connected: true,  status: 'connected',  tagCount: 511 },
    { subsystemId: '106', name: 'MCM06', ip: '192.168.20.44', path: '1,0', enabled: true, connected: false, status: 'error', tagCount: 0 },
  ],
}

const run = async () => {
  const browser = await chromium.launch()

  // ---- hub + dialogs (dark, faked fleet) ----
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 820 }, colorScheme: 'dark', deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  await page.route('**/api/mcm', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE) }))
  await page.goto(`${BASE}/mcm`, { waitUntil: 'networkidle' }).catch(()=>{})
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await sleep(900)
  await page.screenshot({ path: `${SHOTS}/hub-dark.png` })

  const cardOf = (n) => page.locator('.bg-card').filter({ has: page.getByText(n, { exact: true }) }).first()
  await cardOf('MCM02').getByRole('button', { name: 'Configure' }).click().catch(()=>{})
  await page.getByRole('dialog').waitFor({ timeout: 5000 }).catch(()=>{})
  await page.getByPlaceholder('192.168.5.107').fill('192.168.20.40').catch(()=>{})
  await sleep(500)
  await page.screenshot({ path: `${SHOTS}/configure-dialog.png` })
  await page.keyboard.press('Escape'); await sleep(500)

  await cardOf('MCM01').getByRole('button', { name: 'Program' }).click().catch(()=>{})
  await page.getByRole('dialog').waitFor({ timeout: 5000 }).catch(()=>{})
  await page.locator('select').first().selectOption({ label: 'BaseProject' }).catch(()=>{})
  await sleep(600)
  await page.screenshot({ path: `${SHOTS}/program-dialog.png` })
  await page.keyboard.press('Escape'); await sleep(400)
  await ctx.close()

  // ---- hub light ----
  const ctxL = await browser.newContext({ viewport: { width: 1366, height: 820 }, colorScheme: 'light', deviceScaleFactor: 2 })
  const pL = await ctxL.newPage()
  await pL.route('**/api/mcm', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE) }))
  await pL.goto(`${BASE}/mcm`, { waitUntil: 'networkidle' }).catch(()=>{})
  await pL.evaluate(() => document.documentElement.classList.remove('dark'))
  await sleep(800)
  await pL.screenshot({ path: `${SHOTS}/hub-light.png` })
  await ctxL.close()

  // ---- empty state ----
  const ctxE = await browser.newContext({ viewport: { width: 1366, height: 820 }, colorScheme: 'dark', deviceScaleFactor: 2 })
  const pE = await ctxE.newPage()
  await pE.route('**/api/mcm', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, count: 0, mcms: [] }) }))
  await pE.goto(`${BASE}/mcm`, { waitUntil: 'networkidle' }).catch(()=>{})
  await pE.evaluate(() => document.documentElement.classList.add('dark'))
  await sleep(800)
  await pE.screenshot({ path: `${SHOTS}/empty-state.png` })
  await ctxE.close()

  // ---- settings: cloud connection / API key ----
  const ctxS = await browser.newContext({ viewport: { width: 1366, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 })
  const pS = await ctxS.newPage()
  await pS.goto(`${BASE}/settings/mcms`, { waitUntil: 'networkidle' }).catch(()=>{})
  await pS.evaluate(() => document.documentElement.classList.add('dark'))
  await sleep(900)
  await pS.screenshot({ path: `${SHOTS}/settings.png` })
  await ctxS.close()

  // ---- SDK-unavailable program state ----
  const ctxN = await browser.newContext({ viewport: { width: 1366, height: 820 }, colorScheme: 'dark', deviceScaleFactor: 2 })
  const pN = await ctxN.newPage()
  await pN.route('**/api/mcm', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE) }))
  await pN.route('**/api/controller-management/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok:false, installed:false, reason:'Python venv not found — Logix Designer SDK is not installed on this station.' }) }))
  await pN.goto(`${BASE}/mcm`, { waitUntil: 'networkidle' }).catch(()=>{})
  await pN.evaluate(() => document.documentElement.classList.add('dark'))
  await sleep(700)
  const cardOfN = (n) => pN.locator('.bg-card').filter({ has: pN.getByText(n, { exact: true }) }).first()
  await cardOfN('MCM01').getByRole('button', { name: 'Program' }).click().catch(()=>{})
  await pN.getByRole('dialog').waitFor({ timeout: 5000 }).catch(()=>{})
  await sleep(600)
  await pN.screenshot({ path: `${SHOTS}/sdk-unavailable.png` })
  await ctxN.close()

  await browser.close()
  console.log('SHOTS:', fs.readdirSync(SHOTS).join(', '))
}
run().catch((e) => { console.error('CAPTURE FAILED:', e); process.exit(1) })
