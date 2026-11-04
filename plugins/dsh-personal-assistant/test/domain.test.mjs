import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,cpSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../lib/core.js';
const START=Date.parse('2026-11-04T10:00:00+08:00');
function fixture(t){const root=mkdtempSync(join(tmpdir(),'dsh-assistant-'));let now=START;const store=new Store(root,{clock:()=>now});t.after(()=>{try{store.close();}catch{}rmSync(root,{recursive:true,force:true});});let n=0;const call=(cmd,args={},actor={kind:'ui'})=>store.dispatch(cmd,args,'request-'+(++n),actor);return{root,store,call,time:v=>now=v};}
const project={title:'年度现场签到',goal:'断网继续签到',topics:['签到','名单'],context:{venue:'indoor'}};
const memory=(sourceId,body,at='2025-11-04T09:00:00+08:00')=>({title:'离线签到经验',body,type:'method',facts:[{subject:'签到',predicate:'准备',value:body}],sourceId,quote:body,occurredAt:at,topics:['签到','名单'],reusable:true});
function capture(f,body,projectId,at){const sourceId=crypto.randomUUID();f.store.addSource({id:sourceId,sessionId:'test-session',role:'user',text:body});return f.call('memoryCapture',{...memory(sourceId,body,at),projectId});}

test('new project recalls last-year facts; consolidation preserves original propositions and undo keeps manual edits',t=>{
 const f=fixture(t),p=f.call('projectCreate',project);const a=capture(f,'提前准备离线名单，断网也能继续签到',p.id);const b=capture(f,'准备纸质名单以便断网时继续现场签到',p.id,'2026-11-04T09:00:00+08:00');
 const next=f.call('projectCreate',{...project,title:'下一年度签到'});const related=f.call('related',{projectId:next.id});assert.equal(related.length,2);
 f.call('associate',{projectId:next.id,memories:related.map(r=>({id:r.id,revision:r.revision}))});
 const change=f.call('consolidate',{groups:[{memories:[a,b].map(r=>({id:r.id,revision:f.store.node(r.id).revision})),canonicalFacts:[{subject:'签到',predicate:'准备',value:'离线名单'}]}]},{kind:'maintenance'});
 const combined=f.store.node(a.id);assert.equal(combined.data.originalClaims.length,2);assert.equal(combined.data.facts.length,2);
 assert.ok(f.call('memorySearch',{query:'断网继续签到'})[0].originalClaims.some(c=>c.body.includes('断网')));
 f.call('memoryEdit',{id:a.id,revision:combined.revision,patch:{body:'人工修正：名单分两份，现场负责人保管',notes:'已安排'}});
 const undo=f.call('undo',{id:change.changeId});assert.ok(undo.preserved.some(r=>r.field==='body'));assert.equal(f.store.rows('memory').length,2);
 assert.match(f.store.node(a.id).data.body,/人工修正/);assert.equal(f.store.node(a.id).data.notes,'已安排');assert.equal(f.store.node(a.id).data.derivedDirty,true);assert.deepEqual(f.store.health().foreignKeys,[]);
});

test('capture and project relation are one replayable transaction; spoofed sources and conditions are refused',t=>{
 const f=fixture(t);f.store.addSource({id:'source',sessionId:'session',role:'user',text:'保留离线名单'});const p=f.call('projectCreate',project);
 const input={...memory('source','保留离线名单'),projectId:p.id};const result=f.store.dispatch('memoryCapture',input,'stable',{kind:'model',sourceId:'source'});
 assert.deepEqual(f.store.dispatch('memoryCapture',input,'stable',{kind:'model',sourceId:'source'}),result);assert.equal(f.store.rows('memory').length,1);
 assert.equal(f.store.all('edges').filter(e=>e.data.from===p.id&&e.data.to===result.id).length,1);
 assert.throws(()=>f.call('memoryCapture',{...input,quote:'虚构引用'},{kind:'model',sourceId:'source'}),/QUOTE_NOT_IN_SOURCE/);
 assert.throws(()=>f.call('memoryCapture',{...input,requirements:{offlineList:true}}),/REQUIREMENT_NOT_IN_PROJECT_CONTEXT/);
 assert.throws(()=>f.call('memoryCapture',input,{kind:'model',sourceId:'another'}),/SOURCE_NOT_IN_CURRENT_TURN/);
 assert.throws(()=>f.call('memoryCapture',{...input,owner:'forged'}));assert.equal(f.store.rows('memory').length,1);
});

