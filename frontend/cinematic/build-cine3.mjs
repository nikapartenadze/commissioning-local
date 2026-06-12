// Cinematic v3 — CSS-3D camera + measured highlights, real pages.
// Flow: hub > configure > program > IO > network(live ring) > E-stop > Safety
//       > Functional(SYS>SS>click VFD>press device) > VFD wizard(steps proceed).
import { chromium } from 'playwright'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
const require = createRequire(import.meta.url)
const FFMPEG = require('ffmpeg-static')

const SRC = path.resolve('cinematic/src'), REAL = path.resolve('cinematic/real')
const OUT = path.resolve('cinematic/out'), FR = path.resolve('cinematic/frames3')
fs.mkdirSync(OUT, { recursive: true })
const VW = 1920, VH = 1080, FPS = 30, DUR = 48, AR = 0.5625, BAR = 42
const img = (p, m = 'image/png') => `data:${m};base64,${fs.readFileSync(p).toString('base64')}`
const A = {
  hub: img(path.join(SRC, 'hub-dark.png')), prog: img(path.join(SRC, 'program-dialog.png')),
  io: img(path.join(REAL, 'io.png')), network: img(path.join(REAL, 'network.png')),
  estop: img(path.join(REAL, 'estop.png')), safety: img(path.join(REAL, 'safety.png')),
  funcSys: img(path.join(REAL, 'func-sys.png')), funcSs: img(path.join(REAL, 'func-ss.png')), funcVfd: img(path.join(REAL, 'func-vfd.png')),
  vfd: img(path.join(REAL, 'vfd-open.png')), logo: img(path.join(SRC, 'logo_autstand.svg'), 'image/svg+xml'),
}
const B = JSON.parse(fs.readFileSync(path.resolve('cinematic/boxes.json'), 'utf8'))

const W = {
  hub: { l: 220, t: 80, w: 1480 }, prog: { l: 220, t: 1500, w: 1480 },
  io: { l: 140, t: 2920, w: 1640 }, network: { l: 140, t: 4240, w: 1640 },
  estop: { l: 140, t: 5560, w: 1640 }, safety: { l: 140, t: 6880, w: 1640 },
  func: { l: 210, t: 8200, w: 1500 }, vfd: { l: 210, t: 9520, w: 1500 },
}
const ih = g => g.w * AR
const ctr = g => ({ x: g.l + g.w / 2, y: g.t + BAR + ih(g) / 2 })
const erect = (k, b) => ({ x: W[k].l + b.x * W[k].w, y: W[k].t + BAR + b.y * ih(W[k]), w: b.w * W[k].w, h: b.h * ih(W[k]) })
const ectr = (k, b) => { const r = erect(k, b); return { x: r.x + r.w / 2, y: r.y + r.h / 2 } }
const frect = (k, x, y, w, h) => ({ x: W[k].l + x * W[k].w, y: W[k].t + BAR + y * ih(W[k]), w: w * W[k].w, h: h * ih(W[k]) })
const focus = (k, fx, fy) => ({ x: W[k].l + fx * W[k].w, y: W[k].t + BAR + fy * ih(W[k]) })
const cen = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

const HC = ctr(W.hub)
const M = { l: HC.x - 280, t: HC.y - 185, w: 560 }

const R = {
  hubCard: erect('hub', B.hub.card), cfgBtn: erect('hub', B.hub.configure),
  progAcd: erect('prog', B.prog.acd), progIp: erect('prog', B.prog.ip), progDl: erect('prog', B.prog.download),
  netNode: erect('network', B.network.node),
  funcTab: frect('func', 0.057, 0.122, 0.057, 0.046), funcDev: frect('func', 0.008, 0.262, 0.62, 0.052),
}
const C = {
  hub: HC, card: ectr('hub', B.hub.card), modal: { x: HC.x, y: HC.y + 10 },
  prog: ctr(W.prog), io: ctr(W.io), network: ctr(W.network), estop: ctr(W.estop), safety: ctr(W.safety), func: ctr(W.func), vfd: ctr(W.vfd),
  ioGrid: focus('io', 0.4, 0.52), netNode: ectr('network', B.network.node),
  estopGrid: focus('estop', 0.36, 0.42), safetyZoom: focus('safety', 0.4, 0.4),
  funcTab: cen(R.funcTab), funcDev: cen(R.funcDev), funcTabZoom: focus('func', 0.22, 0.16), vfdZoom: focus('vfd', 0.34, 0.41),
}

