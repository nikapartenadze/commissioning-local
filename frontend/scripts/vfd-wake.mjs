import {open,close,load,DataType} from 'ffi-rs'
const DLL='C:/Users/nika.fartenadze.LCIBATUMI/Desktop/Work/commissioning/commissioning-local/frontend/plctag.dll'
open({library:'plctag',path:DLL})
const L=(f,r,pt,pv)=>load({library:'plctag',funcName:f,retType:r,paramsType:pt,paramsValue:pv})
const cr=(a)=>L('plc_tag_create',DataType.I32,[DataType.String,DataType.I32],[a,3000])
const rd=(h,t)=>L('plc_tag_read',DataType.I32,[DataType.I32,DataType.I32],[h,t])
const wr=(h,t)=>L('plc_tag_write',DataType.I32,[DataType.I32,DataType.I32],[h,t])
const gb=(h)=>L('plc_tag_get_bit',DataType.I32,[DataType.I32,DataType.I32],[h,0])
const sb=(h,v)=>L('plc_tag_set_int8',DataType.I32,[DataType.I32,DataType.I32,DataType.I32],[h,0,v])
const A=(n)=>`protocol=ab_eip&gateway=192.168.5.108&path=1,0&plc=controllogix&elem_size=1&elem_count=1&name=${n}`
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const D='UL21_2_VFD'
let hGate=cr(A('ZONE_01_01_Check_Finished'))
if(hGate<0){ hGate=cr(A('Program:MainProgram.ZONE_01_01_Check_Finished')); console.log('gate: using MainProgram scope, h=',hGate) } else console.log('gate: controller scope, h=',hGate)
const hCf =cr(A(`${D}:I.ConnectionFaulted`))
const hCmd=cr(A(`CBT_${D}.CTRL.CMD.Valid_Map`))
const hCa =cr(A(`CBT_${D}.CTRL.STS.Check_Allowed`))
const hVm =cr(A(`CBT_${D}.CTRL.STS.Valid_Map`))
const force=(h,v)=>{rd(h,1500);sb(h,v);return wr(h,1500)}
console.log('force ConnFaulted=0 ->',force(hCf,0))
console.log('force gate=1 ->',force(hGate,1))
console.log('write CMD.Valid_Map=1 ->',force(hCmd,1))
for(let i=0;i<6;i++){
  await sleep(250)
  force(hGate,1)            // hold the gate high each iteration
  rd(hGate,1500);rd(hCmd,1500);rd(hCa,1500);rd(hVm,1500)
  console.log('t+'+((i+1)*250)+'ms  gate='+gb(hGate)+'  CMD.Valid_Map='+gb(hCmd)+'  Check_Allowed='+gb(hCa)+'  STS.Valid_Map='+gb(hVm))
}
close('plctag')