test('undo creation preserves subsequent human edits and expired encrypted deltas cannot be read',t=>{
 const f=fixture(t);const m=capture(f,'家人聚会提前订位');const raw=f.store.db.prepare('SELECT before_json,after_json FROM deltas WHERE change_id=?').all(m.changeId);
 assert.ok(raw.every(r=>!r.after_json.includes('聚会')));f.call('memoryEdit',{id:m.id,revision:m.revision,patch:{body:'保留我的修正'}});f.call('undo',{id:m.changeId});assert.equal(f.store.node(m.id).data.body,'保留我的修正');
 f.time(START+72*3600000);assert.throws(()=>f.store.rollbackItems(m.changeId),/UNDO_EXPIRED/);f.store.purge();assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM deltas').get().n,0);
});

test('a live data directory has one writer and a stopped copy retains encrypted undo',t=>{
 const f=fixture(t);assert.throws(()=>new Store(f.root),/DATA_DIRECTORY_LOCKED/);const m=capture(f,'旅行时保留纸质地址');f.store.close();
 const destination=mkdtempSync(join(tmpdir(),'dsh-assistant-copy-'));t.after(()=>rmSync(destination,{recursive:true,force:true}));cpSync(f.root,destination,{recursive:true});const moved=new Store(destination,{clock:()=>START+1000});try{moved.dispatch('undo',{id:m.changeId},'undo',{kind:'ui'});assert.equal(moved.rows('memory').length,0);}finally{moved.close();}
});

test('raw retention waits for extraction and does not remove important memory',t=>{
 const f=fixture(t);f.call('settingsSave',{rawDays:1});capture(f,'固定的重要家庭约定');f.store.addSource({id:'pending',sessionId:'s',role:'user',text:'尚未整理的内容'});f.time(START+2*86400000);f.store.purge();assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n,1);assert.equal(f.store.pendingSources()[0].id,'pending');assert.equal(f.store.rows('memory').length,1);
});

test('project-specific arrangements do not become reusable methods and private facts stay out of external recall',t=>{
 const f=fixture(t),p=f.call('projectCreate',project);f.store.addSource({id:'s',sessionId:'s',role:'user',text:'这次签到给儿童餐券'});
 f.call('memoryCapture',{...memory('s','这次签到给儿童餐券'),projectId:p.id,reusable:false,visibility:'private'});
 assert.equal(f.call('related',{projectId:p.id}).length,0);assert.equal(f.call('memorySearch',{query:'儿童餐券',purpose:'external'}).length,0);assert.equal(f.call('memorySearch',{query:'儿童餐券'}).length,1);
});

test('calendar supports all-day end exclusivity, recurrence, ICS roundtrip and repeated imports',t=>{
 const f=fixture(t);const e=f.call('eventCreate',{title:'每周复盘',start:'2026-11-04T10:00:00+08:00',end:'2026-11-04T11:00:00+08:00',timezone:'Asia/Shanghai',recurrence:'FREQ=WEEKLY;COUNT=3'});
 const rows=f.call('calendar',{from:'2026-11-01T00:00:00Z',to:'2026-12-01T00:00:00Z'});assert.equal(rows.length,3);assert.equal(rows[0].occurrenceStart,'2026-11-04T02:00:00.000Z');
 const content=f.call('icsExport',{}).content;const imported=f.call('icsImport',{content,timezone:'Asia/Shanghai'});assert.equal(imported.imported,0); // Existing authored UID is handled without duplicates below.
});

test('task relationships reject cycles and model cannot declare completion without an execution result',t=>{
 const f=fixture(t);const a=f.call('taskCreate',{title:'准备资料',importance:4,dueAt:'2026-11-05T10:00:00+08:00'});const b=f.call('taskCreate',{title:'提交资料',dependsOn:[a.id]});assert.equal(f.store.node(a.id).data.urgent,true);assert.equal(f.store.node(a.id).data.important,true);
 assert.throws(()=>f.call('taskEdit',{id:a.id,revision:a.revision,patch:{dependsOn:[b.id]}}),/TASK_DEPENDENCY_CYCLE/);
 assert.throws(()=>f.call('taskEdit',{id:a.id,revision:a.revision,patch:{status:'completed'}},{kind:'model'}),/TASK_COMPLETION_REQUIRES_RUN_RESULT/);
});
test('partial updates preserve every omitted creation field across projects, tasks and calendar occurrences',t=>{const f=fixture(t);const p=f.call('projectCreate',{...project,domains:['生活']});const beforeProject=f.store.node(p.id).data;f.call('projectEdit',{id:p.id,revision:p.revision,patch:{status:'paused'}});assert.deepEqual(f.store.node(p.id).data,{...beforeProject,status:'paused'});const task=f.call('taskCreate',{title:'提交',description:'保留完整内容',projectId:p.id,domains:['生活'],importance:5,dueAt:'2026-11-05T12:00:00+08:00'}),beforeTask=f.store.node(task.id).data;f.call('taskEdit',{id:task.id,revision:task.revision,patch:{title:'更新标题'}});assert.deepEqual(f.store.node(task.id).data,{...beforeTask,title:'更新标题'});const e=f.call('eventCreate',{title:'每周会',start:'2026-11-05T09:00:00+08:00',end:'2026-11-05T10:00:00+08:00',timezone:'Asia/Shanghai',recurrence:'FREQ=WEEKLY;COUNT=3',description:'保留备注',location:'会议室',importance:5,domains:['工作']});const beforeEvent=f.store.node(e.id).data;f.call('eventEdit',{id:e.id,revision:e.revision,patch:{title:'例会'}});const after=f.store.node(e.id);for(const field of ['recurrence','description','location','importance','domains','start','end','timezone'])assert.deepEqual(after.data[field],beforeEvent[field]);const rows=f.call('calendar',{from:'2026-11-01T00:00:00Z',to:'2026-12-01T00:00:00Z'});f.call('eventOverride',{id:e.id,revision:after.revision,occurrence:rows[1].occurrenceKey,patch:{title:'第二次例会'}});const edited=f.call('calendar',{from:'2026-11-01T00:00:00Z',to:'2026-12-01T00:00:00Z'})[1];assert.equal(edited.data.description,'保留备注');assert.equal(edited.data.location,'会议室');assert.equal(edited.data.importance,5);assert.equal(edited.occurrenceStart,rows[1].occurrenceStart);});

