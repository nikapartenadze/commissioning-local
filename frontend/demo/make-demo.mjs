// Branded motion demo of the Commissioning Central Control hub.
// Records a webm "ad" with an animated cursor, live typing, captions, modals.
import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'

const OUT = path.resolve('demo/out')
fs.mkdirSync(OUT, { recursive: true })
const W = 1280, H = 720
const BASE = 'http://localhost:5173'

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function injectStage(page) {
  await page.addStyleTag({ content: `
    @keyframes demoRipple { from { transform: translate(-50%,-50%) scale(.2); opacity:.6 } to { transform: translate(-50%,-50%) scale(2.4); opacity:0 } }
    #demoCursor{position:fixed;left:${W/2}px;top:${H/2}px;width:26px;height:26px;z-index:2147483646;pointer-events:none;
      transition:left .9s cubic-bezier(.45,.05,.2,1),top .9s cubic-bezier(.45,.05,.2,1);filter:drop-shadow(0 2px 4px rgba(0,0,0,.55))}
    #demoCursor svg{width:100%;height:100%}
    #demoRipple{position:fixed;z-index:2147483645;width:46px;height:46px;border-radius:50%;background:radial-gradient(circle,rgba(218,165,32,.6),transparent 70%);pointer-events:none;opacity:0}
    #demoCap{position:fixed;left:50%;bottom:46px;transform:translateX(-50%) translateY(14px);z-index:2147483646;pointer-events:none;
      font-family:'IBM Plex Sans',system-ui,sans-serif;font-weight:600;font-size:19px;color:#fff;
      background:rgba(15,15,17,.85);backdrop-filter:blur(8px);border:1px solid rgba(218,165,32,.5);border-radius:12px;
      padding:12px 22px;opacity:0;transition:opacity .45s ease,transform .45s ease;box-shadow:0 10px 40px rgba(0,0,0,.5);max-width:80%;text-align:center}
    #demoCap.on{opacity:1;transform:translateX(-50%) translateY(0)}
    #demoCard{position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;
      background:radial-gradient(120% 120% at 50% 0%,#1a1407 0%,#0a0a0b 62%);opacity:0;transition:opacity .6s ease;font-family:'IBM Plex Sans',system-ui,sans-serif}
    #demoCard.on{opacity:1}
    #demoCard img{height:56px;filter:drop-shadow(0 4px 18px rgba(218,165,32,.4))}
    #demoCard .t{font-size:42px;font-weight:800;letter-spacing:-.5px;color:#fafafa;text-align:center;line-height:1.1;max-width:80%}
    #demoCard .s{font-size:20px;font-weight:500;color:#d6b15a;text-align:center}
    #demoCard .pill{display:flex;gap:10px;margin-top:6px}
    #demoCard .pill span{font-size:14px;font-weight:700;color:#0a0a0b;background:linear-gradient(180deg,#e9c45a,#caa33a);padding:7px 16px;border-radius:999px}
  `})
  await page.evaluate(() => {
    const c = document.createElement('div'); c.id='demoCursor'
    c.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 3l14 7-6 1.5L9.5 19 5 3z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>'
    document.body.appendChild(c)
    const r = document.createElement('div'); r.id='demoRipple'; document.body.appendChild(r)
    const cap = document.createElement('div'); cap.id='demoCap'; document.body.appendChild(cap)
    const card = document.createElement('div'); card.id='demoCard'
    card.innerHTML = '<img src="/logo_autstand.svg"/><div class="t"></div><div class="s"></div><div class="pill"></div>'
    document.body.appendChild(card)
    window.__demo = { c, r, cap, card }
  })
}

const asLoc = (page, t) => (typeof t === 'string' ? page.locator(t).first() : t)
async function cursorTo(page, target, opts = {}) {
  const box = await asLoc(page, target).boundingBox().catch(() => null)
  if (!box) return null
  const x = box.x + box.width * (opts.fx ?? 0.5), y = box.y + box.height * (opts.fy ?? 0.5)
  await page.evaluate(({x,y}) => { window.__demo.c.style.left = x+'px'; window.__demo.c.style.top = y+'px' }, {x,y})
  await sleep(950)
  return {x,y}
}
async function ripple(page, x, y) {
  await page.evaluate(({x,y}) => { const r = window.__demo.r; r.style.left=x+'px'; r.style.top=y+'px'; r.style.animation='none'; void r.offsetWidth; r.style.animation='demoRipple .6s ease-out' }, {x,y})
  await sleep(250)
}
async function click(page, target, opts = {}) {
  const loc = asLoc(page, target)
  const p = await cursorTo(page, loc, opts); if (p) await ripple(page, p.x, p.y)
  await loc.click({ timeout: 5000 }).catch(() => {})
  await sleep(450)
}
async function caption(page, text, hold = 2600) {
  await page.evaluate((t) => { window.__demo.cap.textContent = t; window.__demo.cap.classList.add('on') }, text)
  await sleep(hold)
}
async function captionOff(page) { await page.evaluate(() => window.__demo.cap.classList.remove('on')); await sleep(350) }
async function showCard(page, title, sub, pills = []) {
  await page.evaluate(({title,sub,pills}) => {
    const d = window.__demo.card
    d.querySelector('.t').textContent = title
    d.querySelector('.s').textContent = sub || ''
    d.querySelector('.pill').innerHTML = pills.map(p=>`<span>${p}</span>`).join('')
    d.classList.add('on')
  }, {title,sub,pills})
  await sleep(80)
}
async function hideCard(page) { await page.evaluate(() => window.__demo.card.classList.remove('on')); await sleep(650) }
async function typeSlow(page, target, text) {
  const loc = asLoc(page, target)
  await loc.click({ timeout: 4000 }).catch(()=>{})
  await loc.fill('').catch(()=>{})
  await loc.pressSequentially(text, { delay: 80 }).catch(()=>{})
  await sleep(450)
}
const cardOf = (page, name) => page.locator('.bg-card').filter({ has: page.getByText(name, { exact: true }) }).first()

