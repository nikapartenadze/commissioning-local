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
function rbit(n){const h=cr(A(n));if(h<0)return`cr${h}`;const s=rd(h);if(s!==0){de(h);return`rd${s}`}const b=gb(h);de(h);return b}
function wbit(n,v){const h=cr(A(n));if(h<0)return`cr${h}`;rd(h);const ss=sb(h,v);const ws=wr(h);de(h);return`set=${ss} write=${ws}`}
const D='UL21_2_VFD'
console.log('BEFORE  ConnFaulted=',rbit(`${D}:I.ConnectionFaulted`),' F1=',rbit(`${D}:I.KeypadButtonF1`))
console.log('W ConnFaulted=0:',wbit(`${D}:I.ConnectionFaulted`,0))
console.log('W F1=1        :',wbit(`${D}:I.KeypadButtonF1`,1))
console.log('W CMD.Valid_Map=1:',wbit(`CBT_${D}.CTRL.CMD.Valid_Map`,1))
await new Promise(r=>setTimeout(r,400))
console.log('AFTER   ConnFaulted=',rbit(`${D}:I.ConnectionFaulted`),' F1=',rbit(`${D}:I.KeypadButtonF1`),' Check_Allowed=',rbit(`CBT_${D}.CTRL.STS.Check_Allowed`),' STS.Valid_Map=',rbit(`CBT_${D}.CTRL.STS.Valid_Map`),' CMD.Valid_Map(post-FLL)=',rbit(`CBT_${D}.CTRL.CMD.Valid_Map`))
close('plctag')