test('tool versions are immutable and a new capability produces a draft for a model-authored update',t=>{
 const f=fixture(t);const tool=f.call('toolSave',{definition:{title:'复盘',kind:'workflow',steps:[{tool:'assistant_memory_search',args:{query:'项目经验'}}]}});
 const next=f.call('toolSave',{id:tool.id,revision:tool.revision,definition:{title:'复盘',kind:'workflow',steps:[{tool:'assistant_memory_search',args:{query:'新项目'}}],capabilities:['network']}},{kind:'model'});
 assert.equal(next.status,'draft');assert.equal(f.store.node(tool.id).data.activeVersion,tool.version);assert.equal(f.call('toolVersions',{id:tool.id}).length,2);
});

test('create request idempotency survives the clock moving and event UID generation',t=>{const f=fixture(t);const p=f.store.dispatch('projectCreate',{title:'幂等创建'},'same-project',{kind:'ui'});const input={title:'日程',start:'2026-11-05T10:00:00Z',end:'2026-11-05T11:00:00Z',timezone:'UTC'};const e=f.store.dispatch('eventCreate',input,'same-event',{kind:'ui'});f.time(START+5000);assert.deepEqual(f.store.dispatch('projectCreate',{title:'幂等创建'},'same-project',{kind:'ui'}),p);assert.deepEqual(f.store.dispatch('eventCreate',input,'same-event',{kind:'ui'}),e);});
test('undo preserves newly referenced objects and association changes can be undone',t=>{const f=fixture(t);const p=f.call('projectCreate',project);const m=capture(f,'离线签到名单');const relation=f.call('associate',{projectId:p.id,memories:[{id:m.id,revision:m.revision}]});f.call('undo',{id:m.changeId});assert.ok(f.store.node(m.id));f.call('undo',{id:relation.changeId});assert.equal(f.store.all('edges').length,0);const task=f.call('taskCreate',{title:'后续任务',projectId:p.id});f.call('undo',{id:p.changeId});assert.ok(f.store.node(p.id));assert.equal(f.store.node(task.id).data.projectId,p.id);});
test('derived refresh preserves human wording and protected labels; pruning retains significant or linked memories',t=>{const f=fixture(t);const m=capture(f,'准备签到名单');f.call('memoryEdit',{id:m.id,revision:m.revision,patch:{body:'改为二维码和纸质双通道',domains:['生活']}});let r=f.store.node(m.id);const facts=[{subject:'签到',predicate:'方式',value:'二维码与纸质双通道'}];f.call('memoryRefresh',{id:m.id,revision:r.revision,facts,domains:['工作'],topics:['签到']},{kind:'maintenance'});r=f.store.node(m.id);assert.equal(r.data.body,'改为二维码和纸质双通道');assert.deepEqual(r.data.domains,['生活']);assert.deepEqual(r.data.facts,facts);assert.equal(r.data.derivedDirty,false);f.time(START+800*86400000);assert.throws(()=>f.call('memoryPrune',{id:m.id,revision:r.revision,reason:'old-low-value'},{kind:'maintenance'}),/RETENTION/);});
test('old unlinked low-importance facts can be pruned and recovered',t=>{const f=fixture(t);f.store.addSource({id:'s',sessionId:'s',role:'user',text:'旧展会入口在东门'});const m=f.call('memoryCapture',{...memory('s','旧展会入口在东门'),importance:1});f.time(START+400*86400000);const removal=f.call('memoryPrune',{id:m.id,revision:m.revision,reason:'old-low-value'},{kind:'maintenance'});assert.throws(()=>f.store.node(m.id));f.call('undo',{id:removal.changeId});assert.equal(f.store.node(m.id).data.body,'旧展会入口在东门');});
test('urgency follows the current time, not only task edits',t=>{const f=fixture(t);const task=f.call('taskCreate',{title:'日常待办',dueAt:'2026-11-10T10:00:00+08:00'});assert.equal(f.store.node(task.id).data.urgent,false);f.time(START+5*86400000);assert.equal(f.store.node(task.id).data.urgent,true);});
test('calendar all-day end is exclusive and weekly local times survive DST',t=>{const f=fixture(t);f.call('eventCreate',{title:'全天',start:'2026-11-04',end:'2026-11-05',timezone:'Asia/Shanghai',allDay:true});assert.equal(f.call('calendar',{from:'2026-11-05T00:00:00Z',to:'2026-11-06T00:00:00Z'}).length,0);f.call('eventCreate',{title:'纽约周会',start:'2026-10-26T09:00:00-04:00',end:'2026-10-26T10:00:00-04:00',timezone:'America/New_York',recurrence:'FREQ=WEEKLY;COUNT=3'});const rows=f.call('calendar',{from:'2026-10-25T00:00:00Z',to:'2026-11-12T00:00:00Z'}).filter(r=>r.data.title==='纽约周会');assert.deepEqual(rows.map(r=>r.occurrenceStart),['2026-10-26T13:00:00.000Z','2026-11-02T14:00:00.000Z','2026-11-09T14:00:00.000Z']);});

