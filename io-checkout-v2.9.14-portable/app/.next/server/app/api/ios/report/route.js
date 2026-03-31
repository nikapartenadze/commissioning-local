"use strict";(()=>{var e={};e.id=8594,e.ids=[8594],e.modules={53524:e=>{e.exports=require("@prisma/client")},20399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},30517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},14300:e=>{e.exports=require("buffer")},6113:e=>{e.exports=require("crypto")},57147:e=>{e.exports=require("fs")},71017:e=>{e.exports=require("path")},12781:e=>{e.exports=require("stream")},73837:e=>{e.exports=require("util")},77292:(e,t,s)=>{s.r(t),s.d(t,{originalPathname:()=>f,patchFetch:()=>b,requestAsyncStorage:()=>m,routeModule:()=>p,serverHooks:()=>g,staticGenerationAsyncStorage:()=>h});var r={};s.r(r),s.d(r,{GET:()=>c,dynamic:()=>u});var a=s(67092),i=s(25932),n=s(94147),o=s(77856),l=s(53544),d=s(20760);let u="force-dynamic";async function c(e){let t=(0,d.mk)(e);if(t)return t;try{let{searchParams:t}=new URL(e.url),s=t.get("subsystemId");if(!s)return o.NextResponse.json({error:"subsystemId is required"},{status:400});let r=parseInt(s,10),a=await l._B.subsystem.findUnique({where:{id:r},include:{project:{select:{name:!0}}}}),i=await l._B.io.findMany({where:{subsystemId:r},orderBy:{order:"asc"}}),n=i.filter(e=>"Failed"===e.result||"Fail"===e.result),d=await l._B.testHistory.findMany({where:{ioId:{in:i.map(e=>e.id)}},orderBy:{timestamp:"desc"}}),u=d.filter(e=>"Failed"===e.result||"Fail"===e.result),c=new Map;for(let e of u)c.has(e.ioId)||c.set(e.ioId,{failureMode:e.failureMode,testedBy:e.testedBy});let p=new Map;for(let e of d)p.has(e.ioId)||p.set(e.ioId,{failureMode:e.failureMode,testedBy:e.testedBy});let m=i.length,h=i.filter(e=>"Passed"===e.result||"Pass"===e.result).length,g=n.length,f=i.filter(e=>!e.result||""===e.result).length,b=m>0?((h+g)/m*100).toFixed(1):"0.0",v=a?.project?.name||"Unknown Project",x=a?.name||`Subsystem ${r}`,y=new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric",hour:"2-digit",minute:"2-digit"}),w=e=>e?e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"):"",S=e=>{if(!e)return"—";try{return new Date(e).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric",hour:"2-digit",minute:"2-digit"})}catch{return e}},T=e=>"Pass"===e?"color: #16a34a; font-weight: bold;":"Fail"===e?"color: #dc2626; font-weight: bold;":"color: #6b7280;",R=i.map(e=>{let t=p.get(e.id);return`
      <tr>
        <td>${w(e.name)}</td>
        <td>${w(e.description)}</td>
        <td style="${T(e.result)}">${e.result||"Not Tested"}</td>
        <td>${w(t?.failureMode)||""}</td>
        <td>${w(e.tagType)}</td>
        <td>${S(e.timestamp)}</td>
        <td>${w(t?.testedBy)||""}</td>
        <td>${w(e.comments)}</td>
      </tr>
    `}).join(""),_=n.map(e=>{let t=c.get(e.id);return`
        <tr>
          <td>${w(e.name)}</td>
          <td>${w(e.description)}</td>
          <td>${w(t?.failureMode)||"—"}</td>
          <td>${w(t?.testedBy)||"—"}</td>
          <td>${w(e.comments)}</td>
        </tr>
      `}).join(""),k=`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Commissioning Report — ${w(v)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; padding: 40px; max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  h2 { font-size: 18px; margin: 32px 0 12px; border-bottom: 2px solid #e5e7eb; padding-bottom: 6px; }
  .meta { color: #6b7280; font-size: 14px; margin-bottom: 24px; }
  .summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 32px; }
  .summary-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; text-align: center; }
  .summary-card .value { font-size: 28px; font-weight: 700; }
  .summary-card .label { font-size: 12px; color: #6b7280; text-transform: uppercase; margin-top: 4px; }
  .pass { color: #16a34a; }
  .fail { color: #dc2626; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 24px; }
  th, td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; }
  th { background: #f3f4f6; font-weight: 600; font-size: 12px; text-transform: uppercase; }
  tr:nth-child(even) { background: #f9fafb; }
  .sign-off { margin-top: 48px; page-break-inside: avoid; }
  .sign-line { display: flex; align-items: flex-end; gap: 12px; margin: 28px 0; }
  .sign-line .label { font-weight: 600; min-width: 120px; }
  .sign-line .line { flex: 1; border-bottom: 1px solid #1a1a1a; min-width: 200px; }
  .sign-line .date-line { width: 180px; border-bottom: 1px solid #1a1a1a; }
  .no-print { margin-bottom: 24px; }
  .no-print button { padding: 10px 24px; background: #2563eb; color: white; border: none; border-radius: 6px; font-size: 15px; cursor: pointer; margin-right: 8px; }
  .no-print button:hover { background: #1d4ed8; }

  @media print {
    body { padding: 0; }
    .no-print { display: none !important; }
    h2 { page-break-after: avoid; }
    table { page-break-inside: auto; }
    tr { page-break-inside: avoid; }
    .sign-off { page-break-before: always; }
  }
</style>
</head>
<body>

<div class="no-print">
  <button onclick="window.print()">Print / Save as PDF</button>
</div>

<h1>Commissioning Report</h1>
<p class="meta">${w(v)} — ${w(x)}<br>Generated: ${w(y)}</p>

<h2>Summary</h2>
<div class="summary">
  <div class="summary-card"><div class="value">${m}</div><div class="label">Total IOs</div></div>
  <div class="summary-card"><div class="value pass">${h}</div><div class="label">Passed</div></div>
  <div class="summary-card"><div class="value fail">${g}</div><div class="label">Failed</div></div>
  <div class="summary-card"><div class="value">${f}</div><div class="label">Not Tested</div></div>
  <div class="summary-card"><div class="value">${b}%</div><div class="label">Completion</div></div>
</div>

<h2>IO Results</h2>
<table>
  <thead>
    <tr><th>IO Name</th><th>Description</th><th>Result</th><th>Failure Reason</th><th>Tag Type</th><th>Timestamp</th><th>Tested By</th><th>Comments</th></tr>
  </thead>
  <tbody>${R}</tbody>
</table>

${n.length>0?`
<h2>Failed IOs — Detail</h2>
<table>
  <thead>
    <tr><th>IO Name</th><th>Description</th><th>Failure Reason</th><th>Tested By</th><th>Comments</th></tr>
  </thead>
  <tbody>${_}</tbody>
</table>
`:""}

<div class="sign-off">
  <h2>Sign-Off</h2>
  <div class="sign-line"><span class="label">Technician:</span><span class="line"></span><span class="label">Date:</span><span class="date-line"></span></div>
  <div class="sign-line"><span class="label">Supervisor:</span><span class="line"></span><span class="label">Date:</span><span class="date-line"></span></div>
  <div class="sign-line"><span class="label">Project Manager:</span><span class="line"></span><span class="label">Date:</span><span class="date-line"></span></div>
</div>

</body>
</html>`;return new o.NextResponse(k,{headers:{"Content-Type":"text/html; charset=utf-8"}})}catch(e){return console.error("Failed to generate report:",e),o.NextResponse.json({error:"Failed to generate report"},{status:500})}}let p=new a.AppRouteRouteModule({definition:{kind:i.x.APP_ROUTE,page:"/api/ios/report/route",pathname:"/api/ios/report",filename:"route",bundlePath:"app/api/ios/report/route"},resolvedPagePath:"C:\\Users\\nfart\\OneDrive\\Desktop\\commissioning-local\\frontend\\app\\api\\ios\\report\\route.ts",nextConfigOutput:"standalone",userland:r}),{requestAsyncStorage:m,staticGenerationAsyncStorage:h,serverHooks:g}=p,f="/api/ios/report/route";function b(){return(0,n.patchFetch)({serverHooks:g,staticGenerationAsyncStorage:h})}},4825:(e,t,s)=>{s.d(t,{RA:()=>p,UY:()=>l,WX:()=>m,oA:()=>h});var r=s(55760),a=s.n(r);let i=()=>{let e=globalThis;return e.__tokenStore||(e.__tokenStore=new Map),e.__tokenStore},n=()=>{let e=globalThis;return e.__revokedTokens||(e.__revokedTokens=new Set),e.__revokedTokens},o=0;function l(e){let t=i(),s=n(),r=Date.now();t.forEach((t,a)=>{t.userId===e&&t.expiresAt>r&&s.add(a)})}let d=null,u=()=>{if(d)return d;let e=process.env.JWT_SECRET_KEY;if(e&&"change-this-to-a-random-secret"!==e)return d=e,e;let t=s(57147),r=s(71017).join(process.cwd(),".jwt-secret");try{if(t.existsSync(r))return d=t.readFileSync(r,"utf8").trim()}catch{}let a=crypto.randomUUID()+"-"+crypto.randomUUID();try{t.writeFileSync(r,a,"utf8"),console.log("[Auth] Generated new JWT secret (saved to .jwt-secret)")}catch{console.warn("[Auth] Could not persist JWT secret to file — tokens will invalidate on restart")}return d=a,a},c=()=>({secretKey:u(),issuer:process.env.JWT_ISSUER||"io-checkout-tool",audience:process.env.JWT_AUDIENCE||"io-checkout-frontend",expirationHours:parseInt(process.env.JWT_EXPIRATION_HOURS||"8",10)});function p(e){var t,s,r;let n=c(),o={sub:e.id.toString(),fullName:e.fullName,isAdmin:e.isAdmin,jti:crypto.randomUUID()},l={algorithm:"HS256",issuer:n.issuer,audience:n.audience,expiresIn:`${n.expirationHours}h`},d=a().sign(o,n.secretKey,l);return t=o.jti,s=e.id.toString(),r=36e5*n.expirationHours,i().set(t,{userId:s,expiresAt:Date.now()+r}),d}function m(e){try{var t;let s=c(),r={algorithms:["HS256"],issuer:s.issuer,audience:s.audience},l=a().verify(e,s.secretKey,r);if((t=l.jti)&&(++o>=100&&(o=0,function(){let e=i(),t=n(),s=Date.now(),r=[];e.forEach((e,t)=>{e.expiresAt<=s&&r.push(t)}),r.forEach(s=>{e.delete(s),t.delete(s)})}()),n().has(t)))return null;return l}catch(e){return e instanceof Error&&e.message.includes("JWT_SECRET_KEY")&&console.error("[Auth] JWT_SECRET_KEY not configured — cannot verify tokens"),null}}function h(e){if(!e)return null;let t=e.split(" ");return 2!==t.length||"bearer"!==t[0].toLowerCase()?null:t[1]}},20760:(e,t,s)=>{s.d(t,{RA:()=>i,kF:()=>o,mk:()=>n,nX:()=>l,rU:()=>d});var r=s(77856),a=s(4825);function i(e){let t=e.headers.get("authorization"),s=(0,a.oA)(t);if(!s)return{success:!1,error:"Authorization header missing or invalid",status:401};let r=(0,a.WX)(s);return r?{success:!0,user:r}:{success:!1,error:"Invalid or expired token",status:401}}function n(e){let t=i(e);return t.success?null:r.NextResponse.json({message:t.error},{status:t.status||401})}function o(e){let t=i(e);return t.success?t.user?.isAdmin?null:r.NextResponse.json({message:"Admin access required"},{status:403}):r.NextResponse.json({message:t.error},{status:t.status||401})}function l(e){let t=i(e);return t.success?t.user:null}function d(e){return async t=>{let s=i(t);return s.success?s.user?.isAdmin?e(t,s.user):r.NextResponse.json({message:"Admin access required"},{status:403}):r.NextResponse.json({message:s.error},{status:s.status||401})}}},53544:(e,t,s)=>{s.d(t,{_B:()=>n,cY:()=>l,lF:()=>o});var r=s(53524);let a=globalThis,i=a.prisma??new r.PrismaClient({log:["error"]});a.prisma||(i.$queryRawUnsafe("PRAGMA journal_mode=WAL").catch(e=>console.warn("[DB] WAL mode failed:",e)),i.$queryRawUnsafe("PRAGMA busy_timeout=5000").catch(e=>console.warn("[DB] busy_timeout failed:",e)));let n=i,o={RESULT_PASSED:"Passed",RESULT_FAILED:"Failed"};function l(e){let t=e.name??"";return{...e,isOutput:t.includes(":O.")||t.includes(":SO.")||t.includes(".O.")||t.includes(":O:")||t.includes(".Outputs.")||t.endsWith(".DO"),hasResult:!!e.result,isPassed:e.result===o.RESULT_PASSED,isFailed:e.result===o.RESULT_FAILED}}}};var t=require("../../../../webpack-runtime.js");t.C(e);var s=e=>t(t.s=e),r=t.X(0,[1111,9965,5760],()=>s(77292));module.exports=r})();