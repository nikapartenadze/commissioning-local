import {open,close,load,DataType} from 'ffi-rs'
const DLL='C:/Users/nika.fartenadze.LCIBATUMI/Desktop/Work/commissioning/commissioning-local/frontend/plctag.dll'
open({library:'plctag',path:DLL})
const L=(f,r,pt,pv)=>load({library:'plctag',funcName:f,retType:r,paramsType:pt,paramsValue:pv})
const cr=(a)=>L('plc_tag_create',DataType.I32,[DataType.String,DataType.I32],[a,3000])
const rd=(h)=>L('plc_tag_read',DataType.I32,[DataType.I32,DataType.I32],[h,1500])
const wr=(h)=>L('plc_tag_write',DataType.I32,[DataType.I32,DataType.I32],[h,1500])
const gb=(h)=>L('plc_tag_get_bit',DataType.I32,[DataType.I32,DataType.I32],[h,0])
const sb=(h,v)=>L('plc_tag_set_int8',DataType.I32,[DataType.I32,DataType.I32,DataType.I32],[h,0,v])
const A=(n)=>`protocol=ab_eip&gateway=192.168.5.108&path=1,0&plc=controllogix&elem_size=1&elem_count=1&name=${n}`
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const D='UL21_2_VFD'; const H={}; const h=(n)=>H[n]||(H[n]=cr(A(n)))
const rb=(n)=>{rd(h(n));return gb(h(n))}
const wb=(n,v)=>{rd(h(n));sb(h(n),v);return wr(h(n))}
// keep zone scanning while we clear
wb('ZONE_01_01_Check_Finished',1); wb(`${D}:I.ConnectionFaulted`,0); await sleep(200)
// stop tracking: toggle F1 off (rising edge flips Track_Belt off)
wb(`${D}:I.KeypadButtonF1`,0); await sleep(250); wb(`${D}:I.KeypadButtonF1`,1); await sleep(400); wb(`${D}:I.KeypadButtonF1`,0)
// unlatch all validations
for(const f of ['Invalidate_Map','Invalidate_HP','Invalidate_Direction','Invalidate_Tracking_Finished','Normal_Polarity']) wb(`CBT_${D}.CTRL.CMD.${f}`,1)
await sleep(400)
// restore ConnectionFaulted=1 so Check_Allowed clears to 0 (as-found), while still scanning
wb(`${D}:I.ConnectionFaulted`,1); await sleep(400)
console.log('after-clear (scanning):',
 'Check_Allowed='+rb(`CBT_${D}.CTRL.STS.Check_Allowed`),
 'Valid_Map='+rb(`CBT_${D}.CTRL.STS.Valid_Map`),
 'Valid_HP='+rb(`CBT_${D}.CTRL.STS.Valid_HP`),
 'Valid_Direction='+rb(`CBT_${D}.CTRL.STS.Valid_Direction`),
 'Track_Belt='+rb(`CBT_${D}.CTRL.STS.Track_Belt`),
 'O.Start='+rb(`${D}:O.Start`))
// restore gate to as-found (0) — zone stops scanning, STS freezes at cleared 0s
wb('ZONE_01_01_Check_Finished',0); await sleep(200)
console.log('restored gate=',rb('ZONE_01_01_Check_Finished'),' ConnFaulted=',rb(`${D}:I.ConnectionFaulted`),' F1=',rb(`${D}:I.KeypadButtonF1`))
close('plctag')