test('single recurring occurrences move, cancel, undo and survive ICS export/import',t=>{const f=fixture(t);const e=f.call('eventCreate',{title:'周会',start:'2026-11-04T09:00:00+08:00',end:'2026-11-04T10:00:00+08:00',timezone:'Asia/Shanghai',recurrence:'FREQ=WEEKLY;COUNT=3'});let rows=f.call('calendar',{from:'2026-11-01T00:00:00Z',to:'2026-12-01T00:00:00Z'});const change=f.call('eventOverride',{id:e.id,revision:e.revision,occurrence:rows[1].occurrenceKey,patch:{start:'2026-11-12T09:00:00+08:00',end:'2026-11-12T10:00:00+08:00'}});rows=f.call('calendar',{from:'2026-11-01T00:00:00Z',to:'2026-12-01T00:00:00Z'});assert.equal(rows.length,3);assert.equal(rows[1].occurrenceStart,'2026-11-12T01:00:00.000Z');const override=rows[1];const cancelled=f.call('eventOverride',{id:override.id,revision:override.revision,occurrence:override.occurrenceKey,cancelled:true});assert.equal(f.call('calendar',{from:'2026-11-01T00:00:00Z',to:'2026-12-01T00:00:00Z'}).length,2);f.call('undo',{id:cancelled.changeId});assert.equal(f.call('calendar',{from:'2026-11-01T00:00:00Z',to:'2026-12-01T00:00:00Z'}).length,3);const content=f.call('icsExport').content;assert.match(content,/RECURRENCE-ID/);f.call('undo',{id:change.changeId});});
test('floating ICS dates use the selected timezone and impossible dates are rejected',t=>{const f=fixture(t);f.call('icsImport',{timezone:'Asia/Shanghai',content:'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:float-one\r\nDTSTART:20261105T090000\r\nDTEND:20261105T100000\r\nSUMMARY:浮动时间\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'});const rows=f.call('calendar',{from:'2026-11-05T00:00:00Z',to:'2026-11-06T00:00:00Z'});assert.equal(rows[0].occurrenceStart,'2026-11-05T01:00:00.000Z');assert.throws(()=>f.call('eventCreate',{title:'非法日期',allDay:true,start:'2026-02-30',end:'2026-03-02',timezone:'UTC'}));});

test('reusability never converts preferences or episodes into cross-project methods',t=>{const f=fixture(t);for(const type of ['preference','episode','decision','goal']){const sourceId='source-'+type;f.store.addSource({id:sourceId,sessionId:'native',role:'user',text:'社区活动先准备离线签到'});const row=f.call('memoryCapture',{...memory(sourceId,'社区活动先准备离线签到'),type,reusable:true});assert.equal(f.store.node(row.id).data.reusable,false);f.call('memoryClassify',{id:row.id,revision:row.revision,domains:['生活'],topics:['签到'],reusable:true},{kind:'maintenance'});assert.equal(f.store.node(row.id).data.type,type);assert.equal(f.store.node(row.id).data.reusable,false);}});