const VSC = W.vfd.w / 1600
const VNAMES = ['VFD Online', 'Identity Check', 'Horsepower Check', 'Bump Test', 'Verify Controls', 'Calibrate Speed']
const VFD = {
  x: W.vfd.l + 350 * VSC, w: 232 * VSC, rh: 42 * VSC,
  rows: VNAMES.map((n, i) => ({ name: n, y: W.vfd.t + BAR + (221 + i * 48) * VSC })),
  panelX: W.vfd.l + 344 * VSC, panelY: W.vfd.t + BAR + 210 * VSC, panelW: 246 * VSC, panelH: 306 * VSC,
  titleX: W.vfd.l + 296 * VSC, titleY: W.vfd.t + BAR + 33 * VSC, titleW: 470 * VSC, titleH: 42 * VSC,
  bodyX: W.vfd.l + 283 * VSC, bodyY: W.vfd.t + BAR + 86 * VSC, bodyW: 998 * VSC, bodyH: 392 * VSC,
  fName: Math.round(15 * VSC), fNum: Math.round(11 * VSC), numD: Math.round(22 * VSC), fTitle: Math.round(21 * VSC),
  fDesc: Math.round(15 * VSC), fChk: Math.round(15 * VSC),
}
const vrowsHTML = VFD.rows.map((r, i) => `<div class="vrow" id="vrow${i}" style="left:${VFD.x}px;top:${r.y}px;width:${VFD.w}px;height:${VFD.rh}px"><span class="vnum">${i + 1}</span><span class="vname">${r.name}</span></div>`).join('')

const win = (id, g, url, src) => `<div class="win" id="${id}" style="left:${g.l}px;top:${g.t}px;width:${g.w}px"><div class="bar"><i class="d1"></i><i class="d2"></i><i class="d3"></i><span class="url">${url}</span></div><img src="${src}"/></div>`

