import {open,close,load,DataType} from 'ffi-rs'
const DLL='C:/Users/nika.fartenadze.LCIBATUMI/Desktop/Work/commissioning/commissioning-local/frontend/plctag.dll'
open({library:'plctag',path:DLL})
const L=(f,r,pt,pv)=>load({library:'plctag',funcName:f,retType:r,paramsType:pt,paramsValue:pv})
const cr=(a)=>L('plc_tag_create',DataType.I32,[DataType.String,DataType.I32],[a,3000])
const rd=(h)=>L('plc_tag_read',DataType.I32,[DataType.I32,DataType.I32],[h,1500])
const wr=(h)=>L('plc_tag_write',DataType.I32,[DataType.I32,DataType.I32],[h,1500])
const gb=(h)=>L('plc_tag_get_bit',DataType.I32,[DataType.I32,DataType.I32],[h,0])
const sb=(h,v)=>L('plc_tag_set_int8',DataType.I32,[DataType.I32,DataType.I32,DataType.I32],[h,0,v])
const gu=(h)=>L('plc_tag_get_uint32',DataType.U32,[DataType.I32,DataType.I32],[h,0])
const s32=(h,v)=>L('plc_tag_set_int32',DataType.I32,[DataType.I32,DataType.I32,DataType.I32],[h,0,v])
const A=(n,e=1)=>`protocol=ab_eip&gateway=192.168.5.108&path=1,0&plc=controllogix&elem_size=${e}&elem_count=1&name=${n}`
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const D='UL21_2_VFD'
const H={} // handle cache
const h=(n,e=1)=>{const k=n+'|'+e; if(!H[k])H[k]=cr(A(n,e)); return H[k]}
const rbit=(n)=>{const x=h(n);rd(x);return gb(x)}
const rreal=(n)=>{const x=h(n,4);rd(x);const b=Buffer.alloc(4);b.writeUInt32LE(gu(x)>>>0,0);return Math.round(b.readFloatLE(0)*100)/100}
const wbit=(n,v)=>{const x=h(n);rd(x);sb(x,v);return wr(x)}
const wdint=(n,v)=>{const x=h(n,4);rd(x);s32(x,v);return wr(x)}
const hold=()=>{wbit(`ZONE_01_01_Check_Finished`,1);wbit(`${D}:I.ConnectionFaulted`,0);wbit(`${D}:I.SafeTorqueEnabled`,1);wbit(`${D}:I.KeypadHandMode`,0)}
const R=[]
const chk=(step,expr,got,exp)=>{const p=(got==exp);R.push({step,expr,exp,got,p});console.log((p?'PASS':'FAIL').padEnd(5),step.padEnd(26),expr+' = '+got+' (exp '+exp+')')}

hold(); await sleep(300)
// Step 0 — Online
chk('0 Online','STS.Check_Allowed',rbit(`CBT_${D}.CTRL.STS.Check_Allowed`),1)
// Step 1 — Identity
wbit(`CBT_${D}.CTRL.CMD.Valid_Map`,1); await sleep(300); hold()
chk('1 Identity','STS.Valid_Map',rbit(`CBT_${D}.CTRL.STS.Valid_Map`),1)
chk('1 Identity','CMD.Valid_Map(FLL cleared)',rbit(`CBT_${D}.CTRL.CMD.Valid_Map`),0)
// Step 2 — HP
wbit(`CBT_${D}.CTRL.CMD.Valid_HP`,1); await sleep(300); hold()
chk('2 Horsepower','STS.Valid_HP',rbit(`CBT_${D}.CTRL.STS.Valid_HP`),1)
// Gate — Tracking_Finished (mech tracked on cloud)
wbit(`CBT_${D}.CTRL.CMD.Tracking_Finished`,1); await sleep(300); hold()
// Step 4 — Direction (needs Tracking_Finished) + Normal polarity
wbit(`CBT_${D}.CTRL.CMD.Valid_Direction`,1)
wbit(`CBT_${D}.CTRL.CMD.Normal_Polarity`,1); await sleep(300); hold()
chk('4 Direction','STS.Valid_Direction',rbit(`CBT_${D}.CTRL.STS.Valid_Direction`),1)
chk('4 Polarity(Normal)','O.DirectionCmd_0',rbit(`${D}:O.DirectionCmd_0`),1)
chk('4 Polarity(Normal)','O.DirectionCmd_1',rbit(`${D}:O.DirectionCmd_1`),0)
// Step 3/Bump equiv — Track via F1 (rising edge) + STO; Start after 5s Track_Start_TMR
wbit(`${D}:I.KeypadButtonF1`,0); await sleep(200); hold()
wbit(`${D}:I.KeypadButtonF1`,1); await sleep(400); hold()
chk('Track (F1)','STS.Track_Belt',rbit(`CBT_${D}.CTRL.STS.Track_Belt`),1)
console.log('...waiting 5.5s for Track_Start_TMR (Start output)')
for(let i=0;i<7;i++){await sleep(800);hold()}
chk('Track (F1)','O.Start (after 5s timer)',rbit(`${D}:O.Start`),1)
// Step 5 — Speed setpoint 30 RVS
wbit(`CBT_${D}.CTRL.CMD.Run_At_30_RVS`,1); await sleep(400); hold()
chk('5 Speed setpoint','O.CommandedVelocity',rreal(`${D}:O.CommandedVelocity`),30)
chk('5 Speed setpoint','STS.RVS (mirror)',rreal(`CBT_${D}.CTRL.STS.RVS`),30)
// Step 5 — HMI DINT speed write/read-back (the vfd-speed-dint-encoding path)
wdint(`${D}.HMI.Speed_At_30rev`,318); await sleep(250)
{const x=h(`${D}.HMI.Speed_At_30rev`,4);rd(x);const v=gu(x)>>>0;chk('5 HMI speed DINT','HMI.Speed_At_30rev',v,318)}

const pass=R.filter(r=>r.p).length
console.log('\n==== '+pass+'/'+R.length+' checks PASSED ====')
close('plctag')
