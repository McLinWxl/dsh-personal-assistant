// Isolated DSH profile: no production data, account credentials or plugin sync.
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const runtime=process.env.DSH_TEST_RUNTIME??'/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh';
const require=createRequire(join(runtime,'package.json')),YAML=require('yaml');
const home=fs.mkdtempSync(join(tmpdir(),'dsh-v2-browser-'));
process.env.DSH_HOME=home;process.env.DSH_TELEMETRY_DISABLED='1';
const repository=resolve(fileURLToPath(new URL('../',import.meta.url))),profile='v2-browser';
const plugin=join(repository,'plugins/dsh-personal-assistant'),root=join(home,'assistant-data');
const {loadLayeredEnv}=await import(join(runtime,'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'));
const {initializeProfileFromDefault,runProfile}=await import(join(runtime,'node_modules/@deepseek-ai/dsh/lib/profile-boot.js'));
initializeProfileFromDefault(profile,'web',home);
const profileDir=join(home,'profiles',profile),manifest=join(profileDir,'package.json');
const pkg=JSON.parse(fs.readFileSync(manifest));pkg.dependencies['dsh-personal-assistant']='file:'+plugin;pkg.dsh.profile.bundles.push('dsh-personal-assistant');
fs.writeFileSync(manifest,JSON.stringify(pkg));fs.mkdirSync(join(profileDir,'node_modules'),{recursive:true});fs.symlinkSync(plugin,join(profileDir,'node_modules/dsh-personal-assistant'));
fs.writeFileSync(join(profileDir,'cordis.patch.yml'),YAML.stringify([{id:'personal-assistant',config:{dataRoot:root}}]));
let app;
try{
 app=await runProfile({environment:loadLayeredEnv('dsh'),profile,patchFiles:[],args:['--no-open','--host','127.0.0.1','--port','0']});
 const service=app.ctx.personalAssistant;if(!service||service.root!==root)throw new Error('ISOLATED_PLUGIN_REQUIRED');
 await service.command('settingsSave',{maintenanceEnabled:false,reportEnabled:false});
 for(const job of await service.storage.call('jobList'))await service.storage.call('jobReschedule',{id:job.id,nextAt:Date.now()+86400000});
 const call=(command,payload={})=>service.command(command,payload,{kind:'ui'});
 const a=await call('projectCreate',{title:'社区活动',key:'community',statement:'筹备年度活动',context:{year:2026}});
 const b=await call('projectCreate',{title:'家庭计划',key:'family'});
 const c=await call('projectCreate',{title:'报名系统',key:'registration',parent:{id:a.id,revision:a.revision}});
 await call('projectCreate',{title:'签到模块',key:'check-in',parent:{id:c.id,revision:c.revision}});
 await call('projectCreate',{title:'活动筹备',key:'activity',context:{year:2026}});
 await call('taskCreate',{title:'准备名单',projectId:a.id});
 await call('capabilityGapReport',{kind:'reported',target:'批量安排',context:'尚缺少批量日程安排命令。'});
 const end=Date.now();const window=await call('reportWindow',{from:end-60000});await call('reportSave',{from:window.from,to:window.to,summary:window.summary,items:window.items,body:'项目已创建，准备名单待完成。'});
 const {ctx}=app;
 const url=ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`);
 fs.writeFileSync('/tmp/dsh-v2-browser.json',JSON.stringify({url,home,root,pid:process.pid}));
 console.log('V2_BROWSER_READY '+url);
 await new Promise(done=>{process.once('SIGINT',done);process.once('SIGTERM',done);});
}finally{
 if(app)await app.ctx.fiber.dispose();
 fs.rmSync(home,{recursive:true,force:true});
}
