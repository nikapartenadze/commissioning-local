// Cinematic SaaS-style product demo for Commissioning Central Control.
// CSS-3D stage + virtual camera (WAAPI) recorded to webm via Playwright.
// All data shown is mocked in-browser; no backend / production is touched.
import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'

const SRC = path.resolve('cinematic/src')
const OUT = path.resolve('cinematic/out')
fs.mkdirSync(OUT, { recursive: true })
const VW = 1600, VH = 900

const b64 = (f, mime) => `data:${mime};base64,${fs.readFileSync(path.join(SRC, f)).toString('base64')}`
const HUB = b64('hub-dark.png', 'image/png')
const PROG = b64('program-dialog.png', 'image/png')
const LOGO = b64('logo_autstand.svg', 'image/svg+xml')

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap');
:root{ --gold:#d6a82e; --gold2:#f0c84e; --green:#2fbf6a; --red:#e0463f; --amber:#e3a534;
  --ink:#ece9e1; --muted:#9b958a; --card:#16161a; --card2:#1d1d22; --line:rgba(255,255,255,.09); }
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${VW}px;height:${VH}px;overflow:hidden;background:#060607;font-family:'IBM Plex Sans',system-ui,sans-serif}
.mono{font-family:'JetBrains Mono',monospace}

#bg{position:absolute;inset:-20%;z-index:0;
  background:
    radial-gradient(70% 55% at 50% 18%, rgba(214,168,46,.16), transparent 60%),
    radial-gradient(90% 90% at 50% 120%, rgba(20,16,8,.9), #050506 70%);}
#grid{position:absolute;inset:-40%;z-index:0;opacity:.35;
  background-image:linear-gradient(rgba(214,168,46,.10) 1px,transparent 1px),linear-gradient(90deg,rgba(214,168,46,.10) 1px,transparent 1px);
  background-size:54px 54px;transform:perspective(700px) rotateX(62deg) translateZ(-40px);transform-origin:50% 30%;mask:radial-gradient(70% 60% at 50% 40%,#000,transparent 80%);}
.bokeh{position:absolute;border-radius:50%;filter:blur(26px);z-index:0;background:rgba(214,168,46,.20)}

#viewport{position:absolute;inset:0;z-index:2;perspective:1700px;perspective-origin:50% 46%}
#cam{position:absolute;inset:0;transform-style:preserve-3d;transform-origin:0 0;will-change:transform}
.win{position:absolute;transform-style:preserve-3d;opacity:0;will-change:transform,opacity;
  border-radius:16px;overflow:hidden;background:#0e0e11;
  box-shadow:0 50px 120px -20px rgba(0,0,0,.8),0 0 0 1px rgba(255,255,255,.06),inset 0 1px 0 rgba(255,255,255,.06);
  border:1px solid rgba(214,168,46,.18)}
.win .bar{height:34px;display:flex;align-items:center;gap:8px;padding:0 14px;background:linear-gradient(180deg,#161619,#101013);border-bottom:1px solid var(--line)}
.win .bar i{width:11px;height:11px;border-radius:50%;display:inline-block}
.win .bar .d1{background:#e0463f}.win .bar .d2{background:#e3a534}.win .bar .d3{background:#2fbf6a}
.win .bar span{margin-left:10px;font-size:12px;color:var(--muted);letter-spacing:.3px}
.win img{display:block;width:100%}

.modal{position:absolute;transform-style:preserve-3d;opacity:0;will-change:transform,opacity;
  width:520px;border-radius:16px;background:var(--card);border:1px solid var(--line);
  box-shadow:0 60px 130px -20px rgba(0,0,0,.85),0 0 0 1px rgba(214,168,46,.10);padding:24px}
.modal h3{font-size:18px;font-weight:800;color:var(--ink);display:flex;align-items:center;gap:9px}
.modal h3 .g{width:26px;height:26px;border-radius:7px;background:rgba(214,168,46,.16);display:grid;place-items:center;color:var(--gold)}
.modal p{font-size:12.5px;color:var(--muted);margin:8px 0 18px;line-height:1.5}
.row{display:flex;gap:12px}
.fld{flex:1}.fld.sm{flex:0 0 96px}
.fld label{display:block;font-size:10px;font-weight:700;letter-spacing:1.2px;color:var(--muted);text-transform:uppercase;margin-bottom:6px}
.input{height:44px;border-radius:9px;background:#0c0c0f;border:1px solid var(--line);display:flex;align-items:center;padding:0 13px;
  font-family:'JetBrains Mono',monospace;font-size:15px;color:var(--ink);transition:border-color .3s,box-shadow .3s}
.input.focus{border-color:var(--gold);box-shadow:0 0 0 3px rgba(214,168,46,.22)}
.input .caret{width:2px;height:20px;background:var(--gold2);margin-left:1px;animation:blink 1s steps(1) infinite;opacity:0}
.input.focus .caret{opacity:1}
@keyframes blink{50%{opacity:0}}
.btns{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}
.btn{height:42px;padding:0 18px;border-radius:9px;font-size:13.5px;font-weight:700;display:flex;align-items:center;gap:8px}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
.btn.gold{background:linear-gradient(180deg,var(--gold2),var(--gold));color:#1a1407;box-shadow:0 8px 24px -6px rgba(214,168,46,.5)}

.iogrid{position:absolute;transform-style:preserve-3d;opacity:0;will-change:transform,opacity;width:780px;border-radius:16px;overflow:hidden;
  background:var(--card);border:1px solid var(--line);box-shadow:0 60px 130px -20px rgba(0,0,0,.85)}
.iogrid .h{display:flex;padding:12px 18px;font-size:10.5px;font-weight:700;letter-spacing:1px;color:var(--muted);text-transform:uppercase;border-bottom:1px solid var(--line);background:#121216}
.iogrid .r{display:flex;align-items:center;padding:13px 18px;border-bottom:1px solid var(--line);font-size:14px;color:var(--ink)}
.iogrid .r .tag{flex:0 0 150px;font-family:'JetBrains Mono',monospace;color:var(--gold)}
.iogrid .r .desc{flex:1;color:#cfcabf}
.iogrid .r .st{flex:0 0 70px;display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px}
.iogrid .r .st .dot{width:9px;height:9px;border-radius:50%;background:#2fbf6a;box-shadow:0 0 8px #2fbf6a}
.iogrid .r .res{flex:0 0 110px;text-align:right}
.pill{display:inline-block;padding:5px 14px;border-radius:999px;font-size:12px;font-weight:800;letter-spacing:.5px;border:1px solid var(--line);color:var(--muted)}
.pill.pass{background:rgba(47,191,106,.16);border-color:rgba(47,191,106,.4);color:#54d488}
.pill.fail{background:rgba(224,70,63,.16);border-color:rgba(224,70,63,.45);color:#ef6a64}
.h .tag{flex:0 0 150px}.h .desc{flex:1}.h .st{flex:0 0 70px}.h .res{flex:0 0 110px;text-align:right}

#spot{position:absolute;inset:0;z-index:3;pointer-events:none;opacity:0;
  background:radial-gradient(circle 230px at 50% 50%, transparent 0, transparent 60%, rgba(4,4,6,.72) 100%)}
#vig{position:absolute;inset:0;z-index:5;pointer-events:none;box-shadow:inset 0 0 240px 60px rgba(0,0,0,.7)}
.lb{position:absolute;left:0;right:0;height:0;background:#000;z-index:6;transition:height .8s cubic-bezier(.6,0,.2,1)}
#lbT{top:0}#lbB{bottom:0}

#cap{position:absolute;left:0;right:0;bottom:88px;z-index:7;text-align:center;pointer-events:none}
#cap .k{font-size:11px;font-weight:800;letter-spacing:5px;color:var(--gold);text-transform:uppercase;margin-bottom:10px;opacity:0}
#cap .t{display:inline-block;font-size:40px;font-weight:800;letter-spacing:-1px;color:#fff;line-height:1.08;
  text-shadow:0 8px 40px rgba(0,0,0,.6)}
#cap .t b{color:var(--gold2)}

.cover{position:absolute;inset:0;z-index:9;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;
  background:radial-gradient(120% 100% at 50% 0%, #1a1408 0%, #060607 60%)}
.cover img{height:64px;filter:drop-shadow(0 6px 30px rgba(214,168,46,.5));opacity:0;transform:scale(.92)}
.cover .big{font-size:54px;font-weight:800;letter-spacing:-1.5px;color:#fff;text-align:center;opacity:0}
.cover .sub{font-size:20px;color:var(--gold2);font-weight:600;opacity:0}
.cover .pills{display:flex;gap:12px;opacity:0}
.cover .pills span{font-size:12px;font-weight:800;letter-spacing:1px;color:#1a1407;background:linear-gradient(180deg,var(--gold2),var(--gold));padding:8px 18px;border-radius:999px}
</style></head><body>

<div id="bg"></div><div id="grid"></div>
<div class="bokeh" style="width:380px;height:380px;left:-60px;top:-40px"></div>
<div class="bokeh" style="width:300px;height:300px;right:-40px;bottom:60px;background:rgba(120,90,20,.18)"></div>

<div id="viewport"><div id="cam">

  <div class="win" id="hub" style="left:80px;top:60px;width:1440px">
    <div class="bar"><i class="d1"></i><i class="d2"></i><i class="d3"></i><span>Commissioning · Central Control</span></div>
    <img src="${HUB}"/>
  </div>

  <div class="win" id="prog" style="left:1820px;top:-10px;width:1440px">
    <div class="bar"><i class="d1"></i><i class="d2"></i><i class="d3"></i><span>Program — MCM01</span></div>
    <img src="${PROG}"/>
  </div>

  <div class="modal" id="cfg" style="left:540px;top:300px">
    <h3><span class="g">⚙</span> Configure — MCM02</h3>
    <p>EtherNet/IP address and backplane route to this controller's CPU. Save once — every operator just clicks Connect.</p>
    <div class="row">
      <div class="fld"><label>IP address</label><div class="input" id="ipf"><span class="val mono"></span><span class="caret"></span></div></div>
      <div class="fld sm"><label>Path</label><div class="input"><span class="mono">1,0</span></div></div>
    </div>
    <div class="btns"><div class="btn ghost">Save</div><div class="btn gold" id="savebtn">⚡ Save &amp; Connect</div></div>
  </div>

  <div class="iogrid" id="io" style="left:700px;top:1320px">
    <div class="h"><div class="tag">Tag</div><div class="desc">Description</div><div class="st">Live</div><div class="res">Result</div></div>
    <div class="r"><div class="tag">DI_Belt01_Run</div><div class="desc">Belt 1 running feedback</div><div class="st"><span class="dot"></span>ON</div><div class="res"><span class="pill pass">PASS</span></div></div>
    <div class="r"><div class="tag">DO_Div01_Sol</div><div class="desc">Diverter 1 solenoid</div><div class="st"><span class="dot"></span>ON</div><div class="res" id="ioA"><span class="pill">—</span></div></div>
    <div class="r"><div class="tag">DI_PE_Scan07</div><div class="desc">Photo-eye, scan zone 7</div><div class="st"><span class="dot"></span>ON</div><div class="res"><span class="pill pass">PASS</span></div></div>
    <div class="r"><div class="tag">DI_EStop_W3</div><div class="desc">E-stop, west aisle 3</div><div class="st"><span class="dot" style="background:#e0463f;box-shadow:0 0 8px #e0463f"></span>OFF</div><div class="res" id="ioB"><span class="pill">—</span></div></div>
    <div class="r" style="border:none"><div class="tag">DO_VFD12_En</div><div class="desc">VFD 12 enable</div><div class="st"><span class="dot"></span>ON</div><div class="res"><span class="pill pass">PASS</span></div></div>
  </div>

</div></div>

<div id="spot"></div>
<div id="vig"></div>
<div class="lb" id="lbT"></div><div class="lb" id="lbB"></div>

<div id="cap"><div class="k" id="capK"></div><div class="t" id="capT"></div></div>

<div class="cover" id="open">
  <img src="${LOGO}" id="oLogo"/>
  <div class="big" id="oBig">Commission the whole floor.</div>
  <div class="sub" id="oSub">From one screen.</div>
</div>
<div class="cover" id="outro" style="opacity:0;z-index:10;display:none">
  <img src="${LOGO}" id="x1"/>
  <div class="big" id="x2">Central Control</div>
  <div class="sub" id="x3">One address. Every controller.</div>
  <div class="pills" id="x4"><span>CONNECT</span><span>CONFIGURE</span><span>PROGRAM</span></div>
</div>

<script>
const VW=${VW}, VH=${VH}
const $=s=>document.querySelector(s)
const cam=$('#cam'), spot=$('#spot'), capK=$('#capK'), capT=$('#capT')
const E=(x,y,s,rx=0,ry=0)=>'translate('+(VW/2)+'px,'+(VH/2)+'px) rotateX('+rx+'deg) rotateY('+ry+'deg) scale('+s+') translate('+(-x)+'px,'+(-y)+'px)'
let cur=E(800,470,0.6)
cam.style.transform=cur
const EASE='cubic-bezier(.62,.02,.18,1)'
function camTo(x,y,s,rx,ry,dur,ease){const to=E(x,y,s,rx,ry);cam.animate([{transform:cur},{transform:to}],{duration:dur,easing:ease||EASE,fill:'forwards'});cur=to}
function enter(el,fromTransform,dur=900,delay=0){el.animate([{opacity:0,transform:fromTransform},{opacity:1,transform:'translateZ(0)'}],{duration:dur,delay,easing:'cubic-bezier(.2,.7,.2,1)',fill:'forwards'})}
function leave(el,dur=600){el.animate([{opacity:1},{opacity:0}],{duration:dur,fill:'forwards'})}
function pop(el,dur=900,delay=0){el.animate([{opacity:0,transform:'translateZ(120px) scale(.86)'},{opacity:1,transform:'translateZ(0) scale(1)'}],{duration:dur,delay,easing:'cubic-bezier(.2,.8,.2,1.05)',fill:'forwards'})}
function spotAt(px,py,on,dur=600){spot.style.background='radial-gradient(circle 240px at '+px+'px '+py+'px, transparent 0, transparent 58%, rgba(4,4,6,.74) 100%)';spot.animate([{opacity:Number(spot.dataset.o||0)},{opacity:on?1:0}],{duration:dur,fill:'forwards'});spot.dataset.o=on?1:0}
function pulse(el){el.animate([{transform:'scale(1)',boxShadow:'0 8px 24px -6px rgba(214,168,46,.5)'},{transform:'scale(1.06)',boxShadow:'0 14px 40px -4px rgba(240,200,78,.85)'},{transform:'scale(1)',boxShadow:'0 8px 24px -6px rgba(214,168,46,.5)'}],{duration:1100,iterations:2,easing:'ease-in-out'})}
const Q=[];function T(ms,fn){Q.push({at:ms,fn,done:false})}
function caption(kick,html,dur,at){
  T(at,()=>{capK.textContent=kick;capT.innerHTML=html;
    capK.animate([{opacity:0,transform:'translateY(10px)'},{opacity:1,transform:'none'}],{duration:450,fill:'forwards'})
    capT.animate([{opacity:0,transform:'translateY(26px)',filter:'blur(7px)'},{opacity:1,transform:'none',filter:'none'}],{duration:650,easing:'cubic-bezier(.2,.75,.2,1)',fill:'forwards'})})
  T(at+dur,()=>{capK.animate([{opacity:1},{opacity:0}],{duration:400,fill:'forwards'});capT.animate([{opacity:1,transform:'none'},{opacity:0,transform:'translateY(-16px)'}],{duration:450,fill:'forwards'})})
}
function typeInto(el,text,start,per=85){const v=el.querySelector('.val');for(let i=0;i<=text.length;i++)T(start+i*per,()=>v.textContent=text.slice(0,i))}

function start(){
  $('#lbT').style.height='52px';$('#lbB').style.height='52px'
  $('#oLogo').animate([{opacity:0,transform:'scale(.9)'},{opacity:1,transform:'scale(1)'}],{duration:900,delay:300,easing:'cubic-bezier(.2,.8,.2,1)',fill:'forwards'})
  $('#oBig').animate([{opacity:0,transform:'translateY(22px)',filter:'blur(6px)'},{opacity:1,transform:'none',filter:'none'}],{duration:800,delay:900,easing:'cubic-bezier(.2,.8,.2,1)',fill:'forwards'})
  $('#oSub').animate([{opacity:0,transform:'translateY(16px)'},{opacity:1,transform:'none'}],{duration:700,delay:1500,fill:'forwards'})
  T(3300,()=>$('#open').animate([{opacity:1},{opacity:0}],{duration:900,fill:'forwards'}))
  T(4150,()=>$('#open').style.display='none')

  T(3500,()=>enter($('#hub'),'translateZ(-420px) rotateY(-22deg) translateY(40px)',1100))
  T(3700,()=>camTo(800,470,0.62,0,4,1500,EASE))
  caption('Central Control','One hub. <b>Every controller.</b>',2700,4400)
  T(6900,()=>camTo(372,330,1.25,0,0,1700))
  T(7100,()=>spotAt(560,430,true))
  caption('','Live status. <b>Live tags.</b>',2200,7300)
  T(9600,()=>spotAt(0,0,false))

  T(9700,()=>camTo(800,470,0.7,0,0,1100))
  T(10100,()=>pop($('#cfg'),900))
  caption('Set it once','Type the IP. <b>Save &amp; Connect.</b>',2600,10500)
  T(11600,()=>camTo(690,505,1.65,0,0,1300))
  T(12100,()=>$('#ipf').classList.add('focus'))
  typeInto($('#ipf'),'192.168.20.40',12500,80)
  T(14100,()=>pulse($('#savebtn')))
  T(15000,()=>leave($('#cfg'),600))

  T(15300,()=>enter($('#prog'),'translateZ(-360px) rotateY(26deg) translateX(120px)',1100))
  T(15400,()=>camTo(2540,360,0.62,0,-5,1700))
  caption('Push programs','Download to any PLC. <b>One click.</b>',2600,15900)
  T(18000,()=>camTo(2540,690,1.2,0,0,1500))
  T(18300,()=>spotAt(800,640,true))
  caption('','No Studio 5000 hunting.',1900,18500)
  T(20400,()=>spotAt(0,0,false))

  T(20600,()=>enter($('#io'),'translateZ(-300px) rotateX(14deg) translateY(60px)',1100))
  T(20800,()=>camTo(1090,1560,0.74,9,0,1700))
  caption('Test every I/O','Pass or fail — <b>offline-first.</b>',2600,21300)
  T(23100,()=>{$('#ioA').innerHTML='<span class="pill pass">PASS</span>';$('#ioA').firstChild.animate([{transform:'scale(.6)',opacity:0},{transform:'scale(1)',opacity:1}],{duration:450,easing:'cubic-bezier(.2,.8,.2,1.2)',fill:'forwards'})})
  T(23800,()=>{$('#ioB').innerHTML='<span class="pill fail">FAIL</span>';$('#ioB').firstChild.animate([{transform:'scale(.6)',opacity:0},{transform:'scale(1)',opacity:1}],{duration:450,easing:'cubic-bezier(.2,.8,.2,1.2)',fill:'forwards'})})

  T(25400,()=>camTo(1500,720,0.3,6,-3,2000))
  T(26800,()=>{const o=$('#outro');o.style.display='flex';o.animate([{opacity:0},{opacity:1}],{duration:900,fill:'forwards'})})
  T(27200,()=>$('#x1').animate([{opacity:0,transform:'scale(.9)'},{opacity:1,transform:'scale(1)'}],{duration:800,easing:'cubic-bezier(.2,.8,.2,1)',fill:'forwards'}))
  T(27600,()=>$('#x2').animate([{opacity:0,transform:'translateY(18px)',filter:'blur(6px)'},{opacity:1,transform:'none',filter:'none'}],{duration:700,fill:'forwards'}))
  T(28100,()=>$('#x3').animate([{opacity:0,transform:'translateY(14px)'},{opacity:1,transform:'none'}],{duration:600,fill:'forwards'}))
  T(28500,()=>$('#x4').animate([{opacity:0,transform:'translateY(12px)'},{opacity:1,transform:'none'}],{duration:600,fill:'forwards'}))
  // rAF master clock — frame-accurate, immune to setTimeout throttling
  const t0=performance.now()
  function loop(now){const t=now-t0;for(const q of Q){if(!q.done&&t>=q.at){q.done=true;try{q.fn()}catch(e){}}}if(t<window.__DONE)requestAnimationFrame(loop)}
  requestAnimationFrame(loop)
}
window.__start=start; window.__DONE=30500
</script></body></html>`

const run = async () => {
  const browser = await chromium.launch({ args: [
    '--force-color-profile=srgb',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
  ] })
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, recordVideo: { dir: OUT, size: { width: VW, height: VH } } })
  const page = await ctx.newPage()
  await page.setContent(HTML, { waitUntil: 'networkidle' })
  await page.evaluate(async () => { try { await document.fonts.ready } catch(e){} })
  await page.waitForTimeout(500) // brief settle before starting the timeline
  await page.evaluate(() => window.__start())
  const done = await page.evaluate(() => window.__DONE || 31000)
  await page.waitForTimeout(done + 700)
  await ctx.close()
  await browser.close()
  const vids = fs.readdirSync(OUT).filter(f => f.endsWith('.webm') && !f.startsWith('cinematic'))
  if (vids.length) {
    const newest = vids.map(f => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs })).sort((a,b)=>b.t-a.t)[0].f
    const dest = path.join(OUT, 'cinematic-demo.webm')
    fs.copyFileSync(path.join(OUT, newest), dest)
    console.log('VIDEO:', dest, (fs.statSync(dest).size/1e6).toFixed(2)+'MB')
  } else console.log('NO VIDEO')
}
run().catch(e => { console.error('FAILED:', e); process.exit(1) })