const INJ = JSON.stringify({ R, C, M, VFD })

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${VW}px;height:${VH}px;overflow:hidden;background:#070708;font-family:'Manrope',system-ui,sans-serif}
#bg{position:absolute;inset:-15%;z-index:0;background:radial-gradient(75% 60% at 50% 20%,rgba(214,168,46,.13),transparent 62%),radial-gradient(100% 100% at 50% 120%,rgba(16,12,6,.85),#070708 72%)}
.bokeh{position:absolute;border-radius:50%;filter:blur(40px);z-index:0;background:rgba(214,168,46,.1)}
#viewport{position:absolute;inset:0;z-index:2}#cam{position:absolute;inset:0;transform-origin:0 0}
.win{position:absolute;opacity:0;border-radius:16px;overflow:hidden;background:#0c0c0f;box-shadow:0 50px 120px -28px rgba(0,0,0,.8),0 0 0 1px rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07)}
.win .bar{height:${BAR}px;display:flex;align-items:center;gap:10px;padding:0 18px;background:linear-gradient(180deg,#161619,#0e0e11);border-bottom:1px solid rgba(255,255,255,.06)}
.win .bar i{width:12px;height:12px;border-radius:50%}.win .bar .d1{background:#e0463f}.win .bar .d2{background:#e3a534}.win .bar .d3{background:#2fbf6a}
.win .bar .url{margin-left:14px;font-family:'JetBrains Mono',monospace;font-size:13px;color:#8a857b;background:#0b0b0e;padding:5px 14px;border-radius:7px}
.win img{display:block;width:100%}
#func .fimgs{position:relative}#func .fimg{position:absolute;top:0;left:0;width:100%;display:block}
#hl{position:absolute;z-index:6;opacity:0;border-radius:10px;border:3px solid rgba(240,200,78,.97);box-shadow:0 0 0 4px rgba(240,200,78,.16),0 0 34px 5px rgba(240,200,78,.5);pointer-events:none}
#cursor{position:absolute;z-index:8;left:0;top:0;width:34px;height:34px;opacity:0;transform-origin:8px 6px;filter:drop-shadow(0 3px 6px rgba(0,0,0,.6))}
#click{position:absolute;z-index:8;width:54px;height:54px;border-radius:50%;border:2px solid rgba(240,200,78,.9);opacity:0;pointer-events:none}
#vig{position:absolute;inset:0;z-index:5;pointer-events:none;box-shadow:inset 0 0 240px 36px rgba(0,0,0,.28)}
#cap{position:absolute;left:0;right:0;bottom:92px;z-index:7;text-align:center;pointer-events:none}
#cap .k{font-size:14px;font-weight:800;letter-spacing:5px;color:#e0bd63;text-transform:uppercase;margin-bottom:12px}
#cap .t{display:inline-block;font-size:46px;font-weight:800;letter-spacing:-.8px;color:#fff;line-height:1.1}#cap .t b{color:#f0c84e}
#vfdov{position:absolute;z-index:4;opacity:0}
#vpanel{position:absolute;background:#0d1219;border-right:1px solid rgba(255,255,255,.05)}
#vactive{position:absolute;border-radius:10px;background:linear-gradient(90deg,rgba(214,168,46,.24),rgba(214,168,46,.07));box-shadow:inset 3px 0 0 #f0c84e,0 0 22px rgba(240,200,78,.25)}
.vrow{position:absolute;display:flex;align-items:center;gap:12px;padding:0 14px;font-family:'Manrope',sans-serif;font-size:${VFD.fName}px;font-weight:700;color:#7b8497}
.vrow .vnum{width:${VFD.numD}px;height:${VFD.numD}px;border-radius:50%;border:1.5px solid #3a4150;display:grid;place-items:center;font-size:${VFD.fNum}px;font-weight:700;color:#8a93a5;flex:none}
#vtitle{position:absolute;display:flex;align-items:center;background:#0a0d12;font-family:'Manrope',sans-serif;font-size:${VFD.fTitle}px;font-weight:800;color:#ece9e1}
#vbody{position:absolute;background:#0a0d12;padding:${Math.round(8 * VSC)}px ${Math.round(6 * VSC)}px;font-family:'Manrope',sans-serif;display:flex;flex-direction:column;align-items:flex-start}
#vdesc{font-size:${VFD.fDesc}px;color:#9aa3b2;line-height:1.5;margin-bottom:${Math.round(22 * VSC)}px;max-width:${Math.round(520 * VSC)}px}
#vcheck{display:flex;align-items:center;gap:${Math.round(11 * VSC)}px;background:rgba(47,191,106,.1);border:1px solid rgba(47,191,106,.4);border-radius:10px;padding:${Math.round(13 * VSC)}px ${Math.round(15 * VSC)}px}
#vcheck .vdot{width:${Math.round(20 * VSC)}px;height:${Math.round(20 * VSC)}px;border-radius:50%;background:#2fbf6a;display:grid;place-items:center;color:#06210f;font-size:${Math.round(13 * VSC)}px;font-weight:900;flex:none}
#vcheck #vcktxt{font-size:${VFD.fChk}px;font-weight:700;color:#7fe3a6}
#cfg{position:absolute;z-index:4;opacity:0;width:${M.w}px;border-radius:20px;background:#16161a;border:1px solid rgba(255,255,255,.09);box-shadow:0 60px 130px -25px rgba(0,0,0,.85);padding:30px;transform-origin:50% 50%}
#cfg h3{font-size:23px;font-weight:800;color:#ece9e1;display:flex;align-items:center;gap:11px}
#cfg h3 .g{width:32px;height:32px;border-radius:9px;background:rgba(214,168,46,.16);display:grid;place-items:center;color:#e0bd63;font-size:17px}
#cfg p{font-size:14px;color:#9b958a;margin:12px 0 22px;line-height:1.55}
#cfg .row{display:flex;gap:14px}.fld{flex:1}.fld.sm{flex:0 0 120px}
.fld label{display:block;font-size:11px;font-weight:700;letter-spacing:1.2px;color:#9b958a;text-transform:uppercase;margin-bottom:8px}
.input{height:52px;border-radius:11px;background:#0b0b0e;border:1px solid rgba(255,255,255,.09);display:flex;align-items:center;padding:0 16px;font-family:'JetBrains Mono',monospace;font-size:18px;color:#ece9e1}
.btns{display:flex;justify-content:flex-end;gap:12px;margin-top:28px}
.btn{height:50px;padding:0 24px;border-radius:11px;font-size:15px;font-weight:700;display:flex;align-items:center;gap:9px}
.btn.ghost{border:1px solid rgba(255,255,255,.12);color:#ece9e1}.btn.gold{background:linear-gradient(180deg,#f0c84e,#caa33a);color:#1a1407}
#cover{position:absolute;inset:0;z-index:9;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px;background:radial-gradient(125% 105% at 50% 35%,#1c1609,#070708 62%)}
#cover img{height:132px;filter:drop-shadow(0 8px 40px rgba(214,168,46,.55))}#cover .big{font-size:30px;font-weight:700;color:#cfc7b6}
#low{position:absolute;left:68px;bottom:74px;z-index:8;display:flex;align-items:center;gap:18px;opacity:0}#low img{height:34px}#low span{font-size:18px;color:#cfc7b6;font-weight:600;border-left:1px solid rgba(255,255,255,.22);padding-left:18px}
</style></head><body>
<div id="bg"></div><div class="bokeh" style="width:560px;height:560px;left:-90px;top:-80px"></div><div class="bokeh" style="width:480px;height:480px;right:-70px;bottom:30px;background:rgba(120,90,20,.12)"></div>
<div id="viewport"><div id="cam">
  ${win('hub', W.hub, 'commissioning.local / Central Control', A.hub)}
  ${win('prog', W.prog, 'commissioning.local / Program — MCM01', A.prog)}
  ${win('io', W.io, 'commissioning.local / MCM02 — I/O Validation', A.io)}
  ${win('network', W.network, 'commissioning.local / MCM11 — Network', A.network)}
  ${win('estop', W.estop, 'commissioning.local / MCM02 — E-Stop', A.estop)}
  ${win('safety', W.safety, 'commissioning.local / MCM02 — Safety', A.safety)}
  <div class="win" id="func" style="left:${W.func.l}px;top:${W.func.t}px;width:${W.func.w}px"><div class="bar"><i class="d1"></i><i class="d2"></i><i class="d3"></i><span class="url">commissioning.local / MCM02 — Functional</span></div><div class="fimgs" style="height:${ih(W.func)}px"><img class="fimg" id="fsys" src="${A.funcSys}"/><img class="fimg" id="fss" src="${A.funcSs}"/><img class="fimg" id="fvfd" src="${A.funcVfd}"/></div></div>
  ${win('vfd', W.vfd, 'commissioning.local / MCM02 — VFD Wizard', A.vfd)}
  <div id="cfg" style="left:${M.l}px;top:${M.t}px">
    <h3><span class="g">&#9881;</span> Configure — MCM02</h3>
    <p>EtherNet/IP address and backplane route to this controller. Save once — every operator just clicks Connect.</p>
    <div class="row"><div class="fld"><label>IP address</label><div class="input" id="fip"><span class="vip"></span></div></div>
    <div class="fld sm"><label>Path</label><div class="input" id="fpath"><span class="vpath"></span></div></div></div>
    <div class="btns"><div class="btn ghost">Save</div><div class="btn gold" id="fsave">&#9889; Save &amp; Connect</div></div>
  </div>
  <div id="vfdov">
    <div id="vpanel" style="left:${VFD.panelX}px;top:${VFD.panelY}px;width:${VFD.panelW}px;height:${VFD.panelH}px"></div>
    <div id="vactive" style="left:${VFD.x}px;width:${VFD.w}px;height:${VFD.rh}px"></div>
    ${vrowsHTML}
    <div id="vtitle" style="left:${VFD.titleX}px;top:${VFD.titleY}px;width:${VFD.titleW}px;height:${VFD.titleH}px"></div>
    <div id="vbody" style="left:${VFD.bodyX}px;top:${VFD.bodyY}px;width:${VFD.bodyW}px;height:${VFD.bodyH}px"><div id="vdesc"></div><div id="vcheck"><span class="vdot">&#10003;</span><span id="vcktxt"></span></div></div>
  </div>
  <div id="hl"></div>
</div></div>
<div id="vig"></div>
<svg id="cursor" viewBox="0 0 24 24"><path d="M5 3l14 7-6 1.6L9.4 19 5 3z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>
<div id="click"></div>
<div id="cap"><div class="k" id="ck"></div><div class="t" id="ct"></div></div>
<div id="low"><img src="${A.logo}"/><span>Central Control · One address. Every controller.</span></div>
<div id="cover"><img src="${A.logo}"/><div class="big" id="cbig">Commission the whole floor — from one screen.</div></div>
<script>
const D=${INJ}, VW=${VW},VH=${VH}
const $=s=>document.querySelector(s)
const cam=$('#cam')
function ease(t){return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2}
function easeOut(t){return 1-Math.pow(1-t,3)}
function clamp01(x){return x<0?0:x>1?1:x}
function S(a,tt){if(tt<=a[0].t)return a[0].v;if(tt>=a[a.length-1].t)return a[a.length-1].v;for(let i=0;i<a.length-1;i++){if(tt>=a[i].t&&tt<=a[i+1].t){const u=ease((tt-a[i].t)/(a[i+1].t-a[i].t));return a[i].v+(a[i+1].v-a[i].v)*u}}}
function SO(a,tt){if(tt<=a[0].t)return a[0].v;if(tt>=a[a.length-1].t)return a[a.length-1].v;for(let i=0;i<a.length-1;i++){if(tt>=a[i].t&&tt<=a[i+1].t){const u=easeOut((tt-a[i].t)/(a[i+1].t-a[i].t));return a[i].v+(a[i+1].v-a[i].v)*u}}}
function proj(wx,wy,cx,cy,s){return{x:VW/2+(wx-cx)*s,y:VH/2+(wy-cy)*s}}
function relTo(el,anc){let x=0,y=0;while(el&&el!==anc){x+=el.offsetLeft;y+=el.offsetTop;el=el.offsetParent}return{x,y}}
const cfg=$('#cfg')
function modalRect(id){const el=$(id);const r=relTo(el,cfg);return{x:D.M.l+r.x,y:D.M.t+r.y,w:el.offsetWidth,h:el.offsetHeight}}
const Mip=modalRect('#fip'), Msave=modalRect('#fsave')
const R=D.R, C=D.C
const ctrOf=r=>({x:r.x+r.w/2,y:r.y+r.h/2})
const CAM=[
 {t:3.0,c:C.hub,s:.86},{t:4.6,c:C.hub,s:.9},
 {t:5.2,c:C.card,s:1.6},{t:8.2,c:C.card,s:1.6},
 {t:8.8,c:C.modal,s:1.18},{t:12.6,c:C.modal,s:1.18},
 {t:13.6,c:C.prog,s:.94},{t:18.2,c:C.prog,s:1.06},
 {t:19.0,c:C.io,s:.9},{t:22.4,c:C.ioGrid,s:1.16},
 {t:23.2,c:C.network,s:.85},{t:24.3,c:C.network,s:.92},{t:26.4,c:C.netNode,s:1.7},
 {t:27.0,c:C.estop,s:.9},{t:29.6,c:C.estopGrid,s:1.2},
 {t:30.3,c:C.safety,s:.9},{t:33.0,c:C.safetyZoom,s:1.12},
 {t:33.7,c:C.func,s:.95},{t:34.9,c:C.func,s:1.0},
 {t:35.4,c:C.funcTabZoom,s:1.46},{t:36.4,c:C.funcTabZoom,s:1.46},
 {t:37.0,c:C.funcDev,s:1.3},{t:38.5,c:C.funcDev,s:1.32},
 {t:39.1,c:C.func,s:1.0},
 {t:39.9,c:C.vfd,s:.92},{t:40.7,c:C.vfdZoom,s:1.16},{t:45.4,c:C.vfdZoom,s:1.24},
 {t:46.0,c:C.hub,s:.84},{t:48,c:C.hub,s:.84},
]
const CX=CAM.map(k=>({t:k.t,v:k.c.x})),CY=CAM.map(k=>({t:k.t,v:k.c.y})),CS=CAM.map(k=>({t:k.t,v:k.s}))
const winApp=[['hub',2.8,3.8],['prog',13.0,13.8],['io',18.6,19.4],['network',22.8,23.6],['estop',26.6,27.4],['safety',29.9,30.7],['func',33.3,34.1],['vfd',39.5,40.3]]
const HLS=[
 {a:4.8,b:5.6,r:R.hubCard},{a:6.0,b:8.2,r:R.cfgBtn},
 {a:9.2,b:10.2,r:Mip},{a:10.9,b:12.5,r:Msave},
 {a:14.2,b:15.2,r:R.progAcd},{a:15.3,b:16.2,r:R.progIp},{a:16.4,b:18.2,r:R.progDl},
 {a:35.4,b:36.3,r:R.funcTab},{a:37.0,b:38.3,r:R.funcDev},
]
const cfgC=ctrOf(R.cfgBtn), saveC=ctrOf(Msave), dlC=ctrOf(R.progDl)
const CURX=[{t:6.4,v:C.card.x},{t:7.0,v:cfgC.x},{t:8.0,v:cfgC.x},{t:8.9,v:Mip.x+50},{t:10.5,v:Mip.x+50},{t:11.0,v:saveC.x},{t:12.4,v:saveC.x},{t:15.7,v:R.progIp.x+90},{t:16.2,v:dlC.x},{t:18.0,v:dlC.x},{t:24.0,v:C.network.x},{t:24.7,v:C.netNode.x},{t:26.2,v:C.netNode.x},{t:35.0,v:C.funcTab.x+70},{t:35.5,v:C.funcTab.x},{t:36.3,v:C.funcTab.x},{t:36.9,v:C.funcDev.x},{t:37.4,v:C.funcDev.x},{t:38.4,v:C.funcDev.x}]
const CURY=[{t:6.4,v:C.card.y},{t:7.0,v:cfgC.y},{t:8.0,v:cfgC.y},{t:8.9,v:Mip.y+26},{t:10.5,v:Mip.y+26},{t:11.0,v:saveC.y},{t:12.4,v:saveC.y},{t:15.7,v:ctrOf(R.progIp).y},{t:16.2,v:dlC.y},{t:18.0,v:dlC.y},{t:24.0,v:C.network.y},{t:24.7,v:C.netNode.y},{t:26.2,v:C.netNode.y},{t:35.0,v:C.funcTab.y-30},{t:35.5,v:C.funcTab.y},{t:36.3,v:C.funcTab.y},{t:36.9,v:C.funcDev.y},{t:37.4,v:C.funcDev.y},{t:38.4,v:C.funcDev.y}]
const CURON=[[6.2,8.1],[8.7,12.5],[15.5,18.1],[23.9,26.0],[34.9,36.4],[36.8,38.4]]
const CLICKS=[7.2,11.15,16.4,24.9,35.7,37.5]
const TIP={text:'192.168.20.40',a:9.0,b:9.9}, TPATH={text:'1,0',a:10.0,b:10.3}
const CAPS=[
 {a:3.4,b:4.6,k:'Central Control',h:'One hub. <b>Every controller.</b>'},
 {a:5.2,b:6.0,k:'',h:'<b>MCM01</b> — live status & tags.'},
 {a:6.2,b:8.2,k:'Configure',h:'Set the connection <b>once.</b>'},
 {a:9.0,b:12.4,k:'',h:'IP &amp; path — <b>Save & Connect.</b>'},
 {a:14.0,b:18.2,k:'Push programs',h:'Download to any PLC. <b>One click.</b>'},
 {a:19.2,b:22.4,k:'I/O validation',h:'Every point — <b>pass or fail.</b>'},
 {a:23.4,b:26.4,k:'Network',h:'Live DLR ring — <b>healthy & faulted.</b>'},
 {a:27.0,b:29.6,k:'E-Stop',h:'<b>E-stop zones.</b>'},
 {a:30.4,b:33.0,k:'Safety',h:'<b>STO bypass zones.</b>'},
 {a:33.8,b:39.2,k:'Functional',h:'Sheets &rarr; pick <b>VFD</b> &rarr; validate.'},
 {a:40.0,b:45.4,k:'Guided VFD wizard',h:'Online &rarr; identity &rarr; HP &rarr; bump &rarr; controls &rarr; <b>speed.</b>'},
]
const VDESC=['Confirm the drive is powered and online.','Verify the drive catalog & firmware identity.','Confirm the motor HP / FLA rating.','Bump the motor — confirm rotation direction.','Verify start / stop / speed reference.','Calibrate speed reference & feedback.']
const VCHK=['VFD online','Identity matched','Horsepower verified','Direction correct','Controls verified','Speed calibrated']
function render(t){
  const cov=$('#cover');const co=t<2.3?1:t<2.9?1-(t-2.3)/0.6:0;cov.style.opacity=co;cov.style.display=co<=0?'none':'flex'
  $('#cover img').style.opacity=clamp01((t-0.3)/0.9);$('#cbig').style.opacity=clamp01((t-1.2)/0.9)
  const cx=S(CX,t),cy=S(CY,t),cs=S(CS,t)
  cam.style.transform='translate('+(VW/2)+'px,'+(VH/2)+'px) scale('+cs+') translate('+(-cx)+'px,'+(-cy)+'px)'
  for(const w of winApp){const el=$('#'+w[0]);const p=clamp01((t-w[1])/(w[2]-w[1]));el.style.opacity=p;el.style.transform='translateY('+((1-ease(p))*40)+'px)'}
  const cin=clamp01((t-8.0)/0.55),cout=clamp01((t-12.5)/0.45);cfg.style.opacity=cin*(1-cout);cfg.style.transform='scale('+(0.93+0.07*ease(cin))+')'
  $('#fip .vip').textContent=TIP.text.slice(0,Math.round(clamp01((t-TIP.a)/(TIP.b-TIP.a))*TIP.text.length))
  $('#fpath .vpath').textContent=TPATH.text.slice(0,Math.round(clamp01((t-TPATH.a)/(TPATH.b-TPATH.a))*TPATH.text.length))
  $('#fsys').style.opacity=1-clamp01((t-34.4)/0.5)
  $('#fss').style.opacity=clamp01((t-34.4)/0.5)*(1-clamp01((t-35.7)/0.45))
  $('#fvfd').style.opacity=clamp01((t-35.7)/0.45)
  const hl=$('#hl');let ho=0,hr=null;for(const h of HLS){if(t>=h.a-0.3&&t<=h.b+0.3){const inn=clamp01((t-h.a+0.3)/0.3),out=clamp01((t-h.b)/0.3);ho=inn*(1-out);hr=h.r}}
  if(hr&&ho>0){hl.style.left=hr.x+'px';hl.style.top=hr.y+'px';hl.style.width=hr.w+'px';hl.style.height=hr.h+'px';const pu=0.6+0.4*Math.sin(t*3.2);hl.style.opacity=ho;hl.style.boxShadow='0 0 0 4px rgba(240,200,78,'+(0.12+0.1*pu)+'),0 0 '+(28+16*pu)+'px 5px rgba(240,200,78,'+(0.4+0.2*pu)+')'}else hl.style.opacity=0
  let curon=0;for(const c of CURON){if(t>=c[0]&&t<=c[1])curon=clamp01((t-c[0])/0.16)*(1-clamp01((t-c[1]+0.16)/0.16))}
  let press=1;for(const c of CLICKS){const d=t-c;if(d>=-0.1&&d<=0.26)press=Math.min(press,1-0.26*Math.exp(-Math.pow(d/0.075,2)))}
  const sp=proj(SO(CURX,t),SO(CURY,t),cx,cy,cs);const cur=$('#cursor');cur.style.opacity=curon;cur.style.transform='translate('+sp.x+'px,'+sp.y+'px) scale('+press+')'
  const ck=$('#click');let clo=0,clx=0,cly=0;for(const c of CLICKS){if(t>=c&&t<=c+0.32){clo=1-(t-c)/0.32;const pp=proj(SO(CURX,c),SO(CURY,c),S(CX,c),S(CY,c),S(CS,c));clx=pp.x;cly=pp.y}}
  ck.style.opacity=clo*0.9;ck.style.left=(clx-27)+'px';ck.style.top=(cly-27)+'px';ck.style.transform='scale('+(0.4+(1-clo)*1.5)+')'
  const vOn=clamp01((t-39.5)/0.5)*(1-clamp01((t-45.4)/0.45));$('#vfdov').style.opacity=vOn
  if(vOn>0.01){const vt0=40.0,sd=0.82;let cont=(t-vt0)/sd;if(cont<0)cont=0;if(cont>5)cont=5;const fl=Math.floor(cont),frac=cont-fl;const slide=clamp01((frac-0.5)/0.34);const i0=Math.min(5,fl),i1=Math.min(5,fl+1);const y0=D.VFD.rows[i0].y,y1=D.VFD.rows[i1].y;$('#vactive').style.top=(y0+(y1-y0)*ease(slide))+'px';const aidx=slide>0.5?i1:i0;for(let i=0;i<6;i++){const rw=$('#vrow'+i);if(!rw)continue;const on=i===aidx;rw.querySelector('.vname').style.color=on?'#f4d978':'#7b8497';const nm=rw.querySelector('.vnum');nm.style.color=on?'#f0c84e':'#8a93a5';nm.style.borderColor=on?'#f0c84e':'#3a4150';nm.style.background=on?'rgba(240,200,78,.12)':'transparent'}const dip=1-0.6*Math.sin(slide*Math.PI);$('#vtitle').textContent='Step '+(aidx+1)+': '+D.VFD.rows[aidx].name;$('#vtitle').style.opacity=dip;$('#vdesc').textContent=VDESC[aidx];$('#vcktxt').textContent=VCHK[aidx];$('#vbody').style.opacity=dip}
  let kk='',tt2='',cap=0;for(const c of CAPS){if(t>=c.a-0.5&&t<=c.b+0.5){const inn=clamp01((t-c.a+0.5)/0.5),out=clamp01((t-c.b)/0.5);cap=inn*(1-out);kk=c.k;tt2=c.h}}
  $('#ck').textContent=kk;$('#ct').innerHTML=tt2;$('#cap').style.opacity=cap;$('#cap').style.transform='translateY('+((1-cap)*14)+'px)'
  $('#low').style.opacity=clamp01((t-46.0)/0.8)
}
window.__render=render
</script></body></html>`

if (process.argv.includes('--preview')) {
  const PL = `<div style="position:fixed;left:0;right:0;bottom:0;z-index:999;display:flex;gap:14px;align-items:center;padding:12px 20px;background:rgba(8,8,10,.92);border-top:1px solid rgba(214,168,46,.3);font-family:system-ui;color:#eee"><button id="pp" style="width:42px;height:34px;border:0;border-radius:8px;background:#d6a82e;color:#1a1407;font-weight:800;cursor:pointer">&#10074;&#10074;</button><input id="sc" type="range" min="0" max="${DUR}" step="0.02" value="0" style="flex:1;accent-color:#d6a82e"><span id="tl" style="font-family:monospace;font-size:14px;color:#f0c84e;min-width:64px;text-align:right">0.0s</span></div><script>(function(){let t=0,p=true,l=performance.now();const pp=document.getElementById('pp'),sc=document.getElementById('sc'),tl=document.getElementById('tl');pp.onclick=()=>{p=!p;pp.innerHTML=p?'&#10074;&#10074;':'&#9658;'};sc.oninput=()=>{t=parseFloat(sc.value);p=false;pp.innerHTML='&#9658;';window.__render(t)};function k(n){if(p){t+=(n-l)/1000;if(t>${DUR})t=0;sc.value=t}l=n;window.__render(t);tl.textContent=t.toFixed(1)+'s';requestAnimationFrame(k)}requestAnimationFrame(k)})()</script>`
  fs.writeFileSync('C:/Users/nika.fartenadze.LCIBATUMI/Desktop/commissioning-guide/cinematic-preview.html', HTML.replace('</body>', PL + '</body>'))
  console.log('PREVIEW written'); process.exit(0)
}
const probe = process.argv.find(a => a.startsWith('--probe='))
const run = async () => {
  const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--hide-scrollbars'] })
  const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 })
  await page.setContent(HTML, { waitUntil: 'networkidle' })
  await page.evaluate(async () => { try { await document.fonts.ready } catch (e) {} })
  if (probe) { fs.mkdirSync(path.join(OUT, 'probe'), { recursive: true }); for (const ts of probe.split('=')[1].split(',')) { await page.evaluate(t => window.__render(t), parseFloat(ts)); await page.screenshot({ path: path.join(OUT, 'probe', 't' + ts + '.png') }) } await browser.close(); console.log('probe done'); return }
  fs.rmSync(FR, { recursive: true, force: true }); fs.mkdirSync(FR, { recursive: true })
  const total = DUR * FPS
  for (let i = 0; i < total; i++) { await page.evaluate(t => window.__render(t), i / FPS); await page.screenshot({ path: path.join(FR, String(i).padStart(5, '0') + '.png') }); if (i % 90 === 0) process.stdout.write(`  ${i}/${total}\r`) }
  await browser.close(); console.log('\nencoding...')
  const mp4 = path.join(OUT, 'commissioning-cinematic-v3.mp4')
  execFileSync(FFMPEG, ['-y', '-framerate', String(FPS), '-i', path.join(FR, '%05d.png'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: 'inherit' })
  fs.rmSync(FR, { recursive: true, force: true })
  console.log('VIDEO:', mp4, (fs.statSync(mp4).size / 1e6).toFixed(2) + 'MB')
}
run().catch(e => { console.error('FAILED:', e); process.exit(1) })
