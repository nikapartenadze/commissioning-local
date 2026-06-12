// High-quality cinematic demo: deterministic frame render (seekable render(t))
// -> lossless PNG frames -> h264 (ffmpeg-static, CRF 17). Real workflow pages.
import { chromium } from 'playwright'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
const require = createRequire(import.meta.url)
const FFMPEG = require('ffmpeg-static')

const SRC = path.resolve('cinematic/src'), REAL = path.resolve('cinematic/real')
const OUT = path.resolve('cinematic/out'), FR = path.resolve('cinematic/frames2')
fs.mkdirSync(OUT, { recursive: true }); fs.rmSync(FR, { recursive: true, force: true }); fs.mkdirSync(FR, { recursive: true })
const VW = 1920, VH = 1080, FPS = 30, DUR = 37

const img = (p, m = 'image/png') => `data:${m};base64,${fs.readFileSync(p).toString('base64')}`
const HUB = img(path.join(SRC, 'hub-dark.png')), PROG = img(path.join(SRC, 'program-dialog.png'))
const IO = img(path.join(REAL, 'io.png')), ESTOP = img(path.join(REAL, 'estop.png')), FUNC = img(path.join(REAL, 'functional.png'))
const LOGO = img(path.join(SRC, 'logo_autstand.svg'), 'image/svg+xml')

const win = (id, left, top, w, url, src) => `
  <div class="win" id="${id}" style="left:${left}px;top:${top}px;width:${w}px">
    <div class="bar"><i class="d1"></i><i class="d2"></i><i class="d3"></i><span class="url">${url}</span></div>
    <img src="${src}"/>
  </div>`

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${VW}px;height:${VH}px;overflow:hidden;background:#050506;font-family:'IBM Plex Sans',system-ui,sans-serif}
#bg{position:absolute;inset:-20%;z-index:0;background:radial-gradient(70% 55% at 50% 16%,rgba(214,168,46,.15),transparent 60%),radial-gradient(90% 90% at 50% 120%,rgba(18,14,7,.9),#050506 70%)}
.bokeh{position:absolute;border-radius:50%;filter:blur(34px);z-index:0;background:rgba(214,168,46,.16)}
#viewport{position:absolute;inset:0;z-index:2;perspective:2100px;perspective-origin:50% 46%}
#cam{position:absolute;inset:0;transform-style:preserve-3d;transform-origin:0 0}
.win{position:absolute;transform-style:preserve-3d;opacity:0;border-radius:16px;overflow:hidden;background:#0c0c0f;
  box-shadow:0 60px 140px -25px rgba(0,0,0,.85),0 0 0 1px rgba(255,255,255,.05);border:1px solid rgba(214,168,46,.16)}
