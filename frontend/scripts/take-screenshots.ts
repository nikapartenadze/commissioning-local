import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const BASE_URL = 'http://localhost:3000';
const GUIDE_DIR = path.join(__dirname, '..', 'public', 'guide');

async function main() {
  fs.mkdirSync(GUIDE_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
  });
  const page = await context.newPage();

  // 1. Login page
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(GUIDE_DIR, 'login.png') });
    console.log('✓ login.png');
  } catch (e) { console.error('✗ login.png:', (e as Error).message); }

  // 2. Log in
  try {
    const pinInput = page.locator('input[inputmode="numeric"]');
    await pinInput.fill('111111');
    const confirmBtn = page.locator('button').filter({ has: page.locator('svg.lucide-check') }).first();
    if (await confirmBtn.isVisible({ timeout: 2000 })) {
      await confirmBtn.click();
    } else {
      await page.locator('button[type="submit"], button:has-text("Log")').first().click();
    }
    await page.waitForURL('**/commissioning/**', { timeout: 10000 });
    await page.waitForTimeout(2000);
    console.log('✓ Logged in:', page.url());
  } catch (e) { console.error('✗ Login:', (e as Error).message); }

  // 3. IO grid
  try {
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(GUIDE_DIR, 'io-grid.png') });
    console.log('✓ io-grid.png');
  } catch (e) { console.error('✗ io-grid.png:', (e as Error).message); }

  // 4. Toolbar
  try {
    await page.screenshot({ path: path.join(GUIDE_DIR, 'toolbar.png'), clip: { x: 0, y: 0, width: 1280, height: 130 } });
    console.log('✓ toolbar.png');
  } catch (e) { console.error('✗ toolbar.png:', (e as Error).message); }

  // 5. PLC config dialog
  try {
    const plcBtn = page.locator('[data-tour="plc-status"]').first();
    if (await plcBtn.isVisible({ timeout: 3000 })) {
      await plcBtn.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(GUIDE_DIR, 'plc-config.png') });
      console.log('✓ plc-config.png');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  } catch (e) { console.error('✗ plc-config.png:', (e as Error).message); }

  // 6. Network tab
  try {
    const networkTab = page.locator('button:has-text("Network"), a:has-text("Network")').first();
    if (await networkTab.isVisible({ timeout: 3000 })) {
      await networkTab.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(GUIDE_DIR, 'network.png') });
      console.log('✓ network.png');
    }
  } catch (e) { console.error('✗ network.png:', (e as Error).message); }

  // 7-9. Screenshot actual dialog components from the hidden page
  try {
    await page.goto(`${BASE_URL}/guide/screenshots`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Pass/Fail dialog
    const passFailEl = page.locator('#pass-fail-dialog');
    if (await passFailEl.isVisible({ timeout: 3000 })) {
      await passFailEl.screenshot({ path: path.join(GUIDE_DIR, 'pass-fail-dialog.png') });
      console.log('✓ pass-fail-dialog.png');
    }

    // Fail comment dialog
    const failEl = page.locator('#fail-dialog');
    if (await failEl.isVisible({ timeout: 3000 })) {
      await failEl.screenshot({ path: path.join(GUIDE_DIR, 'fail-dialog.png') });
      console.log('✓ fail-dialog.png');
    }

    // Fire output
    const fireEl = page.locator('#fire-output');
    if (await fireEl.isVisible({ timeout: 3000 })) {
      await fireEl.screenshot({ path: path.join(GUIDE_DIR, 'fire-output.png') });
      console.log('✓ fire-output.png');
    }
  } catch (e) { console.error('✗ dialog screenshots:', (e as Error).message); }

  await browser.close();
  console.log('\nDone! Screenshots saved to:', GUIDE_DIR);
}

main().catch(console.error);
