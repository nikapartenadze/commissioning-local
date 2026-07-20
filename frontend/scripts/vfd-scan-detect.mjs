import {open,close,load,DataType} from 'ffi-rs'
const DLL='C:/Users/nika.fartenadze.LCIBATUMI/Desktop/Work/commissioning/commissioning-local/frontend/plctag.dll'
open({library:'plctag',path:DLL})
const L=(f,r,pt,pv)=>load({library:'plctag',funcName:f,retType:r,paramsType:pt,paramsValue:pv})
const cr=(a)=>L('plc_tag_create',DataType.I32,[DataType.String,DataType.I32],[a,5000])
const rd=(h)=>L('plc_tag_read',DataType.I32,[DataType.I32,DataType.I32],[h,5000])
const wr=(h)=>L('plc_tag_write',DataType.I32,[DataType.I32,DataType.I32],[h,5000])
const gb=(h)=>L('plc_tag_get_bit',DataType.I32,[DataType.I32,DataType.I32],[h,0])
const sb=(h,v)=>L('plc_tag_set_int8',DataType.I32,[DataType.I32,DataType.I32,DataType.I32],[h,0,v])
const de=(h)=>L('plc_tag_destroy',DataType.I32,[DataType.I32],[h])
const A=(n)=>`protocol=ab_eip&gateway=192.168.5.108&path=1,0&plc=controllogix&elem_size=1&elem_count=1&name=${n}`
function rbit(n){const h=cr(A(n));if(h<0)return -100;const s=rd(h);if(s!==0){de(h);return -200}const b=gb(h);de(h);return b}
function wbit(n,v){const h=cr(A(n));if(h<0)return`cr${h}`;rd(h);sb(h,v);const ws=wr(h);de(h);return ws}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const devs=['UL21_2_VFD','UL21_3_VFD','UL21_4_VFD','UL21_5_VFD','UL21_6_VFD','UL21_7_VFD']
for(const D of devs){
  wbit(`${D}:I.ConnectionFaulted`,0)
  wbit(`CBT_${D}.CTRL.CMD.Valid_Map`,1)
  let cleared=-1, online=-1
  for(let i=0;i<6;i++){
    await sleep(200)
    const cmd=rbit(`CBT_${D}.CTRL.CMD.Valid_Map`)
    const ca=rbit(`CBT_${D}.CTRL.STS.Check_Allowed`)
    if(cleared<0 && cmd===0) cleared=i
    if(online<0 && ca===1) online=i
  }
  console.log(D.padEnd(13),'CMD.Valid_Map cleared@'+String(cleared).padStart(2),' Check_Allowed set@'+String(online).padStart(2),'  =>',cleared>=0?'AOI SCANNING':'NOT SCANNING')
}
close('plctag')