.win .bar{height:40px;display:flex;align-items:center;gap:9px;padding:0 16px;background:linear-gradient(180deg,#17171a,#0f0f12);border-bottom:1px solid rgba(255,255,255,.06)}
.win .bar i{width:12px;height:12px;border-radius:50%}.win .bar .d1{background:#e0463f}.win .bar .d2{background:#e3a534}.win .bar .d3{background:#2fbf6a}
.win .bar .url{margin-left:14px;font-family:'JetBrains Mono',monospace;font-size:13px;color:#8a857b;background:#0b0b0e;padding:5px 14px;border-radius:7px}
.win img{display:block;width:100%}
.modal{position:absolute;opacity:0;width:560px;border-radius:18px;background:#16161a;border:1px solid rgba(255,255,255,.08);
  box-shadow:0 70px 150px -25px rgba(0,0,0,.88);padding:28px}
.modal h3{font-size:21px;font-weight:800;color:#ece9e1;display:flex;align-items:center;gap:10px}
.modal h3 .g{width:30px;height:30px;border-radius:8px;background:rgba(214,168,46,.16);display:grid;place-items:center;color:#d6a82e}
.modal p{font-size:14px;color:#9b958a;margin:10px 0 22px;line-height:1.5}
.row{display:flex;gap:14px}.fld{flex:1}.fld.sm{flex:0 0 110px}
.fld label{display:block;font-size:11px;font-weight:700;letter-spacing:1.3px;color:#9b958a;text-transform:uppercase;margin-bottom:7px}
.input{height:50px;border-radius:10px;background:#0b0b0e;border:1px solid rgba(255,255,255,.08);display:flex;align-items:center;padding:0 15px;font-family:'JetBrains Mono',monospace;font-size:17px;color:#ece9e1}
.input.focus{border-color:#d6a82e;box-shadow:0 0 0 4px rgba(214,168,46,.22)}
.input .caret{width:2px;height:22px;background:#f0c84e;margin-left:1px}
.btns{display:flex;justify-content:flex-end;gap:12px;margin-top:26px}
.btn{height:48px;padding:0 22px;border-radius:10px;font-size:15px;font-weight:700;display:flex;align-items:center;gap:9px}
.btn.ghost{border:1px solid rgba(255,255,255,.1);color:#ece9e1}.btn.gold{background:linear-gradient(180deg,#f0c84e,#caa33a);color:#1a1407}
#spot{position:absolute;inset:0;z-index:3;pointer-events:none;opacity:0;background:radial-gradient(circle 300px at 50% 50%,transparent 0,transparent 56%,rgba(4,4,6,.76) 100%)}
#vig{position:absolute;inset:0;z-index:5;pointer-events:none;box-shadow:inset 0 0 300px 70px rgba(0,0,0,.66)}
.lb{position:absolute;left:0;right:0;height:60px;background:#000;z-index:6}#lbT{top:0}#lbB{bottom:0}
#cap{position:absolute;left:0;right:0;bottom:118px;z-index:7;text-align:center;pointer-events:none}
#cap .k{font-size:14px;font-weight:800;letter-spacing:6px;color:#d6a82e;text-transform:uppercase;margin-bottom:12px}
#cap .t{display:inline-block;font-size:52px;font-weight:800;letter-spacing:-1.2px;color:#fff;line-height:1.07;text-shadow:0 10px 50px rgba(0,0,0,.6)}
#cap .t b{color:#f0c84e}
#cover{position:absolute;inset:0;z-index:9;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;background:radial-gradient(120% 100% at 50% 0%,#1a1408,#050506 60%)}
#cover img{height:78px;filter:drop-shadow(0 6px 34px rgba(214,168,46,.5))}
#cover .big{font-size:64px;font-weight:800;letter-spacing:-2px;color:#fafafa}#cover .sub{font-size:25px;color:#e0bd63;font-weight:600}
#low{position:absolute;left:64px;bottom:80px;z-index:8;display:flex;align-items:center;gap:16px;opacity:0}
#low img{height:30px}#low span{font-size:18px;color:#cfc7b6;font-weight:600;border-left:1px solid rgba(255,255,255,.2);padding-left:16px}
</style></head><body>
<div id="bg"></div>
<div class="bokeh" style="width:520px;height:520px;left:-80px;top:-60px"></div>
<div class="bokeh" style="width:440px;height:440px;right:-60px;bottom:40px;background:rgba(120,90,20,.16)"></div>
<div id="viewport"><div id="cam">
  ${win('hub', 80, 60, 1480, 'commissioning.local / Central Control', HUB)}
  ${win('prog', 2700, 300, 1480, 'commissioning.local / Program — MCM01', PROG)}
  ${win('io', 600, 1500, 1760, 'commissioning.local / MCM02 — I/O Testing', IO)}
  ${win('estop', 2700, 1550, 1760, 'commissioning.local / MCM02 — Safety', ESTOP)}
  ${win('func', 1500, 2750, 1600, 'commissioning.local / MCM02 — Functional', FUNC)}
  <div class="modal" id="cfg" style="left:560px;top:300px">
    <h3><span class="g">⚙</span> Configure — MCM02</h3>
    <p>EtherNet/IP address and backplane route to this controller's CPU. Save once — every operator just clicks Connect.</p>
    <div class="row"><div class="fld"><label>IP address</label><div class="input" id="ipf"><span class="val"></span><span class="caret" id="caret"></span></div></div>
    <div class="fld sm"><label>Path</label><div class="input">1,0</div></div></div>
    <div class="btns"><div class="btn ghost">Save</div><div class="btn gold" id="save">⚡ Save &amp; Connect</div></div>
  </div>
</div></div>
<div id="spot"></div><div id="vig"></div>
<div class="lb" id="lbT"></div><div class="lb" id="lbB"></div>
<div id="cap"><div class="k" id="ck"></div><div class="t" id="ct"></div></div>
<div id="low"><img src="${LOGO}"/><span>Central Control · One address. Every controller.</span></div>
<div id="cover"><img src="${LOGO}"/><div class="big" id="cbig">Commission the whole floor.</div><div class="sub" id="csub">From one screen.</div></div>
<script>
const VW=${VW},VH=${VH}
const $=s=>document.querySelector(s)
const cam=$('#cam')
function ease(t){return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2}
function clamp01(x){return x<0?0:x>1?1:x}
function S(track,tt){const a=track;if(tt<=a[0].t)return a[0].v;if(tt>=a[a.length-1].t)return a[a.length-1].v;
  for(let i=0;i<a.length-1;i++){if(tt>=a[i].t&&tt<=a[i+1].t){const u=ease((tt-a[i].t)/(a[i+1].t-a[i].t));return a[i].v+(a[i+1].v-a[i].v)*u}}}
function camT(x,y,s,rx,ry){return 'translate('+(VW/2)+'px,'+(VH/2)+'px) rotateX('+rx+'deg) rotateY('+ry+'deg) scale('+s+') translate('+(-x)+'px,'+(-y)+'px)'}
const CX=[{t:3.5,v:820},{t:6.6,v:820},{t:7.0,v:302},{t:8.2,v:820},{t:9.0,v:710},{t:12,v:710},{t:13,v:3440},{t:15.2,v:3440},{t:17.5,v:1480},{t:20,v:1120},{t:23,v:1060},{t:25,v:3580},{t:28,v:3052},{t:30,v:2300},{t:33,v:820},{t:37,v:820}]
const CY=[{t:3.5,v:500},{t:6.6,v:500},{t:7.0,v:326},{t:8.2,v:480},{t:9.0,v:500},{t:12,v:500},{t:13,v:744},{t:15.2,v:1064},{t:17.5,v:1995},{t:20,v:1720},{t:23,v:1900},{t:25,v:2045},{t:28,v:1800},{t:30,v:3200},{t:33,v:500},{t:37,v:500}]
const CS=[{t:3.5,v:.58},{t:6.6,v:.62},{t:7.0,v:1.12},{t:8.2,v:.66},{t:9.0,v:1.55},{t:12,v:1.55},{t:13,v:.58},{t:15.2,v:1.12},{t:17.5,v:.56},{t:20,v:1.0},{t:23,v:1.22},{t:25,v:.56},{t:28,v:1.08},{t:30,v:.6},{t:33,v:.62},{t:37,v:.62}]
const CRX=[{t:3.5,v:0},{t:17.5,v:0},{t:20,v:3},{t:25,v:0},{t:37,v:0}]
const CRY=[{t:3.5,v:5},{t:6,v:0},{t:13,v:-6},{t:15.2,v:0},{t:25,v:-5},{t:28,v:0},{t:37,v:0}]
const WINS=[['hub',3.3,4.3],['prog',12.3,13.3],['io',17.2,18.2],['estop',24.6,25.6],['func',29.6,30.6]]
const CAPS=[
 {a:4.3,b:6.5,k:'Central Control',h:'One hub. <b>Every controller.</b>'},
 {a:6.9,b:7.9,k:'',h:'Live status. <b>Live tags.</b>'},
 {a:8.7,b:11.7,k:'Set it once',h:'Type the IP. <b>Save & Connect.</b>'},
 {a:13.2,b:15,k:'Push programs',h:'Download to any PLC. <b>One click.</b>'},
 {a:18,b:19.9,k:'I/O testing',h:'Every point — <b>pass or fail.</b>'},
 {a:20.3,b:23.8,k:'',h:'<b>317 passed</b> · live progress.'},
 {a:25.6,b:29,k:'Safety',h:'Every E-stop zone & <b>pull-cord.</b>'},
 {a:30.4,b:32.7,k:'Functional validation',h:'Sign off the <b>whole system.</b>'},
]
const TYPE={text:'192.168.20.40',a:9.3,b:10.8}
const SPOTS=[{a:15,b:17,r:300},{a:22.6,b:24.2,r:340}]
function render(t){
  const cov=$('#cover'); const co= t<3.0?1: t<3.8? 1-(t-3.0)/0.8 : 0; cov.style.opacity=co; cov.style.display=co<=0?'none':'flex'
  $('#cbig').style.opacity=clamp01((t-0.6)/0.8); $('#csub').style.opacity=clamp01((t-1.3)/0.8)
  cam.style.transform=camT(S(CX,t),S(CY,t),S(CS,t),S(CRX,t),S(CRY,t))
  for(const w of WINS){const el=$('#'+w[0]);const p=clamp01((t-w[1])/(w[2]-w[1]));el.style.opacity=p;el.style.transform='translateZ(0) translateY('+((1-ease(p))*46)+'px) scale('+(0.97+0.03*ease(p))+')'}
  const cfg=$('#cfg');const cin=clamp01((t-8.0)/0.8);const cout=clamp01((t-12.0)/0.4);const cop=cin*(1-cout);
  cfg.style.opacity=cop;cfg.style.transform='translateZ('+(120*(1-ease(cin)))+'px) scale('+(0.88+0.12*ease(cin))+')'
  const v=$('#ipf .val');const ipf=$('#ipf');const caret=$('#caret')
  if(t>=TYPE.a-0.2&&t<13){ipf.classList.add('focus')}else{ipf.classList.remove('focus')}
  const tp=clamp01((t-TYPE.a)/(TYPE.b-TYPE.a));v.textContent=TYPE.text.slice(0,Math.round(tp*TYPE.text.length))
  caret.style.opacity=(t>8.6&&t<12&&Math.floor(t*2)%2===0)?1:0
  const sv=$('#save');const pl=(t>11.4&&t<12.0)?1+0.06*Math.sin((t-11.4)/0.6*Math.PI):1;sv.style.transform='scale('+pl+')';sv.style.boxShadow=pl>1.02?'0 14px 44px -4px rgba(240,200,78,.85)':'none'
  let so=0,sr=300;for(const sp of SPOTS){if(t>=sp.a&&t<=sp.b){so=Math.sin(clamp01((t-sp.a)/(sp.b-sp.a))*Math.PI);sr=sp.r}}
  const spot=$('#spot');spot.style.opacity=so*0.9;spot.style.background='radial-gradient(circle '+sr+'px at 50% 50%,transparent 0,transparent 54%,rgba(4,4,6,.78) 100%)'
  let ck='',ct='',cap=0;for(const c of CAPS){if(t>=c.a-0.5&&t<=c.b+0.5){const inn=clamp01((t-c.a+0.5)/0.5);const out=clamp01((t-c.b)/0.5);cap=inn*(1-out);ck=c.k;ct=c.h}}
  $('#ck').textContent=ck;$('#ct').innerHTML=ct;$('#cap').style.opacity=cap;$('#cap').style.transform='translateY('+((1-cap)*18)+'px)'
  $('#low').style.opacity=clamp01((t-33.8)/0.8)
}
window.__render=render
</script></body></html>`

// ── standalone scrubbable preview (open in a browser) ────────────────────────
if (process.argv.includes('--preview')) {
  const PLAYER = `
  <div id="pbar" style="position:fixed;left:0;right:0;bottom:0;z-index:999;display:flex;align-items:center;gap:14px;padding:12px 20px;background:rgba(8,8,10,.92);backdrop-filter:blur(10px);border-top:1px solid rgba(214,168,46,.3);font-family:system-ui,sans-serif;color:#eee">
    <button id="pp" style="width:42px;height:34px;border:0;border-radius:8px;background:#d6a82e;color:#1a1407;font-size:15px;font-weight:800;cursor:pointer">&#10074;&#10074;</button>
    <input id="scrub" type="range" min="0" max="${DUR}" step="0.02" value="0" style="flex:1;accent-color:#d6a82e;cursor:pointer">
    <span id="tl" style="font-family:monospace;font-size:14px;color:#f0c84e;min-width:64px;text-align:right">0.0s</span>
  </div>
  <script>(function(){let t=0,playing=true,last=performance.now();
    const pp=document.getElementById('pp'),scrub=document.getElementById('scrub'),tl=document.getElementById('tl');
    pp.onclick=()=>{playing=!playing;pp.innerHTML=playing?'&#10074;&#10074;':'&#9658;'};
    scrub.oninput=()=>{t=parseFloat(scrub.value);playing=false;pp.innerHTML='&#9658;';window.__render(t)};
    function tick(now){if(playing){t+=(now-last)/1000;if(t>${DUR})t=0;scrub.value=t;}last=now;window.__render(t);tl.textContent=t.toFixed(1)+'s';requestAnimationFrame(tick);}
    requestAnimationFrame(tick);})();</script>`
  const previewHtml = HTML.replace('</body>', PLAYER + '</body>')
  const dest = 'C:/Users/nika.fartenadze.LCIBATUMI/Desktop/commissioning-guide/cinematic-preview.html'
  fs.writeFileSync(dest, previewHtml)
  console.log('PREVIEW:', dest, (fs.statSync(dest).size / 1e6).toFixed(1) + 'MB')
  process.exit(0)
}

const run = async () => {
  const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--hide-scrollbars'] })
  const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 })
  await page.setContent(HTML, { waitUntil: 'networkidle' })
  await page.evaluate(async () => { try { await document.fonts.ready } catch (e) {} })
  const total = DUR * FPS
  for (let i = 0; i < total; i++) {
    const t = i / FPS
    await page.evaluate((tt) => window.__render(tt), t)
    await page.screenshot({ path: path.join(FR, String(i).padStart(5, '0') + '.png') })
    if (i % 60 === 0) process.stdout.write(`  frame ${i}/${total}\r`)
  }
  await browser.close()
  console.log('\nencoding h264...')
  const mp4 = path.join(OUT, 'commissioning-cinematic-hq.mp4')
  execFileSync(FFMPEG, ['-y', '-framerate', String(FPS), '-i', path.join(FR, '%05d.png'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: 'inherit' })
  fs.rmSync(FR, { recursive: true, force: true })
  console.log('VIDEO:', mp4, (fs.statSync(mp4).size / 1e6).toFixed(2) + 'MB')
}
run().catch(e => { console.error('FAILED:', e); process.exit(1) })
