const path=require('path'),Module=require('module')
const nm=path.join(__dirname,'frontend','node_modules');Module.globalPaths.push(nm)
const Database=require(path.join(nm,'better-sqlite3'))
const db=new Database(path.join(__dirname,'mcm03','database.db'),{readonly:true})
const rows=db.prepare(`
 SELECT d.DeviceName dev,
  (SELECT Value FROM L2CellValues WHERE DeviceId=d.id AND ColumnId=969) cd,
  (SELECT Value FROM L2CellValues WHERE DeviceId=d.id AND ColumnId=970) pol
 FROM L2Devices d WHERE d.SheetId=294 ORDER BY d.DeviceName`).all()
const needPol=rows.filter(r=>!r.pol && !/fail/i.test(r.cd||''))
const fails=rows.filter(r=>/fail/i.test(r.cd||''))
console.log('NEED POLARITY RE-CHECK ('+needPol.length+'):')
console.log(needPol.map(r=>r.dev).join(', '))
console.log('\nFAILED DIRECTION — separate issue ('+fails.length+'):')
console.log(fails.map(r=>r.dev).join(', '))
db.close()