const run = async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: 'dark', recordVideo: { dir: OUT, size: { width: W, height: H } } })
  const page = await ctx.newPage()
  await page.route('**/api/mcm', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE) }))

  await page.goto(`${BASE}/mcm`, { waitUntil: 'networkidle' }).catch(()=>{})
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.waitForTimeout(700)
  await injectStage(page)

  // 1 — intro
  await showCard(page, 'Commissioning Central Control', 'Every controller. One hub.', ['CONNECT','CONFIGURE','PROGRAM'])
  await sleep(3000); await hideCard(page)

  // 2 — the live fleet
  await caption(page, 'Open one address — see your whole fleet, live.', 2600)
  await cursorTo(page, cardOf(page, 'MCM05')); await sleep(300)
  await captionOff(page)

  // 3 — search
  await caption(page, 'Find any controller instantly.', 1600)
  await typeSlow(page, 'input[placeholder="Search controllers…"]', 'MCM05')
  await sleep(1300)
  await page.locator('input[placeholder="Search controllers…"]').first().fill('').catch(()=>{})
  await sleep(800); await captionOff(page)

  // 4 — Configure dialog
  await caption(page, 'Set a controller’s connection once…', 1800)
  await click(page, cardOf(page, 'MCM02').getByRole('button', { name: 'Configure' }))
  await page.getByRole('dialog').waitFor({ timeout: 5000 }).catch(()=>{})
  await sleep(700)
  await typeSlow(page, 'input[placeholder="192.168.5.107"]', '192.168.20.40')
  await captionOff(page)
  await caption(page, '…then everyone just clicks Connect. No typing, ever.', 2400)
  await cursorTo(page, page.getByRole('button', { name: 'Save & Connect' }))
  await sleep(700)
  await page.keyboard.press('Escape').catch(()=>{}); await sleep(600)
  await captionOff(page)

  // 5 — Program dialog (headline)
  await caption(page, 'Download programs to any PLC — right from the hub.', 2200)
  await click(page, cardOf(page, 'MCM01').getByRole('button', { name: 'Program' }))
  await page.getByRole('dialog').waitFor({ timeout: 5000 }).catch(()=>{})
  await sleep(900); await captionOff(page)

  await caption(page, 'Pick the project…', 1500)
  await cursorTo(page, page.locator('select').first())
  await page.locator('select').first().selectOption({ label: 'BaseProject' }).catch(()=>{})
  await sleep(900); await captionOff(page)

  await caption(page, 'Just an IP and a path — no Studio 5000 hunting.', 2400)
  await cursorTo(page, page.getByLabel('Controller IP address'))
  await sleep(700); await captionOff(page)

  await caption(page, 'Stop → write → back to RUN. One click.', 2200)
  await cursorTo(page, page.getByRole('button', { name: /Download program to controller/ }))
  await sleep(1200)
  await page.keyboard.press('Escape').catch(()=>{}); await sleep(600)
  await captionOff(page)

  // 6 — outro
  await showCard(page, 'Connect · Configure · Program', 'All in one place.', ['autStand'])
  await sleep(3200); await hideCard(page)

  await page.waitForTimeout(400)
  await ctx.close()
  await browser.close()

  const vids = fs.readdirSync(OUT).filter((f) => f.endsWith('.webm') && !f.startsWith('commissioning-central'))
  if (vids.length) {
    const newest = vids.map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs })).sort((a,b)=>b.t-a.t)[0].f
    const dest = path.join(OUT, 'commissioning-central-demo.webm')
    fs.copyFileSync(path.join(OUT, newest), dest)
    console.log('VIDEO:', dest, (fs.statSync(dest).size/1e6).toFixed(2)+'MB')
  } else console.log('NO VIDEO PRODUCED')
}
run().catch((e) => { console.error('DEMO FAILED:', e); process.exit(1) })
