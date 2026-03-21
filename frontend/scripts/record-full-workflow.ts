import { chromium } from 'playwright'
import path from 'path'
import fs from 'fs'

const BASE_URL = 'http://localhost:3000'
const GUIDE_DIR = path.join(__dirname, '..', 'public', 'guide')

async function safeStep(name: string, fn: () => Promise<void>) {
  try {
    console.log(`  → ${name}`)
    await fn()
  } catch (e) {
    console.warn(`  ⚠ Step "${name}" failed: ${(e as Error).message}`)
    await new Promise(r => setTimeout(r, 1000))
  }
}

async function main() {
  fs.mkdirSync(GUIDE_DIR, { recursive: true })

  console.log('\n📹 Recording: flow-full-workflow')
  const browser = await chromium.launch({ headless: true })
  const videoDir = '/tmp/guide-full-workflow-' + Date.now()
  fs.mkdirSync(videoDir, { recursive: true })

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  })
  const page = await context.newPage()

  try {
    // 1. Navigate to app (show login page)
    await safeStep('Navigate to login page', async () => {
      await page.goto(BASE_URL, { waitUntil: 'networkidle' })
      await page.waitForTimeout(1000)
    })

    // 2. Enter PIN 222222 digit by digit
    await safeStep('Enter PIN 222222', async () => {
      const digits = '222222'.split('')
      for (const digit of digits) {
        await page.locator(`button:has-text("${digit}")`).first().click()
        await page.waitForTimeout(300)
      }
      await page.waitForTimeout(1000)
    })

    // 3. Click confirm
    await safeStep('Click confirm button', async () => {
      const btns = await page.locator('button').all()
      for (const btn of btns) {
        if (await btn.locator('svg.lucide-check').count() > 0) {
          await btn.click()
          break
        }
      }
      await page.waitForTimeout(3000)
    })

    // 4. Show the IO grid
    await safeStep('Show IO grid', async () => {
      await page.waitForTimeout(2000)
    })

    // 5. Scroll down slowly
    await safeStep('Scroll down slowly', async () => {
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, 200)
        await page.waitForTimeout(300)
      }
      await page.waitForTimeout(1000)
    })

    // 6. Scroll back up
    await safeStep('Scroll back up', async () => {
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, -200)
        await page.waitForTimeout(300)
      }
      await page.waitForTimeout(1000)
    })

    // 7. Click search bar and type "FIOM" slowly
    await safeStep('Search for FIOM', async () => {
      const searchInput = page.locator('input[placeholder*="earch"], input[placeholder*="ilter"], input[type="search"], input[type="text"]').first()
      await searchInput.click()
      await page.waitForTimeout(300)
      for (const char of 'FIOM') {
        await searchInput.press(char)
        await page.waitForTimeout(200)
      }
      await page.waitForTimeout(2000)
    })

    // 8. Clear search
    await safeStep('Clear search', async () => {
      const searchInput = page.locator('input[placeholder*="earch"], input[placeholder*="ilter"], input[type="search"], input[type="text"]').first()
      // Try clicking a clear button first, fall back to triple-select + delete
      const clearBtn = page.locator('button:has(svg.lucide-x)').first()
      if (await clearBtn.isVisible({ timeout: 500 })) {
        await clearBtn.click()
      } else {
        await searchInput.fill('')
      }
      await page.waitForTimeout(1000)
    })

    // 9. Click Network tab
    await safeStep('Click Network tab', async () => {
      const networkTab = page.locator('button:has-text("Network"), a:has-text("Network")').first()
      if (await networkTab.isVisible({ timeout: 2000 })) {
        await networkTab.click()
        await page.waitForTimeout(2000)
      }
    })

    // 10. Click IO Testing tab
    await safeStep('Click IO Testing tab', async () => {
      const ioTab = page.locator('button:has-text("I/O Testing"), button:has-text("IO Testing"), a:has-text("I/O Testing")').first()
      if (await ioTab.isVisible({ timeout: 2000 })) {
        await ioTab.click()
        await page.waitForTimeout(1000)
      }
    })

    // 11. Final state
    await safeStep('Show final state', async () => {
      await page.waitForTimeout(2000)
    })

  } catch (e) {
    console.error(`  ✗ Fatal error: ${(e as Error).message}`)
  }

  await page.close()
  await context.close()

  const videos = fs.readdirSync(videoDir).filter(f => f.endsWith('.webm'))
  if (videos.length > 0) {
    const src = path.join(videoDir, videos[0])
    const dest = path.join(GUIDE_DIR, 'flow-full-workflow.webm')
    fs.copyFileSync(src, dest)
    console.log(`  ✓ flow-full-workflow.webm (${(fs.statSync(dest).size / 1024).toFixed(0)}K)`)
  } else {
    console.error('  ✗ No video file generated')
  }

  fs.rmSync(videoDir, { recursive: true, force: true })
  await browser.close()
  console.log('\n✅ Done!')
}

main().catch(console.error)
