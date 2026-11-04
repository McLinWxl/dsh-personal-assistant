import {parentPort,workerData} from 'node:worker_threads';
import {backup} from 'node:sqlite';
import {mkdirSync,readdirSync,lstatSync,copyFileSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {Vault,atomicJson,canonicalDestination} from './files.js';
import {calendarOccurrences} from '../domain/calendar.js';
const store=new Store(workerData.root,workerData.options??{}),vault=new Vault(store.directory.root);
let queue=Promise.resolve();
function descendants(root:string){const files:string[]=[];function scan(dir:string){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('SYMLINK_NOT_EXPORTABLE');if(entry.isDirectory())scan(path);else if(entry.isFile())files.push(relative(root,path));}}scan(root);return files;}
async function exportData(destination:string){
  if(!isAbsolute(destination))throw new Error('ABSOLUTE_EXPORT_PATH_REQUIRED');
  const target=canonicalDestination(destination),rel=relative(store.directory.root,target);
  if(!rel||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)))throw new Error('EXPORT_MUST_BE_OUTSIDE_DATA_DIRECTORY');
  if(existsSync(target))throw new Error('EXPORT_DESTINATION_EXISTS');
  mkdirSync(target,{recursive:true,mode:0o700});
  try{
    await backup(store.db,join(target,'state.sqlite'));
    for(const path of descendants(store.directory.root)){
      const top=path.split(sep)[0];if(['runtime','cache','exports'].includes(top)||['state.sqlite','state.sqlite-wal','state.sqlite-shm','export.json'].includes(path))continue;
      const dest=join(target,path);mkdirSync(resolve(dest,'..'),{recursive:true,mode:0o700});copyFileSync(join(store.directory.root,path),dest);
    }
    const files=Object.fromEntries(descendants(target).map(path=>[path.split(sep).join('/'),createHash('sha256').update(readFileSync(join(target,path))).digest('hex')]));
    atomicJson(join(target,'export.json'),{format:'dsh-personal-assistant-export',schemaVersion:1,at:new Date().toISOString(),datasetId:store.owner(),files});
    return{destination:target,files:Object.keys(files).length};
  }catch(error){rmSync(target,{recursive:true,force:true});throw error;}
}
async function handle(method:string,a:any){
  switch(method){
    case'maintenanceStamp':{const value=String(store.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value)+':'+String(store.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n)+':'+Math.floor(store.now()/86400000);const old=store.db.prepare("SELECT value FROM settings WHERE key='maintenance-stamp'").get()?.value;return{value,changed:String(value)!==old||store.pendingSources(1).length>0||Number(store.db.prepare("SELECT value FROM settings WHERE key='maintenance-offset'").get()?.value??0)>0,offset:Number(store.db.prepare("SELECT value FROM settings WHERE key='maintenance-offset'").get()?.value??0)};}
    case'maintenanceProgress':{const total=store.rows('memory').length;store.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('maintenance-offset',String(a.offset>=total?0:a.offset));return{saved:true};}
    case'maintenanceDone':store.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('maintenance-stamp',String(a.stamp));return{saved:true};
    case'maintenanceApply':return store.command(a.requestId,{method,commands:a.commands,sourceId:a.sourceId??null},()=>{const allowed=new Set(['memoryCapture','memoryRefresh','memoryClassify','memoryPrune','consolidate','sourceReview','toolSave']);const refs=(item:any)=>item.command==='consolidate'?(item.payload.groups??[]).flatMap((g:any)=>g.memories):item.payload.id&&item.payload.revision!==undefined?[item.payload]:[];for(const item of a.commands){if(!allowed.has(item.command))throw new Error('MAINTENANCE_COMMAND_NOT_ALLOWED');for(const ref of refs(item))if(store.node(ref.id).revision!==ref.revision)throw new Error('STALE_VERSION');}const results=[];for(const [i,original]of a.commands.entries()){const item=structuredClone(original);for(const ref of refs(item))ref.revision=store.node(ref.id).revision;results.push(store.dispatch(item.command,item.payload,a.requestId+':'+i,{kind:'maintenance',sourceId:a.sourceId}));}return{results};});
    case'projectInspect':return store.projects.inspect(a.sourceId);
    case'projectPending':return store.projects.pending(a.limit,a.busy);
    case'projectRetry':return store.projects.retry(a.sourceId,a.error)??{resolved:true};
    case'projectPreview':return store.projects.preview(a);
    case'projectApply':{const {requestId,...input}=a;return store.command(requestId,{method,...input},()=>store.projects.apply(input));}
    case'command':return store.dispatch(a.command,a.payload,a.requestId,a.actor);
    case'health':return store.health();
    case'source':return store.addSource(a);
    case'sourceReady':store.db.prepare("UPDATE sources SET status='pending' WHERE session_id=? AND status='buffered'").run(a.sessionId);return{saved:true};
    case'sourceRecover':{const busy=new Set(a.busy??[]);for(const r of store.db.prepare("SELECT DISTINCT session_id FROM sources WHERE status='buffered'").all())if(!busy.has(r.session_id))store.db.prepare("UPDATE sources SET status='pending' WHERE session_id=? AND status='buffered'").run(r.session_id);return{saved:true};}
    case'pendingSources':return store.pendingSources(a.limit);
    case'purge':return store.purge();
    case'reminders':{const now=store.now(),saved=Number(store.db.prepare("SELECT value FROM settings WHERE key='reminder-cursor'").get()?.value??now-86400000),from=Math.max(saved,now-30*86400000);let count=0;for(const task of store.rows('task')){const due=Date.parse(task.data.dueAt);if(!['completed','cancelled'].includes(task.data.status)&&due<=now){store.notify('reminder.task',{title:task.data.title,id:task.id,at:due},'reminder:task:'+task.id+':'+due);count++;}}for(const event of calendarOccurrences(store.rows('event'),new Date(from).toISOString(),new Date(now+1).toISOString())){const day=new Intl.DateTimeFormat('en-CA',{timeZone:event.data.timezone}).format(now),at=event.data.allDay?Date.parse(event.occurrenceStart+'T00:00:00Z'):Date.parse(event.occurrenceStart);if(event.data.allDay?event.occurrenceStart<=day:at<=now){store.notify('reminder.event',{title:event.data.title,id:event.id,at},'reminder:event:'+event.id+':'+(event.occurrenceKey??event.occurrenceStart));count++;}}store.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('reminder-cursor',String(now));return{count};}
    case'export':return exportData(a.destination);
    case'vaultState':return{unlocked:vault.unlocked,configured:existsSync(vault.path)};
    case'vaultUnlock':return vault.unlock(a.passphrase);
    case'vaultLock':vault.lock();return{unlocked:false};
    case'vaultGet':return vault.get(a.name);
    case'vaultSet':vault.set(a.name,a.value);return{saved:true};
    case'chatRequestGet':{const row=store.db.prepare('SELECT * FROM chat_requests WHERE id=?').get(a.id);if(row&&row.fingerprint!==a.fingerprint)throw new Error('REQUEST_ID_REUSED');return row;}
    case'chatRequestSave':{const row=store.db.prepare('SELECT * FROM chat_requests WHERE id=?').get(a.id);if(row&&row.fingerprint!==a.fingerprint)throw new Error('REQUEST_ID_REUSED');store.db.prepare('INSERT OR IGNORE INTO chat_requests VALUES(?,?,?,?)').run(a.id,a.fingerprint,a.sessionId,store.now());return{saved:true};}
    case'conversationInvalidateNative':for(const row of store.db.prepare('SELECT session_id FROM conversations').all())store.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('native-expired:'+row.session_id,'true');return{saved:true};
    case'conversationNeedsRebind':return!!store.db.prepare('SELECT 1 FROM settings WHERE key=?').get('native-expired:'+a.sessionId);
    case'conversationRebind':return store.command('conversation-rebind:'+a.previous,{method,a},()=>{const old=store.db.prepare('SELECT * FROM conversations WHERE session_id=?').get(a.previous);if(!old)throw new Error('CONVERSATION_NOT_FOUND');store.db.prepare('DELETE FROM conversations WHERE session_id=?').run(a.sessionId);store.db.prepare('UPDATE conversations SET session_id=?,updated_at=? WHERE id=?').run(a.sessionId,store.now(),old.id);store.db.prepare('UPDATE sources SET session_id=? WHERE session_id=?').run(a.sessionId,a.previous);store.db.prepare('UPDATE chat_requests SET session_id=? WHERE session_id=?').run(a.sessionId,a.previous);store.db.prepare('DELETE FROM settings WHERE key=?').run('native-expired:'+a.previous);return{saved:true};});
    case'conversationList':return store.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 100').all();
    case'conversationSave':store.db.prepare('INSERT INTO conversations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,title=excluded.title,updated_at=excluded.updated_at').run(a.id,a.sessionId,a.title,store.now());return{saved:true};
    case'conversationMessages':return store.db.prepare("SELECT id,role,text,at,status FROM (SELECT * FROM sources WHERE session_id=? AND role IN ('user','assistant') ORDER BY at DESC,id DESC LIMIT 200) ORDER BY at,id").all(a.sessionId);
    case'jobScheduleNow':store.db.prepare("UPDATE jobs SET next_at=? WHERE id=? AND status='scheduled'").run(store.now(),a.id);return{scheduled:true};
    case'jobReschedule':store.db.prepare("UPDATE jobs SET next_at=? WHERE id=? AND status='scheduled' AND next_at>?").run(a.nextAt,a.id,store.now());return{scheduled:true};
    case'jobEnsure':store.db.prepare("INSERT OR IGNORE INTO jobs(id,kind,next_at,status,payload) VALUES(?,?,?,'scheduled',?)").run(a.id,a.kind,a.nextAt,JSON.stringify(a.payload??{}));return{saved:true};
    case'jobClaim':{if(!store.db.prepare("SELECT 1 FROM jobs WHERE (status='scheduled' AND next_at<=?) OR (status='running' AND lease_until<=?) LIMIT 1").get(store.now(),store.now()))return null;return store.command('job-claim:'+a.claimId,{method},()=>{
      const now=store.now();store.db.prepare("UPDATE jobs SET status='scheduled',lease_until=NULL WHERE status='running' AND lease_until<=?").run(now);
      const job=store.db.prepare("SELECT * FROM jobs WHERE status='scheduled' AND next_at<=? ORDER BY next_at,id LIMIT 1").get(now);if(!job)return null;
      const runId=randomUUID();store.db.prepare("UPDATE jobs SET status='running',lease_until=?,run_id=?,attempts=attempts+1 WHERE id=?").run(now+a.leaseMs,runId,job.id);
      return{...job,payload:JSON.parse(job.payload),runId};
    });}
    case'jobFinish':{const result=store.db.prepare("UPDATE jobs SET status='scheduled',next_at=?,lease_until=NULL,last_error=? WHERE id=? AND run_id=? AND status='running'").run(a.nextAt,a.error??null,a.id,a.runId);return{saved:result.changes===1};}
    case'jobList':return store.db.prepare('SELECT id,kind,next_at,status,lease_until,run_id,attempts,last_error FROM jobs ORDER BY id').all();
    case'notify':return{id:store.notify(a.type,a.payload,a.id)};
    case'outbox':return store.db.prepare('SELECT o.*,n.created_at FROM outbox o LEFT JOIN notifications n ON n.id=o.id ORDER BY n.created_at,o.id LIMIT 40').all().map((r:any)=>({...r,payload:JSON.parse(r.payload)}));
    case'outboxAck':store.db.prepare('DELETE FROM outbox WHERE id=?').run(a.id);return{saved:true};
    case'channelCursor':return store.db.prepare("SELECT value FROM settings WHERE key='weixin-cursor'").get()?.value??'';
    case'channelContext':{const row=store.db.prepare("SELECT payload FROM channel_messages WHERE direction='in' ORDER BY created_at DESC LIMIT 1").get();return row?JSON.parse(store.codec.open(row.payload)):null;}
    case'channelReset':store.db.exec("DELETE FROM channel_messages; DELETE FROM settings WHERE key='weixin-cursor';");return{reset:true};
    case'channelRecover':{const rows=store.db.prepare("SELECT id FROM channel_messages WHERE status IN ('processing','sending')").all();for(const r of rows)store.notify('weixin.delivery-unknown',{messageId:r.id},'recovery:'+r.id);store.db.exec("UPDATE channel_messages SET status='unknown' WHERE status IN ('processing','sending')");return{recovered:rows.length};}
    case'channelReceive':return store.command('receive:'+randomUUID(),{method},()=>{for(const message of a.messages){const id=a.generation+':'+message.message_id;store.db.prepare('INSERT OR IGNORE INTO channel_messages VALUES(?,?,?,?,?,0)').run(id,'in','received',store.codec.seal(JSON.stringify({generation:a.generation,message})),store.now());}if(a.cursor)store.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('weixin-cursor',a.cursor);return{saved:true};});
    case'channelGet':{const r=store.db.prepare('SELECT * FROM channel_messages WHERE id=?').get(a.id);return r?{...r,payload:JSON.parse(store.codec.open(r.payload))}:null;}
    case'channelPut':store.db.prepare('INSERT OR IGNORE INTO channel_messages VALUES(?,?,?,?,?,0)').run(a.id,a.direction,a.status,store.codec.seal(JSON.stringify(a.payload)),store.now());return{saved:true};
    case'channelUpdate':store.db.prepare('UPDATE channel_messages SET status=?,attempts=attempts+1 WHERE id=?').run(a.status,a.id);return{saved:true};
    case'channelPending':return store.db.prepare("SELECT * FROM channel_messages WHERE status IN ('received','queued') ORDER BY created_at LIMIT 20").all().map((r:any)=>({...r,payload:JSON.parse(store.codec.open(r.payload))}));
    case'runGet':return store.db.prepare('SELECT * FROM runs WHERE id=?').get(a.id);
    case'runRecover':{const rows=store.db.prepare("SELECT * FROM runs WHERE status IN ('queued','running')").all();for(const run of rows){if(run.task_id){const task=store.node(run.task_id,'task');store.put('nodes',task.id,'task',{...task.data,status:'needs-review'});}store.notify('task.unknown',{runId:run.id,taskId:run.task_id},'run:'+run.id+':unknown');}store.db.exec("UPDATE runs SET status='unknown' WHERE status IN ('queued','running')");return{recovered:rows.length};}
    case'runCreate':return store.command(a.requestId,{method,taskId:a.taskId??null,workflowVersion:a.workflowVersion??null},()=>{
      const id=randomUUID();if(a.taskId){const task=store.node(a.taskId,'task');for(const dependency of task.data.dependsOn)if(store.node(dependency,'task').data.status!=='completed')throw new Error('TASK_DEPENDENCY_NOT_COMPLETED');store.put('nodes',task.id,'task',{...task.data,status:'running'});}
      store.db.prepare('INSERT INTO runs VALUES(?,?,NULL,?,?,?,?,NULL,?)').run(id,a.taskId??null,a.requestId,'queued',store.now(),store.now(),a.workflowVersion??null);return{id};
    });
    case'runUpdate':{const run=store.db.prepare('SELECT * FROM runs WHERE id=?').get(a.id);if(!run)throw new Error('RUN_NOT_FOUND');
      store.command('run-update:'+a.id+':'+a.status,{method,a},()=>{store.db.prepare('UPDATE runs SET session_id=COALESCE(?,session_id),status=?,updated_at=?,result=? WHERE id=?').run(a.sessionId??null,a.status,store.now(),a.result??null,a.id);
        if(run.task_id){const task=store.node(run.task_id,'task');const status=a.status==='succeeded'?'needs-review':a.status==='failed'?'failed':'running';store.put('nodes',task.id,'task',{...task.data,status,result:a.result??task.data.result});}
        if(['succeeded','failed','unknown'].includes(a.status))store.notify('task.'+a.status,{runId:a.id,taskId:run.task_id},'run:'+a.id+':'+a.status);return{saved:true};});return{saved:true};}
    case'runList':return store.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT 100').all().map((r:any)=>({...r,title:r.task_id?store.get('nodes',r.task_id)?.data.title??'任务执行':r.workflow_version?JSON.parse(String(store.db.prepare('SELECT definition FROM tool_versions WHERE id=? LIMIT 1').get(r.workflow_version)?.definition??'{}')).title??'工具执行':'工具执行'}));
    case'toolDefinition':{const tool=store.node(a.id,'tool');const version=a.version??tool.data.activeVersion;if(!version)throw new Error('TOOL_NOT_ACTIVE');if(version!==tool.data.activeVersion&&!store.db.prepare("SELECT 1 FROM runs WHERE session_id=? AND workflow_version=? AND status='running'").get(a.sessionId??'',version))throw new Error('TOOL_VERSION_NOT_APPROVED');const row=store.db.prepare('SELECT definition FROM tool_versions WHERE id=? AND tool_id=?').get(version,a.id);if(!row)throw new Error('TOOL_VERSION_NOT_FOUND');return{id:a.id,version,definition:JSON.parse(row.definition)};}
    case'toolUsage':store.db.prepare('INSERT OR IGNORE INTO tool_usage VALUES(?,?,?,?,?)').run(a.id,a.toolId,a.version,store.now(),a.outcome);return{saved:true};
    case'workflowResult':return store.db.prepare('SELECT outcome FROM tool_usage WHERE id LIKE ? AND tool_id=? AND version=? ORDER BY at DESC LIMIT 1').get(a.sessionId+':%',a.toolId,a.version)??null;
    case'toolReview':return store.db.prepare('SELECT tool_id,COUNT(*) AS executions,SUM(CASE WHEN outcome=\'failed\' THEN 1 ELSE 0 END) AS failures FROM tool_usage WHERE at>? GROUP BY tool_id').all(store.now()-7*86400000);
    case'close':vault.lock();store.close();return{closed:true};
    default:throw new Error('UNKNOWN_STORAGE_OPERATION');
  }
}
parentPort!.on('message',message=>{queue=queue.then(async()=>{try{const result=await handle(message.method,message.args??{});parentPort!.postMessage({id:message.id,result});if(message.method==='close')parentPort!.close();}catch(e:any){parentPort!.postMessage({id:message.id,error:{message:e.message,code:e.code??e.message,details:e.issues??null}});}});});
parentPort!.postMessage({ready:true});
