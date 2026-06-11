// Build the branded "Commissioning Tool — User Guide" PDF.
import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'

const SHOTS = path.resolve('demo/shots')
const OUT = path.resolve('demo/out')
fs.mkdirSync(OUT, { recursive: true })

const img = (name, mime = 'image/png') => {
  const p = path.join(SHOTS, name)
  if (!fs.existsSync(p)) return ''
  return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`
}
const logo = (() => {
  const p = path.resolve('public/logo_autstand.svg')
  return fs.existsSync(p) ? `data:image/svg+xml;base64,${fs.readFileSync(p).toString('base64')}` : ''
})()

const shot = (name, caption) => `
  <figure class="shot">
    <img src="${img(name)}"/>
    ${caption ? `<figcaption>${caption}</figcaption>` : ''}
  </figure>`

const GOLD = '#b8902f'

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --gold:${GOLD}; --ink:#1a1a1e; --muted:#5b5b63; --line:#e3ddcf; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html,body { margin:0; padding:0; font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif; color:var(--ink); font-size:11pt; line-height:1.55; }
  h1,h2,h3 { font-weight:800; letter-spacing:-.2px; color:#15151a; }
  h2 { font-size:19pt; margin:0 0 4px; padding-top:4px; }
  h3 { font-size:13pt; margin:18px 0 4px; color:#26262c; }
  p { margin:6px 0; }
  .muted { color:var(--muted); }
  .gold { color:var(--gold); }
  code, .mono { font-family:'Consolas','SF Mono',monospace; font-size:.92em; background:#f4efe2; padding:1px 5px; border-radius:4px; }

  /* cover */
  .cover { height:1020px; background:radial-gradient(120% 90% at 50% 0%, #1c160a 0%, #0b0b0d 60%); color:#fff; display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; page-break-after:always; }
  .cover img { height:62px; margin-bottom:34px; filter:drop-shadow(0 6px 22px rgba(184,144,47,.45)); }
  .cover .title { font-size:40pt; font-weight:800; line-height:1.05; max-width:720px; }
  .cover .sub { font-size:16pt; color:#d9bd71; margin-top:14px; font-weight:500; }
  .cover .pills { margin-top:30px; display:flex; gap:12px; }
  .cover .pills span { font-size:11pt; font-weight:700; color:#0b0b0d; background:linear-gradient(180deg,#e9c45a,#caa33a); padding:9px 20px; border-radius:999px; }
  .cover .ver { position:relative; margin-top:54px; font-size:10pt; color:#8a8a92; letter-spacing:.5px; }

  /* layout */
  .page { padding:42px 54px; }
  .section { page-break-before:always; }
  .lead { font-size:11.5pt; color:#3a3a42; }
  .kicker { font-size:9pt; font-weight:800; letter-spacing:2px; text-transform:uppercase; color:var(--gold); margin-bottom:2px; }
  .rule { height:3px; width:54px; background:var(--gold); border-radius:2px; margin:10px 0 16px; }

  ul { margin:6px 0 6px 18px; padding:0; } li { margin:4px 0; }
  ol { margin:6px 0 6px 20px; } ol li { margin:6px 0; }

  .shot { margin:16px 0; page-break-inside:avoid; }
  .shot img { width:100%; border:1px solid var(--line); border-radius:8px; box-shadow:0 4px 18px rgba(0,0,0,.08); }
  .shot figcaption { font-size:9pt; color:var(--muted); margin-top:6px; text-align:center; }

  .callout { border-left:4px solid var(--gold); background:#faf6ea; padding:10px 14px; border-radius:0 8px 8px 0; margin:12px 0; page-break-inside:avoid; font-size:10.5pt; }
  .callout.warn { border-color:#c98a1e; background:#fdf4e3; }
  .callout.danger { border-color:#c0392b; background:#fbeae8; }
  .callout b { color:#15151a; }

  table { width:100%; border-collapse:collapse; margin:12px 0; font-size:10pt; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); }
  th { background:#f7f2e6; color:#2a2a30; font-weight:700; }

  .toc { columns:2; column-gap:40px; font-size:11pt; }
  .toc div { margin:7px 0; break-inside:avoid; }
  .toc .n { color:var(--gold); font-weight:800; margin-right:8px; }

  .step { display:flex; gap:12px; margin:10px 0; page-break-inside:avoid; }
  .step .num { flex:none; width:26px; height:26px; border-radius:50%; background:var(--gold); color:#fff; font-weight:800; display:flex; align-items:center; justify-content:center; font-size:11pt; }
  .step .body { flex:1; }
  .badge { display:inline-block; font-size:8.5pt; font-weight:700; padding:2px 8px; border-radius:999px; }
  .b-green { background:#e2f3e6; color:#1d7a37; } .b-amber{ background:#fdeccf; color:#9a6a12;} .b-red{background:#fbe4e2;color:#b23528;} .b-gray{background:#ececec;color:#666;}
  footer.fp { position:fixed; bottom:0; left:0; right:0; }
</style></head><body>

<!-- COVER -->
<div class="cover">
  ${logo ? `<img src="${logo}"/>` : '<div style="font-size:30pt;font-weight:800;color:#e9c45a">autStand</div>'}
  <div class="title">Commissioning Tool</div>
  <div class="sub">Operator &amp; Administrator Guide</div>
  <div class="pills"><span>CENTRAL CONTROL</span><span>FIELD TESTING</span><span>PLC PROGRAMMING</span></div>
  <div class="ver">Field commissioning system · Central hub + offline field client</div>
</div>

<!-- TOC -->
<div class="page">
  <div class="kicker">Contents</div>
  <h2>What's inside</h2>
  <div class="rule"></div>
  <div class="toc">
    <div><span class="n">1</span>Overview &amp; how it fits together</div>
    <div><span class="n">2</span>Getting started</div>
    <div><span class="n">3</span>The Central Control hub</div>
    <div><span class="n">4</span>Connecting to a controller</div>
    <div><span class="n">5</span>Configuring a controller</div>
    <div><span class="n">6</span>Programming a controller</div>
    <div><span class="n">7</span>Commissioning &amp; Guided Mode</div>
    <div><span class="n">8</span>Settings &amp; administration</div>
    <div><span class="n">9</span>Sync &amp; offline operation</div>
    <div><span class="n">10</span>Troubleshooting</div>
    <div><span class="n">11</span>Quick reference</div>
  </div>
</div>

<!-- 1 OVERVIEW -->
<div class="page section">
  <div class="kicker">Section 1</div><h2>Overview &amp; how it fits together</h2><div class="rule"></div>
  <p class="lead">The Commissioning Tool is a field system for bringing PLC-controlled machines online. It connects to Allen-Bradley controllers over Ethernet/IP, streams live tag states, lets technicians mark every I/O point pass/fail, and syncs results to the central cloud.</p>
  <h3>Two faces, one data model</h3>
  <ul>
    <li><b>Central Control hub</b> — a single screen listing every controller (MCM) in the project. Connect, configure, and program any of them from one place.</li>
    <li><b>Field commissioning client</b> — the offline-first testing surface for a single subsystem: the live I/O grid, pass/fail marking, and Guided Mode.</li>
  </ul>
  <p>Both run from the same application. A technician opens the tool's address in a browser, picks a controller from the hub, and works. Everything is stored locally first (so a dropped network never loses data) and synced to the cloud in the background.</p>
  <div class="callout"><b>Who uses it.</b> Field technicians connect and test controllers; administrators set the cloud project key, manage accounts, and program controllers. Roles are explained in Section 8.</div>
  ${shot('hub-dark.png', 'The Central Control hub — every controller in the project, with live status.')}
</div>

<!-- 2 GETTING STARTED -->
<div class="page section">
  <div class="kicker">Section 2</div><h2>Getting started</h2><div class="rule"></div>
  <p class="lead">The tool runs on one machine (the “server laptop”). Everyone else just opens its address in a browser — the same address, every time.</p>
  <div class="step"><div class="num">1</div><div class="body"><b>Open the tool.</b> In a browser go to <code>http://&lt;server-ip&gt;:3000/mcm</code>. You land on the Central Control hub.</div></div>
  <div class="step"><div class="num">2</div><div class="body"><b>Connect to the cloud project.</b> First run only: an admin pastes the project API key (Section 8). This tells the tool which project it belongs to.</div></div>
  <div class="step"><div class="num">3</div><div class="body"><b>Import the controllers.</b> Click <b>Import</b> — every controller (MCM) in the project appears as a card.</div></div>
  <div class="step"><div class="num">4</div><div class="body"><b>Work.</b> Pick a controller, Connect, and start commissioning.</div></div>
  ${shot('empty-state.png', 'Before any controllers are imported, the hub guides you to Import from cloud.')}
  <div class="callout warn"><b>No controllers showing?</b> The project API key isn't set yet, or Import hasn't been run. See Section 8.</div>
</div>

<!-- 3 HUB -->
<div class="page section">
  <div class="kicker">Section 3</div><h2>The Central Control hub</h2><div class="rule"></div>
  <p class="lead">The hub is the home screen: one card per controller, each showing its live status, address, and the actions you can take.</p>
  <h3>Reading a card</h3>
  <p>Every card shows the controller name, its subsystem id, IP address, backplane path, and live tag count. The status badge tells you its state at a glance:</p>
  <p>
    <span class="badge b-green">Online</span> connected &amp; streaming tags &nbsp;
    <span class="badge b-amber">Connecting</span> reconnecting &nbsp;
    <span class="badge b-red">Error</span> connection problem &nbsp;
    <span class="badge b-gray">Offline</span> not connected
  </p>
  <h3>The header</h3>
  <ul>
    <li><b>Search</b> — filter the grid by name, id, or IP instantly.</li>
    <li><b>Connect all / Stop all</b> — bring the whole fleet up or down at once.</li>
    <li><b>Import</b> — pull the controller list from the cloud project.</li>
    <li><b>Gear / People icons</b> — Settings (cloud key, controllers) and Accounts.</li>
  </ul>
  ${shot('hub-light.png', 'The hub adapts to light and dark themes; the brand gold stays consistent.')}
</div>

<!-- 4 CONNECT -->
<div class="page section">
  <div class="kicker">Section 4</div><h2>Connecting to a controller</h2><div class="rule"></div>
  <p class="lead">Once a controller's address is set, connecting is one click — no typing, for anyone.</p>
  <div class="step"><div class="num">1</div><div class="body">Find the controller's card on the hub.</div></div>
  <div class="step"><div class="num">2</div><div class="body">Click <b>Connect</b>. The status badge turns <span class="badge b-green">Online</span> and the live tag count starts climbing.</div></div>
  <div class="step"><div class="num">3</div><div class="body">To take it offline, click <b>Disconnect</b>. Use <b>Stop all</b> in the header to disconnect the whole fleet.</div></div>
  <div class="callout"><b>Why no IP typing?</b> Each controller's IP and path are stored on the server once (Section 5). After that, every technician who opens the hub just clicks Connect.</div>
</div>

<!-- 5 CONFIGURE -->
<div class="page section">
  <div class="kicker">Section 5</div><h2>Configuring a controller</h2><div class="rule"></div>
  <p class="lead">Setting a controller's connection is a one-time job. After it's saved, it's shared by everyone.</p>
  <div class="step"><div class="num">1</div><div class="body">On the controller's card, click <b>Configure</b>.</div></div>
  <div class="step"><div class="num">2</div><div class="body">Enter the <b>IP address</b> and the <b>Path</b> (the backplane route to the CPU — commonly <code>1,0</code>).</div></div>
  <div class="step"><div class="num">3</div><div class="body">Click <b>Save</b> to store it, or <b>Save &amp; Connect</b> to store it, pull the station's I/O from the cloud, and connect in one step.</div></div>
  ${shot('configure-dialog.png', 'The Configure dialog: just an IP and a path. Saved once, shared by all.')}
  <div class="callout warn"><b>Path tip.</b> The path is the route across the chassis backplane to the controller CPU — usually <code>1,0</code> (port 1 = backplane, slot 0 = CPU).</div>
</div>

<!-- 6 PROGRAM -->
<div class="page section">
  <div class="kicker">Section 6</div><h2>Programming a controller</h2><div class="rule"></div>
  <p class="lead">Download a program to any controller directly from the hub — no separate engineering workstation hunt.</p>
  <div class="step"><div class="num">1</div><div class="body">On the controller's card, click <b>Program</b>.</div></div>
  <div class="step"><div class="num">2</div><div class="body">Pick the <b>project (.ACD)</b> from the list of programs on this station.</div></div>
  <div class="step"><div class="num">3</div><div class="body">Confirm the <b>IP address</b> and <b>Path</b> (pre-filled from the controller's config). The resolved communications path is shown beneath for transparency.</div></div>
  <div class="step"><div class="num">4</div><div class="body">Optionally <b>Read</b> the controller to see its current mode, or switch mode (<span class="badge b-amber">Program</span> / <span class="badge b-green">Run</span> / Test).</div></div>
  <div class="step"><div class="num">5</div><div class="body">Click <b>Download program to controller</b>. The tool stops the controller, writes the program, and returns it to <b>RUN</b> — with a live progress pipeline.</div></div>
  ${shot('program-dialog.png', 'The Program dialog: pick a project, confirm IP + path, download. Mode control and a staged progress pipeline are built in.')}
  <div class="callout danger"><b>Requires Studio 5000 + the Logix Designer SDK</b> on the machine running the tool. On a station without them, the Program dialog cleanly reports it's unavailable — and every other feature (connect, configure, test) keeps working normally.</div>
  ${shot('sdk-unavailable.png', 'Graceful degradation: on a station without the SDK, programming is clearly marked unavailable — nothing breaks.')}
</div>

<!-- 7 COMMISSIONING / GUIDED -->
<div class="page section">
  <div class="kicker">Section 7</div><h2>Commissioning &amp; Guided Mode</h2><div class="rule"></div>
  <p class="lead">From a controller's card, <b>Open</b> takes you into the field commissioning client for that subsystem.</p>
  <h3>The I/O grid</h3>
  <ul>
    <li>Every I/O point for the subsystem is listed with its <b>live state</b> streamed from the PLC.</li>
    <li>Technicians mark each point <span class="badge b-green">Pass</span> or <span class="badge b-red">Fail</span>; failures capture a reason and responsible party.</li>
    <li>Results save locally first, then sync to the cloud — so a dropped link never loses work.</li>
  </ul>
  <h3>Guided Mode</h3>
  <p>Guided Mode walks a technician through commissioning <b>one step at a time</b> instead of facing the whole grid at once. It groups work into phases → segments → tasks → steps, auto-detects I/O checks against the live PLC, and lets a technician skip a step with a recorded reason when something isn't ready.</p>
  <ul>
    <li><b>Priority-driven</b> — the next most important task surfaces automatically.</li>
    <li><b>Auto-detect</b> — when the PLC confirms a check, the step advances on its own.</li>
    <li><b>Accountable skips</b> — skipping requires a reason, preserved in the audit trail.</li>
  </ul>
  <div class="callout"><b>When to use Guided Mode.</b> Use it for first-time commissioning and for less-experienced technicians; use the full grid for fast re-checks and spot fixes.</div>
</div>

<!-- 8 SETTINGS -->
<div class="page section">
  <div class="kicker">Section 8</div><h2>Settings &amp; administration</h2><div class="rule"></div>
  <h3>Choosing the project (cloud API key)</h3>
  <p>The tool serves <b>one cloud project</b>, chosen by its API key. This is also where the project is “selected”.</p>
  <div class="step"><div class="num">1</div><div class="body">Click the <b>gear icon</b> in the hub header → opens <code>/settings/mcms</code>.</div></div>
  <div class="step"><div class="num">2</div><div class="body">In <b>Cloud Connection</b>, paste the <b>Project API Key</b> and <b>Save</b>. The panel confirms <span class="gold">“Active project: &lt;name&gt; — N stations”</span>.</div></div>
  <div class="step"><div class="num">3</div><div class="body">Click <b>Import stations</b> to pull the controller list, then <b>Pull all IOs</b> to download each station's I/O.</div></div>
  ${shot('settings.png', 'Settings — Cloud Connection. The API key both authenticates and selects the project.')}
  <h3>Accounts &amp; roles</h3>
  <ul>
    <li><b>Administrators</b> set the cloud key, manage accounts, configure controllers, and program PLCs.</li>
    <li><b>Technicians</b> connect controllers and record test results.</li>
    <li>Accounts are managed from the <b>People icon</b> in the hub header (create, enable/disable, reset PIN).</li>
  </ul>
  <div class="callout warn"><b>One key = one project.</b> To work on a different project, switch the API key. (A single tool instance is intended to serve one project.)</div>
</div>

<!-- 9 SYNC -->
<div class="page section">
  <div class="kicker">Section 9</div><h2>Sync &amp; offline operation</h2><div class="rule"></div>
  <p class="lead">The tool is offline-first by design — the field is no place to lose data to a flaky network.</p>
  <ul>
    <li><b>Local first.</b> Every result, comment, and reset is written to the local database immediately.</li>
    <li><b>Instant push.</b> Right after a local save, the tool pushes it to the cloud (typically 1–2 seconds).</li>
    <li><b>Background retry.</b> Anything that fails to sync is retried automatically until it lands.</li>
    <li><b>Authority.</b> The local database is the source of truth for test results; the cloud is the receiver. Both keep a full audit trail.</li>
  </ul>
  <div class="callout"><b>What this means for you.</b> Keep testing even with no network. When connectivity returns, your work syncs on its own — nothing to re-enter.</div>
</div>

<!-- 10 TROUBLESHOOTING -->
<div class="page section">
  <div class="kicker">Section 10</div><h2>Troubleshooting</h2><div class="rule"></div>
  <table>
    <tr><th>Symptom</th><th>Likely cause &amp; fix</th></tr>
    <tr><td>Hub is empty / “No controllers”</td><td>Project API key not set, or Import not run. Settings → Cloud Connection → paste key → Import (Section 8).</td></tr>
    <tr><td>Connect fails</td><td>Wrong IP or path on the card. Open <b>Configure</b> and correct them. Confirm the controller is powered and on the network.</td></tr>
    <tr><td>Connected but no I/O</td><td>The station's I/O hasn't been pulled. Use <b>Save &amp; Connect</b>, or Settings → <b>Pull all IOs</b>.</td></tr>
    <tr><td>“Program download isn't available”</td><td>This station doesn't have Studio 5000 + the Logix Designer SDK. Program from a station that does; all other features still work.</td></tr>
    <tr><td>Cloud rejected the API key</td><td>The key is wrong or for a different environment. Re-paste the correct project key in Settings.</td></tr>
    <tr><td>Status stuck on “Connecting”</td><td>Network path to the PLC is intermittent. Check cabling/VPN; the tool auto-reconnects when the path is stable.</td></tr>
  </table>
</div>

<!-- 11 QUICK REF -->
<div class="page section">
  <div class="kicker">Section 11</div><h2>Quick reference</h2><div class="rule"></div>
  <h3>Everyday actions</h3>
  <table>
    <tr><th>Goal</th><th>Where</th></tr>
    <tr><td>See all controllers</td><td>Hub — <code>/mcm</code></td></tr>
    <tr><td>Connect / disconnect one</td><td>Card → <b>Connect</b> / <b>Disconnect</b></td></tr>
    <tr><td>Set a controller's IP/path</td><td>Card → <b>Configure</b></td></tr>
    <tr><td>Download a program</td><td>Card → <b>Program</b></td></tr>
    <tr><td>Test a subsystem's I/O</td><td>Card → <b>Open</b></td></tr>
    <tr><td>Set the project / API key</td><td>Header gear → <b>Cloud Connection</b></td></tr>
    <tr><td>Manage accounts</td><td>Header people icon</td></tr>
  </table>
  <h3>Status colors</h3>
  <p>
    <span class="badge b-green">Online</span> connected &nbsp;
    <span class="badge b-amber">Connecting</span> reconnecting &nbsp;
    <span class="badge b-red">Error</span> problem &nbsp;
    <span class="badge b-gray">Offline</span> not connected
  </p>
  <div class="callout"><b>One address to remember.</b> <code>http://&lt;server-ip&gt;:3000/mcm</code> — the Central Control hub. Everything starts there.</div>
  <p class="muted" style="margin-top:34px;text-align:center;">autStand · Commissioning Tool — Operator &amp; Administrator Guide</p>
</div>

</body></html>`

const run = async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 } }) // A4 @96dpi
  await page.setContent(html, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  const dest = path.join(OUT, 'commissioning-tool-guide.pdf')
  await page.pdf({ path: dest, format: 'A4', printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } })
  // verification PNGs
  if (process.argv.includes('--verify')) {
    await page.screenshot({ path: path.join(OUT, 'verify-cover.png') })
    await page.evaluate(() => document.querySelectorAll('.section')[5]?.scrollIntoView())
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(OUT, 'verify-program.png') })
  }
  await browser.close()
  console.log('PDF:', dest, (fs.statSync(dest).size/1e6).toFixed(2)+'MB')
}
run().catch((e) => { console.error('PDF FAILED:', e); process.exit(1) })
