const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const profile=process.env.SHUTDOWN_REPRO_PROFILE;
if(!profile)throw Error('Synthetic profile required');
app.setPath('userData',profile);app.setPath('sessionData',profile);
for(const key of ['logs','crashDumps','userCache']){const p=path.join(profile,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}
app.enableSandbox();app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const s=session.fromPartition(process.env.SHUTDOWN_REPRO_PERSIST==='1'?'persist:synthetic-storage':'synthetic-storage');
 s.protocol.handle('https',()=>new Response('<!doctype html><title>Synthetic storage shutdown</title>',{headers:{'content-type':'text/html'}}));
 const w=new BrowserWindow({show:false,webPreferences:{session:s,sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await w.loadURL('https://storage.example.invalid/');
 for(let batch=0;batch<8;batch++){
  await w.webContents.executeJavaScript(`(()=>{const v='synthetic-'+${batch}+'x'.repeat(3000);for(let n=0;n<1000;n++){localStorage.setItem('key-'+n,v);sessionStorage.setItem('key-'+n,v);}return true;})()`);
  s.flushStorageData();
  await new Promise(resolve=>setTimeout(resolve,40));
 }
 fs.writeFileSync(path.join(profile,'synthetic-state.json'),JSON.stringify({storageWritten:true,authenticationApisCalled:false,quitRequested:true}));
 s.flushStorageData();w.destroy();setTimeout(()=>app.quit(),Number(process.env.SHUTDOWN_REPRO_DELAY||0));
}).catch(()=>app.exit(2));
