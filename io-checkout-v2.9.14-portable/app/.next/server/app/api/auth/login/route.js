"use strict";(()=>{var e={};e.id=8873,e.ids=[8873],e.modules={53524:e=>{e.exports=require("@prisma/client")},20399:e=>{e.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")},30517:e=>{e.exports=require("next/dist/compiled/next-server/app-route.runtime.prod.js")},14300:e=>{e.exports=require("buffer")},6113:e=>{e.exports=require("crypto")},57147:e=>{e.exports=require("fs")},71017:e=>{e.exports=require("path")},12781:e=>{e.exports=require("stream")},73837:e=>{e.exports=require("util")},16816:(e,t,n)=>{n.r(t),n.d(t,{originalPathname:()=>S,patchFetch:()=>L,requestAsyncStorage:()=>v,routeModule:()=>C,serverHooks:()=>I,staticGenerationAsyncStorage:()=>O});var o={};n.r(o),n.d(o,{POST:()=>w,dynamic:()=>y});var i=n(67092),r=n(25932),a=n(94147),s=n(77856),c=n(4825),l=n(53288),u=n(41579),h=n(53544);let d=null;async function m(){if(!d)try{d=await Promise.resolve().then(n.bind(n,82009))}catch{console.warn("bcryptjs not available - PIN validation will not work")}return d}let p={async authenticateByPin(e){let t=await m();if(!t)return{success:!1,error:"Authentication not available"};for(let n of(await h._B.user.findMany({where:{isActive:!0}})))if(await t.compare(e,n.pin))return await h._B.user.update({where:{id:n.id},data:{lastUsedAt:new Date().toISOString()}}),{success:!0,user:n};return{success:!1,error:"Invalid PIN"}},async authenticate(e,t){let n=await m();if(!n)return{success:!1,error:"Authentication not available"};let o=await h._B.user.findUnique({where:{fullName:e}});return o?o.isActive?await n.compare(t,o.pin)?(await h._B.user.update({where:{id:o.id},data:{lastUsedAt:new Date().toISOString()}}),{success:!0,user:o}):{success:!1,error:"Invalid PIN"}:{success:!1,error:"User is inactive"}:{success:!1,error:"User not found"}},async create(e){let t=await m();if(!t)throw Error("Cannot create user - bcrypt not available");let n=await t.hash(e.pin,11);return h._B.user.create({data:{fullName:e.fullName,pin:n,isAdmin:e.isAdmin??!1,isActive:!0,createdAt:new Date().toISOString()}})},getById:async e=>h._B.user.findUnique({where:{id:e}}),getByFullName:async e=>h._B.user.findUnique({where:{fullName:e}}),getAll:async(e=!1)=>h._B.user.findMany({where:e?{}:{isActive:!0},orderBy:{fullName:"asc"}}),getAdmins:async()=>h._B.user.findMany({where:{isAdmin:!0,isActive:!0},orderBy:{fullName:"asc"}}),async update(e,t){let n={};if(void 0!==t.fullName&&(n.fullName=t.fullName),void 0!==t.pin){let e=await m();if(!e)throw Error("Cannot update PIN - bcrypt not available");n.pin=await e.hash(t.pin,11)}return void 0!==t.isAdmin&&(n.isAdmin=t.isAdmin),void 0!==t.isActive&&(n.isActive=t.isActive),h._B.user.update({where:{id:e},data:n})},async updatePin(e,t){return this.update(e,{pin:t})},deactivate:async e=>h._B.user.update({where:{id:e},data:{isActive:!1}}),reactivate:async e=>h._B.user.update({where:{id:e},data:{isActive:!0}}),async delete(e){await h._B.user.delete({where:{id:e}})},exists:async e=>await h._B.user.count({where:{fullName:e}})>0,count:async(e=!0)=>h._B.user.count({where:e?{isActive:!0}:{}}),validatePinFormat:e=>/^\d{6}$/.test(e),async ensureDefaultAdmin(){0===await h._B.user.count()&&await this.create({fullName:"Admin",pin:"111111",isAdmin:!0})}},g=[{tagType:"TPE Dark Operated",failureMode:"No response",diagnosticSteps:`# TPE Dark Operated — No Response

## Quick Checks
1. Verify 24V power is present at the sensor terminals
2. Check the sensor indicator LED — it should be **OFF** in the normal (dark) state
3. Confirm wiring polarity: Brown = +24V, Blue = 0V, Black = Signal

## Wiring
- Disconnect the sensor cable at the device end
- Measure continuity from the sensor connector back to the IO module terminal
- Check for damaged or pinched cable along the run

## Sensor
- Verify the sensor is aimed correctly at the target area
- Clean the sensor lens — dust or debris can block the beam
- Check sensing distance — TPE sensors typically have 0.5–2m range
- Try swapping with a known-good sensor to isolate the issue

## IO Module
- Check the channel LED on the IO module — it should react when sensor state changes
- Verify the IO module is online (no fault LEDs)
- Check the slot/channel assignment matches the PLC program`},{tagType:"TPE Dark Operated",failureMode:"Stuck ON",diagnosticSteps:`# TPE Dark Operated — Stuck ON

The sensor is reporting active (beam blocked) but nothing is in the sensing area.

## Quick Checks
1. Check for obstructions in the beam path — debris, tape, misaligned brackets
2. Clean the sensor lens
3. Check the sensor indicator LED — if it's ON with no target, the sensor may be faulty

## Alignment
- Verify reflector (if retro-reflective) is aligned and clean
- Check mounting bracket — vibration may have shifted the sensor

## Electrical
- Measure signal wire voltage at the IO module terminal
- If voltage is present with sensor disconnected, check for a short in the cable
- Try a known-good sensor

## PLC Program
- Verify the tag is not inverted in the PLC logic
- Dark operated means the signal should be TRUE when beam is **blocked**, FALSE when clear`},{tagType:"TPE Dark Operated",failureMode:"Intermittent",diagnosticSteps:`# TPE Dark Operated — Intermittent

Signal is flickering or dropping out randomly.

## Quick Checks
1. Check all cable connections — loose connectors are the #1 cause
2. Look for cable damage — especially near moving parts or sharp edges
3. Check for electrical noise sources nearby (VFDs, welders, solenoids)

## Mechanical
- Tighten all mounting hardware — vibration causes intermittent connections
- Check the cable routing — avoid running parallel to power cables
- Verify the target is stable and not vibrating through the sensing area

## Electrical
- Wiggle the connector while monitoring the signal — if it drops, replace the cable
- Measure signal voltage under load — should be clean 0V or 24V, not floating
- Check grounding of the sensor shield wire`},{tagType:"TPE Dark Operated",failureMode:"Other",diagnosticSteps:`# TPE Dark Operated — Other Issue

If none of the standard failure modes apply:

1. Document the exact behavior you're observing
2. Note any patterns — does it happen at certain times, after certain events?
3. Check the PLC program for any logic that might override or mask the signal
4. Verify the tag type assignment is correct — is this actually a TPE Dark Operated device?
5. Escalate to engineering with your observations`},{tagType:"BCN 24V Segment 1",failureMode:"No response",diagnosticSteps:`# BCN 24V Segment 1 — No Response

Beacon stack bottom segment (24V hardwired) is not responding.

## Quick Checks
1. Visually confirm the beacon is not illuminated
2. Check 24V power at the beacon base terminal block
3. Verify the correct segment — Segment 1 is the **bottom** segment

## Wiring
- Check the terminal block connections at the base of the beacon stack
- Trace the wire from the IO module to the beacon — look for breaks or loose terminals
- Measure voltage at the beacon terminal while the output is commanded ON

## IO Module
- Verify the output channel LED on the IO module lights up when commanded
- Check if other outputs on the same module work — if none work, the module may be faulted
- Verify slot/channel matches PLC program

## Beacon
- If voltage is present at the beacon but no light, the segment bulb/LED may be burned out
- Try swapping segments to confirm — move segment 1 to segment 2 position
- Check the DIP switches on the **bottom** of segment 1`},{tagType:"BCN 24V Segment 1",failureMode:"Wrong color",diagnosticSteps:`# BCN 24V Segment 1 — Wrong Color

Beacon segment illuminates but shows the wrong color.

## Quick Checks
1. Verify which segment is physically installed in position 1 (bottom)
2. Check the DIP switch settings on the bottom of the segment
3. Confirm the bill of materials matches what's installed

## DIP Switches (Bottom of Segment)
- Refer to the beacon manufacturer documentation for DIP switch color codes
- Common Patlite settings:
  - SW1=OFF, SW2=OFF → Red
  - SW1=ON, SW2=OFF → Amber
  - SW1=OFF, SW2=ON → Green
  - SW1=ON, SW2=ON → Blue

## Resolution
- Adjust DIP switches to the correct color
- Or swap the physical segment with the correct color module`},{tagType:"BCN 24V Segment 1",failureMode:"Other",diagnosticSteps:`# BCN 24V Segment 1 — Other Issue

1. Document the exact symptom (dim, flickering, wrong pattern, etc.)
2. Check all mechanical connections — beacon segments stack and twist-lock
3. Verify DIP switch positions on the bottom of the segment
4. Try the segment in a different position on the stack
5. Escalate if unresolved`},{tagType:"BCN I/O Link Segment 1",failureMode:"No response",diagnosticSteps:`# BCN I/O Link Segment 1 — No Response

Beacon stack bottom segment (IO-Link controlled) is not responding.

## Quick Checks
1. Check the IO-Link master port LED — should show active communication
2. Verify 24V power is present at the beacon base
3. Confirm the IO-Link master port is configured for the correct device profile

## IO-Link Communication
- Check the IO-Link master diagnostics in the PLC program
- Verify the port assignment and device ID match the beacon
- If the port shows "no device," check the M12 cable connection
- Try a different IO-Link port to isolate master vs device issue

## Wiring
- Inspect the M12 connector at both ends (IO-Link master and beacon)
- Check for bent pins in the M12 connector
- Try a known-good IO-Link cable

## Beacon
- IO-Link beacons require proper parameterization
- Check if the beacon responds to a manual IO-Link port reset`},{tagType:"BCN I/O Link Segment 1",failureMode:"Communication error",diagnosticSteps:`# BCN I/O Link Segment 1 — Communication Error

IO-Link master reports communication issues with the beacon.

## Quick Checks
1. Check IO-Link master port diagnostics for specific error codes
2. Reseat the M12 connector at both ends
3. Check cable length — IO-Link max cable length is 20m

## Common IO-Link Errors
- **Port not configured**: Set the IO-Link master port to IO-Link mode (not SIO or DI)
- **Device mismatch**: The device ID doesn't match what the master expects
- **Cable fault**: Try a different cable
- **Parameter error**: The beacon may need re-parameterization after replacement

## Resolution
- Reset the IO-Link port from the PLC program or web interface
- Re-download IO-Link parameters to the device
- If persistent, replace the beacon and re-parameterize`},{tagType:"BCN I/O Link Segment 1",failureMode:"Other",diagnosticSteps:`# BCN I/O Link Segment 1 — Other Issue

1. Check IO-Link master diagnostics for detailed error information
2. Verify the IO-Link device profile and parameters are correct
3. Document the exact behavior and any error codes
4. Escalate to controls engineering`},{tagType:"Button Press",failureMode:"No response",diagnosticSteps:`# Button Press — No Response

Pushbutton input does not register when pressed.

## Quick Checks
1. Press the button firmly — some buttons require deliberate force
2. Check the indicator LED on the IO module channel while pressing
3. Verify 24V is present at the button terminal

## Wiring
- Check terminal connections at the button and at the IO module
- Measure continuity through the button contacts (normally open)
- Press the button while measuring — resistance should drop to near 0Ω
- Check for broken wires, especially at flex points near the button

## Button
- Inspect the button mechanism — stuck, damaged, or contaminated contacts
- Try pressing from different angles — mechanical binding can prevent actuation
- Check if the button contact block is properly seated on the operator
- Try a known-good contact block

## IO Module
- If the LED doesn't light with a jumper wire across the input terminals, the module channel may be faulty
- Check module power and communication status`},{tagType:"Button Press",failureMode:"Stuck ON",diagnosticSteps:`# Button Press — Stuck ON

Input shows active without the button being pressed.

## Quick Checks
1. Check if the button is physically stuck in the pressed position
2. Disconnect the wire at the IO module — if signal clears, the issue is in the field wiring
3. If signal persists with wire disconnected, the IO module channel may be faulty

## Mechanical
- Clean around the button — debris can hold it in
- Check the contact block mounting — it may be misaligned and pressing the contacts
- Verify the correct contact block type (NO vs NC) matches the application

## Electrical
- Check for shorts in the cable — especially where wires run together
- Verify no other signal is back-feeding into this channel`},{tagType:"Button Press",failureMode:"Intermittent",diagnosticSteps:`# Button Press — Intermittent

Button sometimes registers, sometimes doesn't.

## Quick Checks
1. Tighten all terminal connections
2. Check the contact block seating on the button operator
3. Wiggle the cable while monitoring — intermittent = loose connection

## Common Causes
- Worn button contacts — replace the contact block
- Loose terminal screws — retorque
- Cable damage at flex point — reroute or replace
- Contaminated contacts — clean with contact cleaner`},{tagType:"Button Press",failureMode:"Other",diagnosticSteps:`# Button Press — Other Issue

1. Document the exact behavior
2. Check if the issue is mechanical (button) or electrical (wiring/module)
3. Verify the PLC program logic for this input
4. Escalate if unresolved`},{tagType:"Button Press Normally Closed",failureMode:"No response",diagnosticSteps:`# Button Press Normally Closed — No Response

NC pushbutton input does not change state when pressed.

**Important:** NC buttons read TRUE in the normal (unpressed) state and FALSE when pressed.

## Quick Checks
1. Confirm the current PLC state — it should be TRUE (1) when the button is NOT pressed
2. Press the button — the state should go FALSE (0)
3. If the state is already FALSE with the button released, check for an open circuit

## Wiring
- NC buttons must form a complete circuit in the normal state
- Measure voltage at the IO module — should be ~24V with button released, ~0V when pressed
- Check for an open circuit: broken wire, loose terminal, or bad contact block

## Button
- Verify the contact block is NC type (usually marked NC or has specific color coding)
- A common mistake is installing a NO contact block where NC is needed
- Check if the contact block is properly seated on the button operator`},{tagType:"Button Press Normally Closed",failureMode:"Stuck ON",diagnosticSteps:`# Button Press Normally Closed — Stuck ON

NC button always reads TRUE — pressing it doesn't change the state.

## Quick Checks
1. The normal state for NC IS true — verify you're actually pressing the button fully
2. Check the IO module LED — it should turn OFF when button is pressed
3. Disconnect the field wire at the IO module — input should go FALSE. If it stays TRUE, module issue.

## Mechanical
- Button may not be actuating the NC contact block — check alignment
- The contact block spring may be broken — replace the contact block
- Verify correct contact block type is installed (NC, not NO)

## Electrical
- Check if something else is feeding 24V to this input (back-feed)
- Measure voltage with button pressed — if still 24V, the NC contacts aren't opening`},{tagType:"Button Press Normally Closed",failureMode:"Other",diagnosticSteps:`# Button Press Normally Closed — Other Issue

1. Remember: NC buttons are TRUE when released, FALSE when pressed
2. Document the exact behavior vs expected behavior
3. Verify NC vs NO contact block installation
4. Check PLC logic for inversions
5. Escalate if unresolved`},{tagType:"Button Light",failureMode:"No response",diagnosticSteps:`# Button Light — No Response

Illuminated pushbutton light does not turn on when commanded.

## Quick Checks
1. Verify the PLC is commanding the output ON — check the output channel LED on the IO module
2. Check 24V power at the button light terminal
3. Confirm you're checking the correct button — the light is a separate output from the button press input

## Wiring
- The button light circuit is typically separate from the button contact circuit
- Trace the output wire from the IO module to the button light terminal
- Measure voltage at the button while the output is commanded ON
- Check for broken wires or loose terminals

## Button Light
- If 24V is present but no light, the LED/bulb in the button may be burned out
- Check if the light module is properly seated in the button operator
- Try a known-good light module

## IO Module
- Verify the output channel is working — try commanding a different output on the same module
- Check module fault status
- Verify slot/channel assignment in PLC program`},{tagType:"Button Light",failureMode:"Stuck ON",diagnosticSteps:`# Button Light — Stuck ON

Button light stays illuminated when it should be off.

## Quick Checks
1. Verify the PLC is NOT commanding the output ON — check the output tag value
2. Check the IO module output LED — if it's OFF but the light is ON, there may be a back-feed

## Electrical
- Disconnect the output wire at the IO module — if the light stays on, 24V is coming from somewhere else
- Check for shorts between the output wire and adjacent 24V wires in the same cable
- Verify the output module type — some modules have leakage current that can illuminate LEDs

## PLC Program
- Check all logic that controls this output — another rung may be latching it ON
- Verify the correct tag address is being used`},{tagType:"Button Light",failureMode:"Wrong color",diagnosticSteps:`# Button Light — Wrong Color

Button illuminates but in the wrong color.

## Quick Checks
1. Verify which LED module is installed in the button
2. Check if this is a multi-color LED button — some have multiple inputs for different colors
3. Confirm the bill of materials for the correct LED color

## Resolution
- Replace the LED module with the correct color
- If multi-color, verify the PLC is commanding the correct output for the desired color
- Check if LED modules were swapped between buttons during installation`},{tagType:"Button Light",failureMode:"Intermittent",diagnosticSteps:`# Button Light — Intermittent

Button light flickers or turns on/off randomly.

## Quick Checks
1. Check if the PLC output is stable — monitor the tag value for fluctuations
2. Tighten all terminal connections
3. Check the LED module seating in the button

## Common Causes
- Loose LED module — reseat it firmly
- Loose terminal connection — retorque screws
- Overloaded output channel — check current draw vs module rating
- Failing LED module — replace`},{tagType:"Button Light",failureMode:"Other",diagnosticSteps:`# Button Light — Other Issue

1. Document the exact symptom (dim, wrong pattern, etc.)
2. Verify the output is being commanded correctly from the PLC
3. Check all connections from IO module to button
4. Try a known-good LED module
5. Escalate if unresolved`}],f=!1;async function k(){if(!f)try{if(await h._B.tagTypeDiagnostic.count()>0){f=!0;return}for(let e of g)await h._B.tagTypeDiagnostic.upsert({where:{tagType_failureMode:{tagType:e.tagType,failureMode:e.failureMode}},create:{tagType:e.tagType,failureMode:e.failureMode,diagnosticSteps:e.diagnosticSteps,createdAt:new Date},update:{}});f=!0,console.log(`[DB] Auto-seeded ${g.length} diagnostic entries`)}catch(e){console.warn("[DB] Failed to seed diagnostics:",e.message)}}let y="force-dynamic",b=new Map;async function w(e){try{let t,n;let o=e.headers.get("x-forwarded-for")?.split(",")[0]?.trim()||e.headers.get("x-real-ip")||"unknown",i=function(e){let t=Date.now(),n=b.get(e);if(b.size>1e3)for(let[e,n]of Array.from(b.entries()))t-n.windowStart>6e4&&b.delete(e);return!n||t-n.windowStart>6e4?(b.set(e,{attempts:1,windowStart:t}),{allowed:!0,remaining:4,resetAt:t+6e4}):n.attempts>=5?{allowed:!1,remaining:0,resetAt:n.windowStart+6e4}:(n.attempts+=1,{allowed:!0,remaining:5-n.attempts,resetAt:n.windowStart+6e4})}(o);if(!i.allowed){let e=Math.ceil((i.resetAt-Date.now())/1e3);return s.NextResponse.json({message:"Too many login attempts. Please try again later."},{status:429,headers:{"Retry-After":e.toString(),"X-RateLimit-Limit":"5","X-RateLimit-Remaining":"0","X-RateLimit-Reset":Math.ceil(i.resetAt/1e3).toString()}})}try{t=await e.json()}catch{return s.NextResponse.json({message:"Invalid request body"},{status:400})}let{fullName:r,pin:a}=t;if(!a?.trim())return s.NextResponse.json({message:"PIN is required"},{status:400});if(await p.ensureDefaultAdmin(),await k(),r?.trim()){if(!(n=await u._.user.findFirst({where:{fullName:r.trim()}}))||!n.isActive)return s.NextResponse.json({message:"Invalid credentials"},{status:401});if(!await (0,l.vj)(a,n.pin))return s.NextResponse.json({message:"Invalid PIN"},{status:401})}else{for(let e of(await u._.user.findMany({where:{isActive:!0}})))if(await (0,l.vj)(a,e.pin)){n=e;break}if(!n)return s.NextResponse.json({message:"Invalid PIN"},{status:401})}await u._.user.update({where:{id:n.id},data:{lastUsedAt:new Date().toISOString().replace("T"," ").substring(0,19)}});let h=(0,c.RA)({id:n.id,fullName:n.fullName,isAdmin:n.isAdmin});return console.info(`User logged in: ${n.fullName}`),s.NextResponse.json({fullName:n.fullName,isAdmin:n.isAdmin,loginTime:new Date().toISOString().replace("T"," ").substring(0,19),token:h},{status:200,headers:{"X-RateLimit-Limit":"5","X-RateLimit-Remaining":i.remaining.toString(),"X-RateLimit-Reset":Math.ceil(i.resetAt/1e3).toString()}})}catch(e){return console.error("Error during login:",e),s.NextResponse.json({message:"An error occurred during login"},{status:500})}}let C=new i.AppRouteRouteModule({definition:{kind:r.x.APP_ROUTE,page:"/api/auth/login/route",pathname:"/api/auth/login",filename:"route",bundlePath:"app/api/auth/login/route"},resolvedPagePath:"C:\\Users\\nfart\\OneDrive\\Desktop\\commissioning-local\\frontend\\app\\api\\auth\\login\\route.ts",nextConfigOutput:"standalone",userland:o}),{requestAsyncStorage:v,staticGenerationAsyncStorage:O,serverHooks:I}=C,S="/api/auth/login/route";function L(){return(0,a.patchFetch)({serverHooks:I,staticGenerationAsyncStorage:O})}},4825:(e,t,n)=>{n.d(t,{RA:()=>d,UY:()=>c,WX:()=>m,oA:()=>p});var o=n(55760),i=n.n(o);let r=()=>{let e=globalThis;return e.__tokenStore||(e.__tokenStore=new Map),e.__tokenStore},a=()=>{let e=globalThis;return e.__revokedTokens||(e.__revokedTokens=new Set),e.__revokedTokens},s=0;function c(e){let t=r(),n=a(),o=Date.now();t.forEach((t,i)=>{t.userId===e&&t.expiresAt>o&&n.add(i)})}let l=null,u=()=>{if(l)return l;let e=process.env.JWT_SECRET_KEY;if(e&&"change-this-to-a-random-secret"!==e)return l=e,e;let t=n(57147),o=n(71017).join(process.cwd(),".jwt-secret");try{if(t.existsSync(o))return l=t.readFileSync(o,"utf8").trim()}catch{}let i=crypto.randomUUID()+"-"+crypto.randomUUID();try{t.writeFileSync(o,i,"utf8"),console.log("[Auth] Generated new JWT secret (saved to .jwt-secret)")}catch{console.warn("[Auth] Could not persist JWT secret to file — tokens will invalidate on restart")}return l=i,i},h=()=>({secretKey:u(),issuer:process.env.JWT_ISSUER||"io-checkout-tool",audience:process.env.JWT_AUDIENCE||"io-checkout-frontend",expirationHours:parseInt(process.env.JWT_EXPIRATION_HOURS||"8",10)});function d(e){var t,n,o;let a=h(),s={sub:e.id.toString(),fullName:e.fullName,isAdmin:e.isAdmin,jti:crypto.randomUUID()},c={algorithm:"HS256",issuer:a.issuer,audience:a.audience,expiresIn:`${a.expirationHours}h`},l=i().sign(s,a.secretKey,c);return t=s.jti,n=e.id.toString(),o=36e5*a.expirationHours,r().set(t,{userId:n,expiresAt:Date.now()+o}),l}function m(e){try{var t;let n=h(),o={algorithms:["HS256"],issuer:n.issuer,audience:n.audience},c=i().verify(e,n.secretKey,o);if((t=c.jti)&&(++s>=100&&(s=0,function(){let e=r(),t=a(),n=Date.now(),o=[];e.forEach((e,t)=>{e.expiresAt<=n&&o.push(t)}),o.forEach(n=>{e.delete(n),t.delete(n)})}()),a().has(t)))return null;return c}catch(e){return e instanceof Error&&e.message.includes("JWT_SECRET_KEY")&&console.error("[Auth] JWT_SECRET_KEY not configured — cannot verify tokens"),null}}function p(e){if(!e)return null;let t=e.split(" ");return 2!==t.length||"bearer"!==t[0].toLowerCase()?null:t[1]}},53288:(e,t,n)=>{n.d(t,{vj:()=>r,xM:()=>i});var o=n(82009);async function i(e){return o.default.hash(e,10)}async function r(e,t){try{return await o.default.compare(e,t)}catch{return!1}}},53544:(e,t,n)=>{n.d(t,{_B:()=>a,cY:()=>c,lF:()=>s});var o=n(53524);let i=globalThis,r=i.prisma??new o.PrismaClient({log:["error"]});i.prisma||(r.$queryRawUnsafe("PRAGMA journal_mode=WAL").catch(e=>console.warn("[DB] WAL mode failed:",e)),r.$queryRawUnsafe("PRAGMA busy_timeout=5000").catch(e=>console.warn("[DB] busy_timeout failed:",e)));let a=r,s={RESULT_PASSED:"Passed",RESULT_FAILED:"Failed"};function c(e){let t=e.name??"";return{...e,isOutput:t.includes(":O.")||t.includes(":SO.")||t.includes(".O.")||t.includes(":O:")||t.includes(".Outputs.")||t.endsWith(".DO"),hasResult:!!e.result,isPassed:e.result===s.RESULT_PASSED,isFailed:e.result===s.RESULT_FAILED}}},41579:(e,t,n)=>{n.d(t,{_:()=>o._B});var o=n(53544)}};var t=require("../../../../webpack-runtime.js");t.C(e);var n=e=>t(t.s=e),o=t.X(0,[1111,9965,5760,2009],()=>n(16816));module.exports=o})();