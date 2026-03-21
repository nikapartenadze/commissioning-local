import { chromium } from 'playwright'
import path from 'path'
import fs from 'fs'

const BASE_URL = 'http://localhost:3000'
const GUIDE_DIR = path.join(__dirname, '..', 'public', 'guide')

async function recordFlow(name: string, pin: string, actions: (page: any) => Promise<void>) {
  console.log(`\n📹 Recording: ${name}`)
  const browser = await chromium.launch({ headless: true })
  const videoDir = '/tmp/guide-videos-' + Date.now()
  fs.mkdirSync(videoDir, { recursive: true })

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  })
  const page = await context.newPage()

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)

    if (!page.url().includes('commissioning')) {
      const pinInput = page.locator('input[inputmode="numeric"]')
      if (await pinInput.isVisible({ timeout: 3000 })) {
        for (const digit of pin.split('')) {
          await page.locator(`button:has-text("${digit}")`).first().click()
          await page.waitForTimeout(250)
        }
        await page.waitForTimeout(300)
        const btns = await page.locator('button').all()
        for (const btn of btns) {
          if (await btn.locator('svg.lucide-check').count() > 0) { await btn.click(); break }
        }
        await page.waitForTimeout(3000)
      }
    }

    await actions(page)
  } catch (e) {
    console.error(`  ✗ Error: ${(e as Error).message}`)
  }

  await page.close()
  await context.close()

  const videos = fs.readdirSync(videoDir).filter(f => f.endsWith('.webm'))
  if (videos.length > 0) {
    const src = path.join(videoDir, videos[0])
    const dest = path.join(GUIDE_DIR, `${name}.webm`)
    fs.copyFileSync(src, dest)
    console.log(`  ✓ ${name}.webm (${(fs.statSync(dest).size / 1024).toFixed(0)}K)`)
  }

  fs.rmSync(videoDir, { recursive: true, force: true })
  await browser.close()
}

async function main() {
  fs.mkdirSync(GUIDE_DIR, { recursive: true })

  // Technician login (what they actually see)
  await recordFlow('flow-tech-login', '222222', async (page) => {
    await page.waitForTimeout(2000)
  })

  // Technician navigating
  await recordFlow('flow-tech-navigate', '222222', async (page) => {
    await page.waitForTimeout(1000)
    const networkTab = page.locator('button:has-text("Network"), a:has-text("Network")').first()
    if (await networkTab.isVisible({ timeout: 2000 })) {
      await networkTab.click()
      await page.waitForTimeout(2000)
    }
    const ioTab = page.locator('button:has-text("I/O Testing"), button:has-text("IO Testing")').first()
    if (await ioTab.isVisible({ timeout: 2000 })) {
      await ioTab.click()
      await page.waitForTimeout(1500)
    }
  })

  // Technician search
  await recordFlow('flow-tech-search', '222222', async (page) => {
    await page.waitForTimeout(1000)
    const searchInput = page.locator('input[placeholder*="earch"], [data-tour="search-area"] input').first()
    if (await searchInput.isVisible({ timeout: 3000 })) {
      await searchInput.click()
      await page.waitForTimeout(300)
      for (const char of 'VFD') {
        await page.keyboard.type(char, { delay: 200 })
      }
      await page.waitForTimeout(2000)
      await searchInput.fill('')
      await page.waitForTimeout(1000)
    }
  })

  // Admin config dialog
  await recordFlow('flow-admin-config', '111111', async (page) => {
    await page.waitForTimeout(1000)
    const plcBtn = page.locator('[data-tour="plc-status"]').first()
    if (await plcBtn.isVisible({ timeout: 2000 })) {
      await plcBtn.click()
      await page.waitForTimeout(2000)
      const plcTab = page.locator('button:has-text("PLC Connection")').first()
      if (await plcTab.isVisible({ timeout: 2000 })) {
        await plcTab.click()
        await page.waitForTimeout(2000)
      }
      const cloudTab = page.locator('button:has-text("Cloud Data")').first()
      if (await cloudTab.isVisible({ timeout: 2000 })) {
        await cloudTab.click()
        await page.waitForTimeout(1500)
      }
      await page.keyboard.press('Escape')
    }
  })

  // Technician screenshots
  console.log('\n📸 Technician screenshots...')
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' })
  const page = await ctx.newPage()
  await page.goto(BASE_URL, { waitUntil: 'networkidle' })
  if (!page.url().includes('commissioning')) {
    const pinInput = page.locator('input[inputmode="numeric"]')
    if (await pinInput.isVisible({ timeout: 3000 })) {
      await pinInput.fill('222222')
      const btns = await page.locator('button').all()
      for (const btn of btns) {
        if (await btn.locator('svg.lucide-check').count() > 0) { await btn.click(); break }
      }
      await page.waitForTimeout(3000)
    }
  }
  await page.screenshot({ path: path.join(GUIDE_DIR, 'tech-io-grid.png') })
  console.log('  ✓ tech-io-grid.png')
  await page.screenshot({ path: path.join(GUIDE_DIR, 'tech-toolbar.png'), clip: { x: 0, y: 0, width: 1280, height: 130 } })
  console.log('  ✓ tech-toolbar.png')
  await browser.close()

  console.log('\n✅ Done!')
}

main().catch(console.error)
