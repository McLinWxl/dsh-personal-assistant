import { randomUUID,createHash } from 'node:crypto';
import { writeFileSync,readFileSync,mkdirSync,existsSync,renameSync,statSync,unlinkSync } from 'node:fs';
import { join,resolve,relative,isAbsolute } from 'node:path';
import { MemoryStore,digest,tokens } from './memory-base.mjs';
import { openDirectory,inside,atomicJson } from './files.js';
import { defaults,settingsSchema,validate,formattedDeadline,type Actor,type Settings } from '../domain/contracts.js';
import { validateEvent,importCalendar,exportCalendar,calendarOccurrences,calendarIdentity,overrideOccurrence } from '../domain/calendar.js';
import {Projects} from './projects.js';
const Base:any=MemoryStore;
const fail=(code:string):never=>{throw new Error(code);};
const clone=<T>(v:T):T=>structuredClone(v);
const json=(value:any,fallback:any=null)=>{try{return value==null?fallback:JSON.parse(value);}catch{return fallback;}};

export class Store extends Base {
  directory:ReturnType<typeof openDirectory>;
  settings:Settings;
  projects:Projects;
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
      CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,window_from INTEGER NOT NULL,window_to INTEGER NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,conversation_id TEXT,session_id TEXT,message_id TEXT,snapshot_id TEXT,body TEXT NOT NULL DEFAULT '',summary_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,confirmed_at INTEGER,pushed_at INTEGER);
      CREATE INDEX IF NOT EXISTS report_created ON reports(created_at);
      CREATE TABLE IF NOT EXISTS report_items(id TEXT PRIMARY KEY,report_id TEXT NOT NULL,kind TEXT NOT NULL,object_id TEXT,action TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',detail TEXT NOT NULL DEFAULT '',at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS report_item_report ON report_items(report_id,at);
      CREATE TABLE IF NOT EXISTS report_revisions(id TEXT PRIMARY KEY,report_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS report_revision_report ON report_revisions(report_id,revision);
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,taken_at INTEGER NOT NULL,path TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS node_kind ON nodes(kind);
      PRAGMA user_version=1;
    `);
    const saved=this.db.prepare("SELECT value FROM settings WHERE key='preferences'").get();
    this.settings=settingsSchema.parse({...defaults,...saved?JSON.parse(saved.value):{},...options.settings});
    this.retentionMs=this.settings.retentionHours*3600000;
    this.projects=new Projects(this);
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
  addSource(input:{id:string;sessionId:string;role:string;text:string;at?:number;projectId?:string;status?:string;projectEligible?:boolean;context?:{workspace:string;preset:string;origin:string}}){
    if(!input.id||!input.sessionId||!['user','assistant','tool'].includes(input.role)||input.text.length>200000)fail('INVALID_SOURCE');
    const existing=this.db.prepare('SELECT text FROM sources WHERE id=?').get(input.id);
    if(existing){if(existing.text!==input.text)fail('SOURCE_ID_REUSED');this.projects.enqueue(input);return{id:input.id};}
    this.db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)').run(input.id,input.sessionId,input.role,input.text,input.at??this.now(),input.status??'pending',input.projectId??null);if(input.context)this.db.prepare('INSERT OR IGNORE INTO source_context VALUES(?,?,?,?)').run(input.id,input.context.workspace,input.context.preset,input.context.origin);this.projects.enqueue(input);return{id:input.id};
  }
  dispatch(command:string,input:unknown,key:string,actor:Actor){
    const a:any=validate(command,input);const reads=new Set(['overview','list','get','settingsGet','memorySearch','related','relations','calendar','icsExport','changes','change','inbox','toolVersions','reportWindow','reportList','reportGet']);
    // VACUUM INTO cannot run inside a transaction, so snapshots bypass the command wrapper.
    const direct=reads.has(command)||command==='snapshotTake';
    const result=direct?this.execute(command,a,key,actor):this.command(key,{command,a,actor:actor.kind},()=>this.execute(command,a,key+':body',actor));
    if(command==='settingsSave'){this.settings=settingsSchema.parse(JSON.parse(this.db.prepare("SELECT value FROM settings WHERE key='preferences'").get().value));this.retentionMs=this.settings.retentionHours*3600000;}return result;
  }
  execute(command:string,a:any,key:string,actor:Actor){
    const uiOnly=['settingsSave','remove','toolActivate','inboxRead'];
    if(uiOnly.includes(command)&&actor.kind!=='ui'&&actor.kind!=='system')fail('OWNER_ACTION_REQUIRED');
    switch(command){
      case'overview':return{counts:Object.fromEntries(this.db.prepare('SELECT kind,COUNT(*) AS n FROM nodes GROUP BY kind').all().map((r:any)=>[r.kind,r.n])),unread:Number(this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').get().n),dataRoot:this.directory.root,settings:this.settings};
      case'list':return this.list(a);
      case'searchAll':return this.searchAll(a);
      case'get':return this.node(a.id);
      case'relations':this.node(a.id);return this.all('edges').filter((e:any)=>e.data.from===a.id||e.data.to===a.id).map((e:any)=>({id:e.id,kind:e.data.kind,direction:e.data.from===a.id?'out':'in',object:this.node(e.data.from===a.id?e.data.to:e.data.from)}));
      case'settingsGet':return this.settings;
      case'settingsSave':return this.command(key,{command,a},()=>{const next=settingsSchema.parse({...this.settings,...a});this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('preferences',JSON.stringify(next));return{saved:true};});
      case'projectCreate':if(['model','maintenance'].includes(actor.kind))fail('USE_PROJECT_RESOLVE');return this.create('project',a,key);
      case'projectEdit':return this.edit(a.id,'project',a.patch,a.revision,key);
      case'memoryCapture':return this.capture(a,key,actor);
      case'memoryEdit':{const extra:any[]=[];
        if(Object.hasOwn(a.patch,'projectId')){const projectId=a.patch.projectId||null;if(projectId)this.node(projectId,'project');
          const links=this.all('edges').filter((e:any)=>e.data.to===a.id&&e.data.kind==='belongs_to');
          for(const edge of links)if(edge.data.from!==projectId)extra.push({id:edge.id,table:'edges',before:edge,data:null});
          if(projectId&&!links.some((e:any)=>e.data.from===projectId))extra.push({id:randomUUID(),table:'edges',kind:'edge',data:{from:projectId,to:a.id,kind:'belongs_to'}});
          a.patch.projectId=projectId;}
        return this.edit(a.id,'memory',a.patch,a.revision,key,true,extra);}
      case'memoryRefresh':{const row=this.node(a.id,'memory');if(!row.data.derivedDirty)fail('MEMORY_ALREADY_CURRENT');return this.edit(a.id,'memory',{facts:a.facts,canonicalFacts:a.facts,derivedDirty:false,domains:row.data.manualFields?.includes('domains')?row.data.domains:a.domains,topics:row.data.manualFields?.includes('topics')?row.data.topics:a.topics},a.revision,key);}
      case'memoryClassify':{const row=this.node(a.id,'memory');const patch:any={};for(const field of ['domains','topics','reusable'])if(a[field]!==undefined&&!row.data.manualFields?.includes(field)){patch[field]=field==='reusable'?a[field]&&['method','fact'].includes(row.data.type):a[field];}return this.edit(a.id,'memory',patch,a.revision,key);}
      case'memoryPrune':{const row=this.node(a.id,'memory'),d=row.data;const last=Math.max(d.createdAt??0,...d.observations.map((o:any)=>Date.parse(o.at)));if(d.pinned||d.protected||d.manualFields?.length||d.notes||d.importance>2||!['fact','method'].includes(d.type)||last>this.now()-365*86400000||this.all('edges').some((e:any)=>e.data.from===a.id||e.data.to===a.id))fail('MEMORY_REQUIRES_RETENTION');if(a.reason==='expired'&&(!d.validTo||Date.parse(d.validTo)>this.now()))fail('MEMORY_NOT_EXPIRED');return this.remove(a.id,a.revision,key);}
      case'memorySearch':return this.search(a);
      case'related':this.node(a.projectId,'project');return this.findRelated(a.projectId);
      case'associate':this.node(a.projectId,'project');return this.associateSelected(a.projectId,a.memories,key);
      case'consolidate':return this.command(key,{command,a},()=>{const result=this.commitPlan(this.planSemanticConsolidation(a.groups));if(result.changeId)this.notify('maintenance.completed',result,result.changeId);return result;});
      case'maintain':return this.command(key,{command},()=>{const result=this.commitPlan(this.planConsolidation());if(result.changeId)this.notify('maintenance.completed',result,result.changeId);return result;});
      case'changes':return this.db.prepare('SELECT id FROM changes ORDER BY created_at DESC,id LIMIT 40 OFFSET ?').all(a.offset).map((r:any)=>this.change(r.id));
      case'change':{const c=this.change(a.id);const summary:any=c.summary??{};
        const items=Array.isArray(summary.items)?summary.items.map((item:any)=>({kind:String(item?.kind??'maintenance'),objectId:String(item?.objectId??item?.object_id??''),title:String(item?.title??''),action:String(item?.action??'updated'),detail:String(item?.detail??'').slice(0,200)}))
          :this.db.prepare('SELECT table_name,object_id,before_json,after_json FROM deltas WHERE change_id=? ORDER BY position').all(a.id).map((d:any)=>{
            const before=d.before_json==null?null:json(this.codec.open(d.before_json)),after=d.after_json==null?null:json(this.codec.open(d.after_json));
            const row=this.get(d.table_name,d.object_id),kind=String(row?.kind??(d.table_name==='edges'?'edge':'object'));
            const title=String(row?.data?.title??row?.data?.name??d.object_id);
            return{kind,objectId:String(d.object_id),title,action:before==null?'created':after==null?'removed':'updated',detail:String(summary.type??'')};});
        return{id:c.id,createdAt:c.createdAt,expiresAt:c.expiresAt,status:c.status,summary,items,expiresDisplay:formattedDeadline(c.expiresAt,this.settings.timezone)};}
      case'reportWindow':return this.reportWindow(a);
      case'reportSave':{const now=this.now(),id=randomUUID();
        this.db.prepare("UPDATE reports SET status='superseded' WHERE status='draft'").run();
        this.db.prepare('INSERT INTO reports(id,window_from,window_to,status,revision,conversation_id,session_id,message_id,snapshot_id,body,summary_json,created_at,confirmed_at,pushed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)').run(id,a.from,a.to,'draft',1,a.conversationId??null,a.sessionId??null,a.messageId??null,a.snapshotId??null,String(a.body??''),JSON.stringify(a.summary??{}),now);
        for(const item of a.items??[])this.insertReportItem(id,item,now);
        this.db.prepare('INSERT INTO report_revisions VALUES(?,?,?,?,?)').run(randomUUID(),id,1,String(a.body??''),now);
        return{id,revision:1,status:'draft'};}
      case'reportRevise':{const row=this.db.prepare('SELECT * FROM reports WHERE id=?').get(a.id);if(!row)fail('REPORT_NOT_FOUND');if(row.status!=='draft')fail('REPORT_NOT_DRAFT');
        const now=this.now(),revision=Number(row.revision)+1;
        this.db.prepare('UPDATE reports SET body=?,revision=?,summary_json=? WHERE id=?').run(String(a.body??''),revision,a.summary===undefined?row.summary_json:JSON.stringify(a.summary),a.id);
        if(a.items!==undefined){this.db.prepare('DELETE FROM report_items WHERE report_id=?').run(a.id);for(const item of a.items)this.insertReportItem(a.id,item,now);}
        this.db.prepare('INSERT INTO report_revisions VALUES(?,?,?,?,?)').run(randomUUID(),a.id,revision,String(a.body??''),now);
        return{id:a.id,revision};}
      case'reportConfirm':{const row=this.db.prepare('SELECT * FROM reports WHERE id=?').get(a.id);if(!row)fail('REPORT_NOT_FOUND');
        this.db.prepare("UPDATE reports SET status='confirmed',confirmed_at=? WHERE id=?").run(this.now(),a.id);
        const updated=this.db.prepare('SELECT * FROM reports WHERE id=?').get(a.id);
        return this.reportRow(updated,true,Number(this.db.prepare('SELECT COUNT(*) AS n FROM report_items WHERE report_id=?').get(a.id).n));}
      case'reportList':{const total=Number(this.db.prepare('SELECT COUNT(*) AS n FROM reports').get().n);
        const rows=this.db.prepare('SELECT r.*,(SELECT COUNT(*) FROM report_items i WHERE i.report_id=r.id) AS item_count FROM reports r ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?').all(a.limit,a.offset);
        return{items:rows.map((r:any)=>this.reportRow(r,false,r.item_count)),total,offset:a.offset};}
      case'reportGet':{const row=this.db.prepare('SELECT * FROM reports WHERE id=?').get(a.id);if(!row)fail('REPORT_NOT_FOUND');
        const items=this.db.prepare('SELECT * FROM report_items WHERE report_id=? ORDER BY at,id').all(a.id).map((i:any)=>({id:i.id,kind:i.kind,objectId:i.object_id,action:i.action,title:i.title,detail:i.detail,at:Number(i.at)}));
        const revisions=this.db.prepare('SELECT revision,body,created_at FROM report_revisions WHERE report_id=? ORDER BY revision').all(a.id).map((r:any)=>({revision:Number(r.revision),body:r.body,createdAt:Number(r.created_at)}));
        return{...this.reportRow(row,true,items.length),items,revisions};}
      case'snapshotTake':return this.snapshotTake();
      case'snapshotPrune':return this.snapshotPrune(a.days);
      case'remove':return this.remove(a.id,a.revision,key);
      case'projectRemove':{this.node(a.id,'project');return this.remove(a.id,a.revision,key);}
      case'memoryRemove':if(actor.kind==='maintenance')fail('MAINTENANCE_COMMAND_NOT_ALLOWED');this.node(a.id,'memory');return this.remove(a.id,a.revision,key);
      case'taskCreate':this.taskReferences(a);return this.create('task',this.taskData(a),key);
      case'taskEdit':{const row=this.node(a.id,'task');this.taskReferences({...row.data,...a.patch},a.id);if(actor.kind==='model'&&a.patch.status==='completed')fail('TASK_COMPLETION_REQUIRES_RUN_RESULT');return this.edit(a.id,'task',this.taskData({...row.data,...a.patch}),a.revision,key);}
      case'eventCreate':this.eventReferences(a);validateEvent(a);return this.create('event',a,key);
      case'eventOverride':return this.command(key,{command,a},()=>{const selected=this.node(a.id,'event');const master=selected.data.recurrenceId?this.rows('event').find((r:any)=>r.data.uid===selected.data.uid&&!r.data.recurrenceId):selected;if(!master)fail('RECURRING_EVENT_REQUIRED');if(selected.revision!==a.revision)fail('STALE_VERSION');const data=overrideOccurrence(master.data,a.occurrence,a.patch,a.cancelled);const old=this.rows('event').find((r:any)=>r.data.uid===data.uid&&r.data.recurrenceId===data.recurrenceId);if(old&&old.id!==a.id)fail('STALE_VERSION');return this.journal('calendar.occurrence.updated',[{id:old?.id??randomUUID(),kind:'event',before:old,data:{...data,owner:this.owner()}}]);});
      case'eventEdit':{const row=this.node(a.id,'event');if(row.data.ics&&(row.data.recurrenceId||row.data.recurrence||/EXDATE|RDATE/.test(row.data.ics)))fail('EDIT_IMPORTED_SERIES_VIA_OCCURRENCE');const next={...row.data,...a.patch,ics:undefined,zones:undefined,importHash:undefined};this.eventReferences(next);validateEvent(next);return this.edit(a.id,'event',next,a.revision,key);}
      case'calendar':return calendarOccurrences(this.rows('event'),a.from,a.to);
      case'icsImport':return this.importIcs(a,key);
      case'icsExport':return{content:exportCalendar(a.ids?a.ids.map((v:string)=>this.node(v,'event')):this.rows('event')),filename:'assistant.ics'};
      case'inbox':return this.db.prepare("SELECT n.*,c.status AS changeStatus FROM notifications n LEFT JOIN changes c ON c.id=json_extract(n.payload,'$.changeId') ORDER BY n.created_at DESC,n.id LIMIT 40 OFFSET ?").all(a.offset).map((r:any)=>({...r,payload:JSON.parse(r.payload)}));
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
  reportWindow(a:any){
    const to=this.now();
    let from:number;
    if(a.from!==undefined)from=Number(a.from);
    else{const last:any=this.db.prepare("SELECT COALESCE(confirmed_at,window_to) AS anchor FROM reports ORDER BY created_at DESC,id DESC LIMIT 1").get();from=last?Number(last.anchor):to-86400000;}
    const items:any[]=[];
    const number=(value:any)=>{const n=Number(value);return Number.isFinite(n)?n:null;};
    const nodeRows=this.db.prepare("SELECT id FROM nodes WHERE kind IN ('memory','project','task','event','tool') AND (COALESCE(json_extract(data,'$.createdAt'),-1)>=? AND COALESCE(json_extract(data,'$.createdAt'),-1)<? OR COALESCE(json_extract(data,'$.updatedAt'),-1)>=? AND COALESCE(json_extract(data,'$.updatedAt'),-1)<?)").all(from,to,from,to);
    for(const entry of nodeRows){
      const data=this.node(entry.id).data,created=number(data.createdAt),updated=number(data.updatedAt);
      const createdIn=created!==null&&created>=from&&created<to,updatedIn=updated!==null&&updated>=from&&updated<to;
      if(!createdIn&&!updatedIn)continue;
      items.push({kind:this.get('nodes',entry.id).kind,objectId:entry.id,action:createdIn?'created':'updated',title:String(data.title??''),detail:String(data.body??data.goal??data.description??'').slice(0,160),at:createdIn?created:updated});
    }
    for(const row of this.db.prepare('SELECT * FROM changes WHERE created_at>=? AND created_at<?').all(from,to)){
      const summary:any=json(row.summary)??{},type=String(summary.type??''),changed=Number(summary.changedObjects??this.db.prepare('SELECT COUNT(*) AS n FROM deltas WHERE change_id=?').get(row.id).n);
      items.push({kind:'maintenance',objectId:row.id,action:/merge|consolidat|maintain/.test(type)||summary.groups?'merged':'updated',title:String(summary.title??(summary.groups?'记忆归并':type||'整理记录')),detail:`影响 ${changed} 项`,at:Number(row.created_at)});
    }
    for(const row of this.db.prepare('SELECT * FROM runs WHERE (created_at>=? AND created_at<?) OR (updated_at>=? AND updated_at<?)').all(from,to,from,to)){
      const created=number(row.created_at),updated=number(row.updated_at),at=updated!==null&&updated>=from&&updated<to?updated:created;
      let title=String(row.task_id??row.id);
      if(row.task_id){const task=this.get('nodes',row.task_id);if(task)title=String(task.data.title??title);}
      if(row.workflow_version){const version=this.db.prepare('SELECT definition FROM tool_versions WHERE id=?').get(row.workflow_version);if(version){const definition:any=json(version.definition)??{};if(definition.title)title=String(definition.title);}}
      items.push({kind:'run',objectId:row.id,action:row.status==='failed'?'failed':'ran',title,detail:String(row.status??''),at:Number(at)});
    }
    const notices=this.db.prepare("SELECT * FROM notifications WHERE created_at>=? AND created_at<? AND (type LIKE 'maintenance.%' OR type LIKE 'weixin.%' OR type IN ('task.failed','task.unknown'))").all(from,to);
    for(const row of notices){
      const type=String(row.type??''),payload:any=json(row.payload)??{};
      const kind=type.startsWith('weixin.')?'wechat':type.startsWith('task.')?'run':'maintenance';
      const labels:any={'maintenance.completed':'整理完成','maintenance.failed':'整理失败','weixin.delivery-unknown':'微信消息状态未知','task.failed':'任务执行失败','task.unknown':'任务结果未知'};
      const detail=String(payload.error??payload.messageId??payload.runId??(type==='maintenance.completed'?`影响 ${payload.changedObjects??0} 项`:type));
      items.push({kind,objectId:row.id,action:/failed|unknown|error/.test(type)?'failed':'confirmed',title:String(payload.title??labels[type]??type),detail:detail.slice(0,160),at:Number(row.created_at)});
    }
    items.sort((x:any,y:any)=>x.at-y.at||String(x.objectId).localeCompare(String(y.objectId)));
    const capped=items.length>400?items.slice(-400):items;
    const summary:any={memories:0,projects:0,tasks:0,events:0,tools:0,runs:0,wechat:0,maintenance:0};
    const buckets:Record<string,string>={memory:'memories',project:'projects',task:'tasks',event:'events',tool:'tools',run:'runs',wechat:'wechat',maintenance:'maintenance'};
    for(const item of capped){const key=buckets[item.kind];if(key)summary[key]++;}
    return{from,to,summary,items:capped};
  }
  reportRow(row:any,full=false,counts=0){
    return{id:row.id,windowFrom:Number(row.window_from),windowTo:Number(row.window_to),status:String(row.status),revision:Number(row.revision),conversationId:row.conversation_id??null,sessionId:row.session_id??null,messageId:row.message_id??null,snapshotId:row.snapshot_id??null,body:full?String(row.body??''):String(row.body??'').slice(0,4000),summary:json(row.summary_json)??{},createdAt:Number(row.created_at),confirmedAt:row.confirmed_at??null,pushedAt:row.pushed_at??null,counts:Number(counts)};
  }
  insertReportItem(reportId:string,item:any,fallbackAt:number){
    const at=Number(item?.at),ts=Number.isFinite(at)?Math.trunc(at):fallbackAt;
    this.db.prepare('INSERT INTO report_items VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),reportId,String(item?.kind??'maintenance'),item?.objectId??item?.object_id??null,String(item?.action??'updated'),String(item?.title??''),String(item?.detail??'').slice(0,1000),ts);
  }
  snapshotTake(){
    const now=this.now(),directory=join(this.directory.root,'snapshots'),stamp=this.snapshotStamp(now);
    mkdirSync(directory,{recursive:true});
    let path=join(directory,stamp+'.sqlite'),suffix=1;
    while(existsSync(path))path=join(directory,stamp+'-'+(++suffix)+'.sqlite');
    this.db.exec(`VACUUM INTO '${path.replaceAll("'","''")}'`);
    const bytes=statSync(path).size,sha256=createHash('sha256').update(readFileSync(path)).digest('hex'),id=randomUUID();
    this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?)').run(id,now,path,bytes,sha256,now+this.settings.snapshotDays*86400000);
    return{id,path,bytes,sha256};
  }
  snapshotStamp(ms:number){
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:this.settings.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms));
    const get=(type:string)=>parts.find(part=>part.type===type)?.value??'00';
    return `${get('year')}-${get('month')}-${get('day')}-${get('hour')}${get('minute')}${get('second')}`;
  }
  snapshotDayKey(ms:number){return this.snapshotStamp(ms).slice(0,10);}
  snapshotPrune(days?:number){
    const now=this.now(),cutoff=now-(days??this.settings.snapshotDays)*86400000,kept=new Set<string>(),remove:any[]=[];
    for(const row of this.db.prepare('SELECT * FROM snapshots ORDER BY taken_at DESC').all()){
      if(Number(row.expires_at)<=now){remove.push(row);continue;}
      if(Number(row.taken_at)<cutoff){const day=this.snapshotDayKey(Number(row.taken_at));if(kept.has(day))remove.push(row);else kept.add(day);}
    }
    for(const row of remove){
      this.db.prepare('DELETE FROM snapshots WHERE id=?').run(row.id);
      try{const path=resolve(String(row.path)),local=relative(this.directory.root,path);if(local&&!local.startsWith('..')&&!isAbsolute(local))unlinkSync(path);}catch{}
    }
    return{removed:remove.length};
  }
  list(a:any){
    let sql='SELECT id FROM nodes WHERE kind=?';const params:any[]=[a.kind];
    if(a.query){sql+=" AND (json_extract(data,'$.title') LIKE ? ESCAPE '\\' OR json_extract(data,'$.body') LIKE ? ESCAPE '\\')";const q='%'+a.query.replace(/[\\%_]/g,(s:string)=>'\\'+s)+'%';params.push(q,q);}
    if(a.projectId){this.node(a.projectId,'project');sql+=' AND (id IN (SELECT to_id FROM edges WHERE from_id=?) OR json_extract(data,\'$.projectId\')=?)';params.push(a.projectId,a.projectId);}
    const total=Number(this.db.prepare(sql.replace('SELECT id','SELECT COUNT(*) AS n')).get(...params).n);
    const order=a.sort==='title'?"json_extract(data,'$.title') COLLATE NOCASE ASC,id":a.sort==='created'?"COALESCE(json_extract(data,'$.createdAt'),0) DESC,id":"COALESCE(CASE WHEN kind='memory' THEN json_extract(data,'$.observations[#-1].at') END,json_extract(data,'$.createdAt'),0) DESC,id";
    const rows=this.db.prepare(sql+' ORDER BY '+order+' LIMIT ? OFFSET ?').all(...params,a.limit,a.offset).map((r:any)=>this.node(r.id));return{items:rows,total,offset:a.offset};
  }
  searchAll(a:any){
    const raw=String(a.query??'').trim();if(!raw)return{query:'',groups:{},total:0};
    const like='%'+raw.replace(/[\\%_]/g,(s:string)=>'\\'+s)+'%',limit=Math.max(1,Math.min(50,a.limit??20));
    const rows:any[]=this.db.prepare("SELECT kind,id,json_extract(data,'$.title') AS title,json_extract(data,'$.name') AS name,json_extract(data,'$.body') AS body,json_extract(data,'$.goal') AS goal,json_extract(data,'$.description') AS description,COALESCE(json_extract(data,'$.createdAt'),0) AS createdAt FROM nodes WHERE kind IN ('memory','project','task','event','tool','entity') AND (json_extract(data,'$.title') LIKE ? ESCAPE '\\' OR json_extract(data,'$.name') LIKE ? ESCAPE '\\' OR json_extract(data,'$.body') LIKE ? ESCAPE '\\' OR json_extract(data,'$.goal') LIKE ? ESCAPE '\\' OR json_extract(data,'$.description') LIKE ? ESCAPE '\\') ORDER BY createdAt DESC LIMIT ?").all(like,like,like,like,like,limit*4);
    const groups:Record<string,any[]>={};let total=0;
    for(const row of rows){const bucket=groups[row.kind]??(groups[row.kind]=[]);if(bucket.length>=5)continue;bucket.push({id:row.id,kind:row.kind,title:row.title??row.name??'',snippet:String(row.body??row.goal??row.description??'').slice(0,120)});total++;}
    return{query:raw,groups,total};
  }
  create(kind:string,data:any,key:string){return this.command(key,{action:'create',kind,data},()=>{const id=randomUUID();const change=this.journal(kind+'.created',[{id,kind,data:{...clone(data),owner:this.owner(),...(kind==='event'?{uid:randomUUID()}:{}),createdAt:data.createdAt??this.now()}}]);return{id,revision:this.version('nodes',id),...change};});}
  edit(id:string,kind:string,patch:any,revision:number,key:string,manual=false,extra:any[]=[]){return this.command(key,{action:'edit',id,kind,patch,revision},()=>{
    const before=this.node(id,kind);if(before.revision!==revision)fail('STALE_VERSION');
    if(!manual&&Object.entries(patch).every(([k,v])=>JSON.stringify(before.data[k])===JSON.stringify(v)))return{id,revision:before.revision,unchanged:true};const data={...before.data,...patch};if(manual){data.manualFields=[...new Set([...(data.manualFields??[]),...Object.keys(patch)])];if('body'in patch){data.derivedDirty=true;data.canonicalFacts=[];}}
    const change=this.journal(kind+'.updated',[{id,before,data,touched:Object.keys(patch)},...extra]);return{id,revision:this.version('nodes',id),...change};});}
  capture(a:any,key:string,actor:Actor){return this.command(key,{action:'capture',a},()=>{
    if(['model','maintenance'].includes(actor.kind)&&actor.sourceId!==a.sourceId&&!actor.allowedSourceIds?.includes(a.sourceId))fail('SOURCE_NOT_IN_CURRENT_TURN');
    const source=this.db.prepare('SELECT * FROM sources WHERE id=?').get(a.sourceId);if(actor.sessionId&&source?.session_id!==actor.sessionId)fail('SOURCE_SESSION_MISMATCH');if(!source||!source.text.includes(a.quote))fail('QUOTE_NOT_IN_SOURCE');
    const project=a.projectId?this.node(a.projectId,'project'):null;
    if(project&&Object.entries(a.requirements).some(([k,v])=>JSON.stringify(project.data.context[k])!==JSON.stringify(v)))fail('REQUIREMENT_NOT_IN_PROJECT_CONTEXT');
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
  canRemoveCreated(table:string,id:string,deltas:any[]){if(table!=='nodes')return true;if(this.db.prepare("SELECT 1 FROM project_resolutions WHERE project_id=? AND status='resolved' AND COALESCE(change_id,'')!=?").get(id,deltas[0]?.change_id??''))return false;const planned=new Set(deltas.filter((d:any)=>d.table_name==='edges'&&JSON.parse(d.before_json)===null&&this.version('edges',d.object_id)===d.after_revision).map((d:any)=>d.object_id));if(this.all('edges').some((e:any)=>(e.data.from===id||e.data.to===id)&&!planned.has(e.id)))return false;return !this.rows().some((r:any)=>r.data.projectId===id||r.data.taskId===id||(r.data.dependsOn??[]).includes(id));}
  link(from:string,to:string,kind:string,key:string){return this.command(key,{action:'link',from,to,kind},()=>{this.node(from);this.node(to);const old=this.all('edges').find((e:any)=>e.data.from===from&&e.data.to===to&&e.data.kind===kind);if(old)return{id:old.id};const id=randomUUID();return{id,...this.journal('relation.created',[{id,table:'edges',kind:'edge',data:{from,to,kind}}])};});}
  associateSelected(projectId:string,versions:any[],key:string){return this.command(key,{action:'associate',projectId,versions},()=>{const candidates=new Set(this.findRelated(projectId).map((r:any)=>r.id));const mutations:any[]=[];for(const {id,revision}of versions){if(!candidates.has(id))fail('INAPPLICABLE_MEMORY');if(this.node(id).revision!==revision)fail('STALE_VERSION');if(!this.all('edges').some((e:any)=>e.data.from===projectId&&e.data.to===id&&e.data.kind==='reuses_method'))mutations.push({id:randomUUID(),table:'edges',kind:'edge',data:{from:projectId,to:id,kind:'reuses_method'}});}return{projectId,memoryIds:versions.map(r=>r.id),createdLinks:mutations.length,...mutations.length?this.journal('relation.created',mutations):{}};});}
  commitPlan(plan:any){const result=super.commitPlan(plan);const bytes=Number(this.db.prepare('SELECT COALESCE(SUM(LENGTH(before_json)+COALESCE(LENGTH(after_json),0)),0) AS n FROM deltas').get().n);if(bytes>this.settings.rollbackMegabytes*1024*1024)fail('ROLLBACK_STORAGE_FULL');return{...result,...result.expiresAt?{expiresDisplay:formattedDeadline(result.expiresAt,this.settings.timezone)}:{}};}
  pendingSources(limit=40){return this.db.prepare("SELECT s.id,s.session_id,s.role,s.text,s.at,s.project_id,c.workspace,c.preset FROM sources s LEFT JOIN source_context c ON c.id=s.id WHERE status='pending' ORDER BY at LIMIT ?").all(limit);}
  purge(){super.purgeExpired();const now=this.now(),cutoff=now-this.settings.rawDays*86400000;const removed=this.db.prepare("DELETE FROM sources WHERE at<? AND status IN ('captured','ordinary','temporary') AND id NOT IN (SELECT source_id FROM project_resolutions WHERE status='pending') AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM nodes WHERE kind='project' AND json_extract(data,'$.status')='active'))").run(cutoff).changes;this.db.prepare("DELETE FROM channel_messages WHERE created_at<? AND status IN ('done','sent','unknown')").run(cutoff);
    const versionCutoff=now-this.retentionMs;const versions=this.db.prepare('SELECT id,tool_id,created_at FROM tool_versions ORDER BY tool_id,created_at DESC').all();const retained=new Map<string,number>();let purgedVersions=0;for(const v of versions){const tool=this.get('nodes',v.tool_id);const count=retained.get(v.tool_id)??0;retained.set(v.tool_id,count+1);if(v.created_at>=versionCutoff||tool&&(count<3||tool.data.activeVersion===v.id||tool.data.pendingVersion===v.id))continue;purgedVersions+=Number(this.db.prepare('DELETE FROM tool_versions WHERE id=? AND tool_id=?').run(v.id,v.tool_id).changes);}
    const journalCutoff=now-7*86400000;const purgedDeltas=Number(this.db.prepare('DELETE FROM deltas WHERE change_id IN (SELECT id FROM changes WHERE created_at<?)').run(journalCutoff).changes);
    const changeCutoff=now-this.settings.changeSummaryDays*86400000;const purgedChanges=Number(this.db.prepare('DELETE FROM changes WHERE created_at<?').run(changeCutoff).changes);
    this.db.prepare('DELETE FROM deltas WHERE change_id NOT IN (SELECT id FROM changes)').run();
    const purgedSnapshots=this.snapshotPrune().removed;
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');return{purgedSources:removed,purgedVersions,purgedDeltas,purgedChanges,purgedSnapshots};}
  health(){return{integrity:this.db.prepare('PRAGMA integrity_check').get().integrity_check,foreignKeys:this.db.prepare('PRAGMA foreign_key_check').all(),schemaVersion:1,datasetId:this.owner()};}
}
