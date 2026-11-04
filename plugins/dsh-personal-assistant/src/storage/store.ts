import { randomUUID,createHash } from 'node:crypto';
import { writeFileSync,readFileSync,mkdirSync,existsSync,renameSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore,digest,tokens } from './memory-base.mjs';
import { openDirectory,inside,atomicJson } from './files.js';
import { defaults,settingsSchema,validate,formattedDeadline,type Actor,type Settings } from '../domain/contracts.js';
import { validateEvent,importCalendar,exportCalendar,calendarOccurrences,calendarIdentity,overrideOccurrence } from '../domain/calendar.js';
const Base:any=MemoryStore;
const fail=(code:string):never=>{throw new Error(code);};
const clone=<T>(v:T):T=>structuredClone(v);

export class Store extends Base {
  directory:ReturnType<typeof openDirectory>;
  settings:Settings;
  constructor(path:string,options:any={}) {
    const directory=openDirectory(path);
    try {super(directory.root,{...options,codec:directory.codec});}catch(e){directory.release();throw e;}
    this.directory=directory;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL,status TEXT NOT NULL,project_id TEXT);
      CREATE INDEX IF NOT EXISTS source_retention ON sources(status,at);
      CREATE TABLE IF NOT EXISTS source_context(id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,workspace TEXT NOT NULL,preset TEXT NOT NULL,origin TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,type TEXT NOT NULL,created_at INTEGER NOT NULL,read_at INTEGER,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,next_at INTEGER NOT NULL,status TEXT NOT NULL,lease_until INTEGER,run_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,payload TEXT NOT NULL,last_error TEXT);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task_id TEXT,session_id TEXT,request_id TEXT UNIQUE NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,result TEXT,workflow_version TEXT);
      CREATE TABLE IF NOT EXISTS tool_versions(id TEXT NOT NULL,tool_id TEXT NOT NULL,definition TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(id,tool_id));
      CREATE TABLE IF NOT EXISTS tool_usage(id TEXT PRIMARY KEY,tool_id TEXT NOT NULL,version TEXT NOT NULL,at INTEGER NOT NULL,outcome TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,session_id TEXT UNIQUE,title TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_requests(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,session_id TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_messages(id TEXT PRIMARY KEY,direction TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS node_kind ON nodes(kind);
      PRAGMA user_version=1;
    `);
    const saved=this.db.prepare("SELECT value FROM settings WHERE key='preferences'").get();
    this.settings=settingsSchema.parse({...defaults,...saved?JSON.parse(saved.value):{},...options.settings});
    this.retentionMs=this.settings.retentionHours*3600000;
    this.purge();
  }
  close(){try{super.close();}finally{this.directory.release();}}
  owner(){return this.directory.manifest.datasetId;}
  node(id:string,kind?:string){const row=this.get('nodes',id);if(!row||row.data.owner!==this.owner()||(kind&&row.kind!==kind))fail('OBJECT_NOT_FOUND');if(row.kind==='task')row.data=this.taskData(row.data);return row;}
  rows(kind?:string){return this.db.prepare('SELECT id FROM nodes'+(kind?' WHERE kind=?':'')+' ORDER BY id').all(...(kind?[kind]:[])).map((r:any)=>this.node(r.id));}
  notify(type:string,payload:any,id:string=randomUUID()){
    const now=this.now(),inserted=this.db.prepare('INSERT OR IGNORE INTO notifications VALUES(?,?,?,NULL,?)').run(id,type,now,JSON.stringify(payload));
    if(inserted.changes)this.db.prepare('INSERT OR IGNORE INTO outbox VALUES(?,?,?)').run(id,type,JSON.stringify(payload));return id;
  }
  journal(type:string,mutations:any[]){
    const id=randomUUID(),now=this.now(),expires=now+this.retentionMs;
    const bytes=Number(this.db.prepare('SELECT COALESCE(SUM(LENGTH(before_json)+COALESCE(LENGTH(after_json),0)),0) AS bytes FROM deltas').get().bytes);
    if(bytes+Buffer.byteLength(JSON.stringify(mutations))>this.settings.rollbackMegabytes*1024*1024)fail('ROLLBACK_STORAGE_FULL');
    this.db.prepare('INSERT INTO changes(id,created_at,expires_at,status,summary) VALUES(?,?,?,?,?)').run(id,now,expires,'applied',JSON.stringify({type,changedObjects:mutations.length,pairs:[]}));
    for(const [position,m]of mutations.entries()){
      const before=m.before??null;const after=this.put(m.table??'nodes',m.id,before?.kind??m.kind,m.data,m.touched??[]);
      this.db.prepare('INSERT INTO deltas VALUES(?,?,?,?,?,?,?)').run(id,position,m.table??'nodes',m.id,this.codec.seal(JSON.stringify(before)),after.record?this.codec.seal(JSON.stringify(after.record)):null,after.revision);
    }
    this.notify(type,{changeId:id,changedObjects:mutations.length,expiresAt:expires},id);
    return{changeId:id,expiresAt:expires,expiresDisplay:formattedDeadline(expires,this.settings.timezone)};
  }
  addSource(input:{id:string;sessionId:string;role:string;text:string;at?:number;projectId?:string;status?:string;context?:{workspace:string;preset:string;origin:string}}){
    if(!input.id||!input.sessionId||!['user','assistant','tool'].includes(input.role)||input.text.length>200000)fail('INVALID_SOURCE');
    const existing=this.db.prepare('SELECT text FROM sources WHERE id=?').get(input.id);
    if(existing){if(existing.text!==input.text)fail('SOURCE_ID_REUSED');return{id:input.id};}
    this.db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)').run(input.id,input.sessionId,input.role,input.text,input.at??this.now(),input.status??'pending',input.projectId??null);if(input.context)this.db.prepare('INSERT OR IGNORE INTO source_context VALUES(?,?,?,?)').run(input.id,input.context.workspace,input.context.preset,input.context.origin);return{id:input.id};
  }
  dispatch(command:string,input:unknown,key:string,actor:Actor){
    const a:any=validate(command,input);const reads=new Set(['overview','list','get','settingsGet','memorySearch','related','relations','calendar','icsExport','changes','change','inbox','toolVersions']);
    const result=reads.has(command)?this.execute(command,a,key,actor):this.command(key,{command,a,actor:actor.kind},()=>this.execute(command,a,key+':body',actor));
    if(command==='settingsSave'){this.settings=settingsSchema.parse(JSON.parse(this.db.prepare("SELECT value FROM settings WHERE key='preferences'").get().value));this.retentionMs=this.settings.retentionHours*3600000;}return result;
  }
  execute(command:string,a:any,key:string,actor:Actor){
    const uiOnly=['settingsSave','remove','toolActivate','inboxRead','allowMerge'];
    if(uiOnly.includes(command)&&actor.kind!=='ui'&&actor.kind!=='system')fail('OWNER_ACTION_REQUIRED');
    switch(command){
      case'overview':return{counts:Object.fromEntries(this.db.prepare('SELECT kind,COUNT(*) AS n FROM nodes GROUP BY kind').all().map((r:any)=>[r.kind,r.n])),unread:Number(this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').get().n),dataRoot:this.directory.root,settings:this.settings};
      case'list':return this.list(a);
      case'get':return this.node(a.id);
      case'relations':this.node(a.id);return this.all('edges').filter((e:any)=>e.data.from===a.id||e.data.to===a.id).map((e:any)=>({id:e.id,kind:e.data.kind,direction:e.data.from===a.id?'out':'in',object:this.node(e.data.from===a.id?e.data.to:e.data.from)}));
      case'settingsGet':return this.settings;
      case'settingsSave':return this.command(key,{command,a},()=>{const next=settingsSchema.parse({...this.settings,...a});this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('preferences',JSON.stringify(next));return{saved:true};});
      case'projectCreate':return this.create('project',a,key);
      case'projectEdit':return this.edit(a.id,'project',a.patch,a.revision,key);
      case'memoryCapture':return this.capture(a,key,actor);
      case'memoryEdit':return this.edit(a.id,'memory',a.patch,a.revision,key,true);
      case'memoryRefresh':{const row=this.node(a.id,'memory');if(!row.data.derivedDirty)fail('MEMORY_ALREADY_CURRENT');return this.edit(a.id,'memory',{facts:a.facts,canonicalFacts:a.facts,derivedDirty:false,domains:row.data.manualFields?.includes('domains')?row.data.domains:a.domains,topics:row.data.manualFields?.includes('topics')?row.data.topics:a.topics},a.revision,key);}
      case'memoryClassify':{const row=this.node(a.id,'memory');const patch:any={};for(const field of ['domains','topics','reusable'])if(a[field]!==undefined&&!row.data.manualFields?.includes(field)){patch[field]=field==='reusable'?a[field]&&['method','fact'].includes(row.data.type):a[field];}return this.edit(a.id,'memory',patch,a.revision,key);}
      case'memoryPrune':{const row=this.node(a.id,'memory'),d=row.data;const last=Math.max(d.createdAt??0,...d.observations.map((o:any)=>Date.parse(o.at)));if(d.pinned||d.protected||d.manualFields?.length||d.notes||d.importance>2||!['fact','method'].includes(d.type)||last>this.now()-365*86400000||this.all('edges').some((e:any)=>e.data.from===a.id||e.data.to===a.id))fail('MEMORY_REQUIRES_RETENTION');if(a.reason==='expired'&&(!d.validTo||Date.parse(d.validTo)>this.now()))fail('MEMORY_NOT_EXPIRED');return this.remove(a.id,a.revision,key);}
      case'memorySearch':return this.search(a);
      case'related':this.node(a.projectId,'project');return this.findRelated(a.projectId);
      case'associate':this.node(a.projectId,'project');return this.associateSelected(a.projectId,a.memories,key);
      case'consolidate':return this.command(key,{command,a},()=>{const result=this.commitPlan(this.planSemanticConsolidation(a.groups));if(result.changeId)this.notify('maintenance.completed',result,result.changeId);return result;});
      case'maintain':return this.command(key,{command},()=>{const result=this.commitPlan(this.planConsolidation());if(result.changeId)this.notify('maintenance.completed',result,result.changeId);return result;});
      case'changes':return this.db.prepare('SELECT id FROM changes ORDER BY created_at DESC,id LIMIT 40 OFFSET ?').all(a.offset).map((r:any)=>this.change(r.id));
      case'change':{const c=this.change(a.id);return{...c,expiresDisplay:formattedDeadline(c.expiresAt,this.settings.timezone),items:this.now()<c.expiresAt?this.rollbackItems(a.id).map((d:any)=>({id:d.object_id,before:JSON.parse(d.before_json),after:d.after_json?JSON.parse(d.after_json):null})):[]};}
      case'undo':return this.command(key,{command,a},()=>{const result=super.undo(a.id,key+':undo');this.notify('maintenance.undone',result,'undo:'+a.id);return result;});
      case'remove':return this.remove(a.id,a.revision,key);
      case'memoryRemove':if(actor.kind==='maintenance')fail('MAINTENANCE_COMMAND_NOT_ALLOWED');this.node(a.id,'memory');return this.remove(a.id,a.revision,key);
      case'allowMerge':{const change=this.change(a.id);if(!change.status.startsWith('undone'))fail('UNDO_REQUIRED');for(const pair of change.summary.pairs??[])this.db.prepare('DELETE FROM merge_blocks WHERE pair_hash=?').run(pair);return{allowed:true};}
      case'taskCreate':this.taskReferences(a);return this.create('task',this.taskData(a),key);
      case'taskEdit':{const row=this.node(a.id,'task');this.taskReferences({...row.data,...a.patch},a.id);if(actor.kind==='model'&&a.patch.status==='completed')fail('TASK_COMPLETION_REQUIRES_RUN_RESULT');return this.edit(a.id,'task',this.taskData({...row.data,...a.patch}),a.revision,key);}
      case'eventCreate':this.eventReferences(a);validateEvent(a);return this.create('event',a,key);
      case'eventOverride':return this.command(key,{command,a},()=>{const selected=this.node(a.id,'event');const master=selected.data.recurrenceId?this.rows('event').find((r:any)=>r.data.uid===selected.data.uid&&!r.data.recurrenceId):selected;if(!master)fail('RECURRING_EVENT_REQUIRED');if(selected.revision!==a.revision)fail('STALE_VERSION');const data=overrideOccurrence(master.data,a.occurrence,a.patch,a.cancelled);const old=this.rows('event').find((r:any)=>r.data.uid===data.uid&&r.data.recurrenceId===data.recurrenceId);if(old&&old.id!==a.id)fail('STALE_VERSION');return this.journal('calendar.occurrence.updated',[{id:old?.id??randomUUID(),kind:'event',before:old,data:{...data,owner:this.owner()}}]);});
      case'eventEdit':{const row=this.node(a.id,'event');if(row.data.ics&&(row.data.recurrenceId||row.data.recurrence||/EXDATE|RDATE/.test(row.data.ics)))fail('EDIT_IMPORTED_SERIES_VIA_OCCURRENCE');const next={...row.data,...a.patch,ics:undefined,zones:undefined,importHash:undefined};this.eventReferences(next);validateEvent(next);return this.edit(a.id,'event',next,a.revision,key);}
      case'calendar':return calendarOccurrences(this.rows('event'),a.from,a.to);
      case'icsImport':return this.importIcs(a,key);
      case'icsExport':return{content:exportCalendar(a.ids?a.ids.map((v:string)=>this.node(v,'event')):this.rows('event')),filename:'assistant.ics'};
      case'inbox':return this.db.prepare('SELECT * FROM notifications ORDER BY created_at DESC,id LIMIT 40 OFFSET ?').all(a.offset).map((r:any)=>({...r,payload:JSON.parse(r.payload)}));
      case'inboxRead':this.db.prepare('UPDATE notifications SET read_at=? WHERE id=?').run(this.now(),a.id);return{read:true};
      case'toolSave':return this.saveTool(a,key,actor);
      case'toolVersions':this.node(a.id,'tool');return this.db.prepare('SELECT id,created_at FROM tool_versions WHERE tool_id=? ORDER BY created_at DESC').all(a.id);
      case'toolActivate':{const row=this.node(a.id,'tool');const version=this.db.prepare('SELECT * FROM tool_versions WHERE id=? AND tool_id=?').get(a.version,a.id);if(!version)fail('TOOL_VERSION_NOT_FOUND');return this.edit(a.id,'tool',{activeVersion:a.version,pendingVersion:null,status:'active',...JSON.parse(version.definition)},a.revision,key);}
      case'sourceReview':{if(['model','maintenance'].includes(actor.kind)&&actor.sourceId!==a.sourceId&&!actor.allowedSourceIds?.includes(a.sourceId))fail('SOURCE_NOT_IN_CURRENT_TURN');this.db.prepare('UPDATE sources SET status=? WHERE id=?').run(a.reason,a.sourceId);return{reviewed:true};}
      case'entitySave':return a.id?this.edit(a.id,'entity',{name:a.name,title:a.name,type:a.type,aliases:a.aliases,domains:a.domains},a.revision,key):this.create('entity',{...a,title:a.name},key);
      case'link':return this.link(a.from,a.to,a.kind,key);
      default:return fail('UNKNOWN_COMMAND');
    }
  }
  list(a:any){
    let sql='SELECT id FROM nodes WHERE kind=?';const params:any[]=[a.kind];
    if(a.query){sql+=" AND (json_extract(data,'$.title') LIKE ? ESCAPE '\\' OR json_extract(data,'$.body') LIKE ? ESCAPE '\\')";const q='%'+a.query.replace(/[\\%_]/g,(s:string)=>'\\'+s)+'%';params.push(q,q);}
    if(a.projectId){this.node(a.projectId,'project');sql+=' AND (id IN (SELECT to_id FROM edges WHERE from_id=?) OR json_extract(data,\'$.projectId\')=?)';params.push(a.projectId,a.projectId);}
    const total=Number(this.db.prepare(sql.replace('SELECT id','SELECT COUNT(*) AS n')).get(...params).n);
    const rows=this.db.prepare(sql+" ORDER BY COALESCE(CASE WHEN kind='memory' THEN json_extract(data,'$.observations[#-1].at') END,json_extract(data,'$.createdAt'),0) DESC,id LIMIT ? OFFSET ?").all(...params,a.limit,a.offset).map((r:any)=>this.node(r.id));return{items:rows,total,offset:a.offset};
  }
  create(kind:string,data:any,key:string){return this.command(key,{action:'create',kind,data},()=>{const id=randomUUID();const change=this.journal(kind+'.created',[{id,kind,data:{...clone(data),owner:this.owner(),...(kind==='event'?{uid:randomUUID()}:{}),createdAt:data.createdAt??this.now()}}]);return{id,revision:this.version('nodes',id),...change};});}
  edit(id:string,kind:string,patch:any,revision:number,key:string,manual=false){return this.command(key,{action:'edit',id,kind,patch,revision},()=>{
    const before=this.node(id,kind);if(before.revision!==revision)fail('STALE_VERSION');
    if(!manual&&Object.entries(patch).every(([k,v])=>JSON.stringify(before.data[k])===JSON.stringify(v)))return{id,revision:before.revision,unchanged:true};const data={...before.data,...patch};if(manual){data.manualFields=[...new Set([...(data.manualFields??[]),...Object.keys(patch)])];if('body'in patch){data.derivedDirty=true;data.canonicalFacts=[];}}
    const change=this.journal(kind+'.updated',[{id,before,data,touched:Object.keys(patch)}]);return{id,revision:this.version('nodes',id),...change};});}
  capture(a:any,key:string,actor:Actor){return this.command(key,{action:'capture',a},()=>{
    if(['model','maintenance'].includes(actor.kind)&&actor.sourceId!==a.sourceId&&!actor.allowedSourceIds?.includes(a.sourceId))fail('SOURCE_NOT_IN_CURRENT_TURN');
    const source=this.db.prepare('SELECT * FROM sources WHERE id=?').get(a.sourceId);if(actor.sessionId&&source?.session_id!==actor.sessionId)fail('SOURCE_SESSION_MISMATCH');if(!source||!source.text.includes(a.quote))fail('QUOTE_NOT_IN_SOURCE');
    const project=a.projectId?this.node(a.projectId,'project'):null;
    if(Object.entries(a.requirements).some(([k,v])=>!project||JSON.stringify(project.data.context[k])!==JSON.stringify(v)))fail('REQUIREMENT_NOT_IN_PROJECT_CONTEXT');
    if(a.validFrom&&a.validTo&&Date.parse(a.validFrom)>=Date.parse(a.validTo))fail('INVALID_TIME_RANGE');
    const {projectId,sourceId,quote,occurredAt,...fields}=a;
    const id=randomUUID();const data={...fields,reusable:fields.reusable&&['method','fact'].includes(fields.type),owner:this.owner(),createdAt:this.now(),manualFields:source.session_id==='manual'?Object.keys(fields):[],protected:false,coverage:source.session_id==='manual'?'manual':'model-extracted',derivedDirty:false,
      observations:[{sourceId,quote,at:occurredAt,recordedAt:new Date(this.now()).toISOString()}],
      originalClaims:[{sourceId,quote,body:a.body,facts:a.facts,at:occurredAt}],canonicalFacts:a.facts};
    const mutations:any[]=[{id,kind:'memory',data}];
    if(projectId)mutations.push({table:'edges',id:randomUUID(),kind:'edge',data:{from:projectId,to:id,kind:'belongs_to'}});
    const change=this.journal('memory.created',mutations);this.db.prepare("UPDATE sources SET status='captured' WHERE id=?").run(sourceId);
    return{id,revision:this.version('nodes',id),...change};
  });}
  search(a:any){
    const query=tokens(a.query);if(!query.length)return[];
    const expression=query.map((t:string)=>'"'+t.replaceAll('"','""')+'"').join(' OR ');
    const project=a.projectId?this.node(a.projectId,'project'):null,now=this.now();
    return this.db.prepare('SELECT id,bm25(memory_search) AS rank FROM memory_search WHERE memory_search MATCH ? ORDER BY rank,id').all(expression).flatMap((r:any)=>{
      const row=this.node(r.id,'memory'),d=row.data;
      if(a.purpose==='external'&&d.visibility==='private')return[];
      if(d.validFrom&&Date.parse(d.validFrom)>now||d.validTo&&Date.parse(d.validTo)<=now)return[];
      if(project&&Object.entries(d.requirements).some(([k,v])=>JSON.stringify(project.data.context[k])!==JSON.stringify(v)))return[];
      const common={id:row.id,revision:row.revision,title:d.title,body:d.body,domains:d.domains,reusable:d.reusable,derivedDirty:d.derivedDirty,rank:r.rank};
      return [{...common,...a.purpose==='personal'?{facts:d.derivedDirty?[]:d.facts,originalClaims:d.manualFields?.includes('body')?[]:d.originalClaims,observations:d.observations}:{body:d.body.slice(0,600)}}];
    }).slice(0,a.limit);
  }
  findRelated(projectId:string){const p=this.node(projectId,'project');return this.search({query:[p.data.title,p.data.goal,...p.data.topics].join(' '),projectId,purpose:'personal',limit:30}).filter((r:any)=>r.reusable&&!r.derivedDirty).slice(0,12);}
  consolidationEligible(memory:any,reviews:any[]=[]){return memory.data.reusable&&!memory.data.derivedDirty&&super.consolidationEligible(memory,reviews);}
  taskData(a:any){const due=a.dueAt?Date.parse(a.dueAt):null;return{...a,urgent:due!==null&&due-this.now()<=48*3600000,important:a.importance>=4};}
  taskReferences(a:any,self?:string){if(a.projectId)this.node(a.projectId,'project');for(const dependency of a.dependsOn){this.node(dependency,'task');const seen=new Set([self]);const visit=(id:string)=>{if(seen.has(id))fail('TASK_DEPENDENCY_CYCLE');seen.add(id);for(const next of this.node(id,'task').data.dependsOn??[])visit(next);seen.delete(id);};visit(dependency);}}
  eventReferences(a:any){if(a.projectId)this.node(a.projectId,'project');if(a.taskId)this.node(a.taskId,'task');}
  remove(id:string,revision:number,key:string){return this.command(key,{action:'remove',id,revision},()=>{const before=this.node(id);if(before.revision!==revision)fail('STALE_VERSION');
    if(before.kind==='project'&&this.rows().some((r:any)=>r.data.projectId===id))fail('PROJECT_HAS_ACTIVE_REFERENCES');
    if(before.kind==='task'&&(this.rows('task').some((r:any)=>(r.data.dependsOn??[]).includes(id))||this.rows('event').some((r:any)=>r.data.taskId===id)))fail('TASK_HAS_DEPENDENTS');
    const edges=this.all('edges').filter((r:any)=>r.data.from===id||r.data.to===id);
    const exceptions=before.kind==='event'&&!before.data.recurrenceId?this.rows('event').filter((r:any)=>r.data.uid===before.data.uid&&r.id!==id):[];return this.journal(before.kind+'.removed',[...exceptions.map((r:any)=>({id:r.id,before:r,data:null})),...edges.map((e:any)=>({id:e.id,table:'edges',before:e,data:null})),{id,before,data:null}]);});}
  importIcs(a:any,key:string){const items=importCalendar(a.content,a.timezone);return this.command(key,{action:'import-ics',hash:digest(a.content)},()=>{
    const mutations:any[]=[];let unchanged=0;
    for(const data of items){const old=this.rows('event').find((r:any)=>r.data.uid===data.uid&&(r.data.recurrenceId??'')===data.recurrenceId);
      if(old&&(old.data.importHash===data.importHash||calendarIdentity(old.data)===calendarIdentity(data))){unchanged++;continue;}
      if(old&&!old.data.importHash)fail('ICS_CONFLICT_WITH_MANUAL_EVENT');
      mutations.push({id:old?.id??randomUUID(),kind:'event',before:old,data:{...data,owner:this.owner(),createdAt:old?.data.createdAt??this.now()}});
    }
    return{imported:mutations.length,unchanged,...mutations.length?this.journal('calendar.imported',mutations):{changeId:null}};
  });}
  saveTool(a:any,key:string,actor:Actor){return this.command(key,{action:'tool-save',a},()=>{
    const before=a.id?this.node(a.id,'tool'):null;if(before&&before.revision!==a.revision)fail('STALE_VERSION');
    const id=before?.id??randomUUID(),version=createHash('sha256').update(JSON.stringify(a.definition)).digest('hex');
    if(before&&(before.data.pendingVersion??before.data.activeVersion)===version)return{id,version,status:before.data.status,revision:before.revision,unchanged:true};
    if(a.definition.kind==='workflow'&&!a.definition.steps.length)fail('WORKFLOW_STEPS_REQUIRED');
    if(a.definition.kind==='script'&&!a.definition.source.trim())fail('SCRIPT_SOURCE_REQUIRED');
    this.db.prepare('INSERT OR IGNORE INTO tool_versions VALUES(?,?,?,?)').run(version,id,JSON.stringify(a.definition),this.now());
    const changedCaps=before&&a.definition.capabilities.some((c:string)=>!before.data.capabilities.includes(c));
    const active=actor.kind==='ui';
    const data={...a.definition,owner:this.owner(),createdAt:before?.data.createdAt??this.now(),activeVersion:active?version:before?.data.activeVersion??null,pendingVersion:active?null:version,status:active?'active':'draft'};
    const change=this.journal('tool.updated',[{id,kind:'tool',before,data}]);
    return{id,version,status:data.status,revision:this.version('nodes',id),...change};
  });}
  canRemoveCreated(table:string,id:string,deltas:any[]){if(table!=='nodes')return true;const planned=new Set(deltas.filter((d:any)=>d.table_name==='edges'&&JSON.parse(d.before_json)===null&&this.version('edges',d.object_id)===d.after_revision).map((d:any)=>d.object_id));if(this.all('edges').some((e:any)=>(e.data.from===id||e.data.to===id)&&!planned.has(e.id)))return false;return !this.rows().some((r:any)=>r.data.projectId===id||r.data.taskId===id||(r.data.dependsOn??[]).includes(id));}
  link(from:string,to:string,kind:string,key:string){return this.command(key,{action:'link',from,to,kind},()=>{this.node(from);this.node(to);const old=this.all('edges').find((e:any)=>e.data.from===from&&e.data.to===to&&e.data.kind===kind);if(old)return{id:old.id};const id=randomUUID();return{id,...this.journal('relation.created',[{id,table:'edges',kind:'edge',data:{from,to,kind}}])};});}
  associateSelected(projectId:string,versions:any[],key:string){return this.command(key,{action:'associate',projectId,versions},()=>{const candidates=new Set(this.findRelated(projectId).map((r:any)=>r.id));const mutations:any[]=[];for(const {id,revision}of versions){if(!candidates.has(id))fail('INAPPLICABLE_MEMORY');if(this.node(id).revision!==revision)fail('STALE_VERSION');if(!this.all('edges').some((e:any)=>e.data.from===projectId&&e.data.to===id&&e.data.kind==='reuses_method'))mutations.push({id:randomUUID(),table:'edges',kind:'edge',data:{from:projectId,to:id,kind:'reuses_method'}});}return{projectId,memoryIds:versions.map(r=>r.id),createdLinks:mutations.length,...mutations.length?this.journal('relation.created',mutations):{}};});}
  commitPlan(plan:any){const result=super.commitPlan(plan);const bytes=Number(this.db.prepare('SELECT COALESCE(SUM(LENGTH(before_json)+COALESCE(LENGTH(after_json),0)),0) AS n FROM deltas').get().n);if(bytes>this.settings.rollbackMegabytes*1024*1024)fail('ROLLBACK_STORAGE_FULL');return{...result,...result.expiresAt?{expiresDisplay:formattedDeadline(result.expiresAt,this.settings.timezone)}:{}};}
  pendingSources(limit=40){return this.db.prepare("SELECT s.id,s.session_id,s.role,s.text,s.at,s.project_id,c.workspace,c.preset FROM sources s LEFT JOIN source_context c ON c.id=s.id WHERE status='pending' ORDER BY at LIMIT ?").all(limit);}
  purge(){super.purgeExpired();const cutoff=this.now()-this.settings.rawDays*86400000;const removed=this.db.prepare("DELETE FROM sources WHERE at<? AND status IN ('captured','ordinary','temporary') AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM nodes WHERE kind='project' AND json_extract(data,'$.status')='active'))").run(cutoff).changes;this.db.prepare("DELETE FROM channel_messages WHERE created_at<? AND status IN ('done','sent','unknown')").run(cutoff);
    const versionCutoff=this.now()-this.retentionMs;const versions=this.db.prepare('SELECT id,tool_id,created_at FROM tool_versions ORDER BY tool_id,created_at DESC').all();const retained=new Map<string,number>();let purgedVersions=0;for(const v of versions){const tool=this.get('nodes',v.tool_id);const count=retained.get(v.tool_id)??0;retained.set(v.tool_id,count+1);if(v.created_at>=versionCutoff||tool&&(count<3||tool.data.activeVersion===v.id||tool.data.pendingVersion===v.id))continue;purgedVersions+=Number(this.db.prepare('DELETE FROM tool_versions WHERE id=? AND tool_id=?').run(v.id,v.tool_id).changes);}
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');return{purgedSources:removed,purgedVersions};}
  health(){return{integrity:this.db.prepare('PRAGMA integrity_check').get().integrity_check,foreignKeys:this.db.prepare('PRAGMA foreign_key_check').all(),schemaVersion:1,datasetId:this.owner()};}
}
