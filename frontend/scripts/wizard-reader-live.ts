process.env.WS_BROADCAST_URL = 'http://127.0.0.1:39555/broadcast'
import http from 'http'
import { initLibrary, createTag, plc_tag_read, plc_tag_set_int8, plc_tag_write, plc_tag_destroy } from '@/lib/plc'
import { openWizardReader, closeWizardReader } from '@/lib/vfd-wizard-reader'

const GW='192.168.5.108', PATH='1,0', D='UL21_2_VFD'
const got:any[]=[]

async function main(){
  const srv=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{got.push(JSON.parse(b))}catch{}; res.end('ok')})})
  await new Promise<void>(r=>srv.listen(39555,()=>r()))
  initLibrary()
  const force=(name:string,v:number)=>{const h=createTag({gateway:GW,path:PATH,name,elemSize:1,elemCount:1,timeout:3000});if(h<0)return h;plc_tag_read(h,1500);plc_tag_set_int8(h,0,v);const w=plc_tag_write(h,1500);plc_tag_destroy(h);return w}
  console.log('force gate=',force('ZONE_01_01_Check_Finished',1),' connfaulted0=',force(`${D}:I.ConnectionFaulted`,0))
  const r=await openWizardReader(D,GW,PATH)
  console.log('openWizardReader ->',JSON.stringify(r))
  await new Promise(res=>setTimeout(res,1500))
  const before=got.filter(m=>m.type==='VfdTagUpdate').slice(-1)[0]
  console.log('READER sees (online check):', JSON.stringify(before?.sts))
  console.log('write CMD.Valid_Map=1 ->',force(`CBT_${D}.CTRL.CMD.Valid_Map`,1))
  await new Promise(res=>setTimeout(res,1300))
  const after=got.filter(m=>m.type==='VfdTagUpdate').slice(-1)[0]
  console.log('READER sees (after identity write):', JSON.stringify(after?.sts))
  closeWizardReader(D,GW,PATH)
  // cleanup back to as-found
  force(`CBT_${D}.CTRL.CMD.Invalidate_Map`,1); await new Promise(res=>setTimeout(res,300))
  force(`${D}:I.ConnectionFaulted`,1); force('ZONE_01_01_Check_Finished',0)
  srv.close(); process.exit(0)
}
main().catch(e=>{console.error('ERR',e); process.exit(1)})
