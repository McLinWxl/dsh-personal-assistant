import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {buildNodeEntries} from '../plugins/dsh-personal-assistant/scripts/build.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const bundle=mkdtempSync(join(tmpdir(),'dsh-v2-check-'));
await buildNodeEntries({core:'src/storage/store.ts',lifecycle:'src/host/project-lifecycle.ts',catalog:'src/domain/commands.ts',migration:'src/storage/migrate-v2.ts'},bundle);
copyFileSync(join(root,'plugins/dsh-personal-assistant/lib/zones.json'),join(bundle,'zones.json'));
const {Store}=await import(pathToFileURL(join(bundle,'core.js')));
const {ProjectLifecycle}=await import(pathToFileURL(join(bundle,'lifecycle.js')));
const {commandCatalog}=await import(pathToFileURL(join(bundle,'catalog.js')));
const {migrateDirectory}=await import(pathToFileURL(join(bundle,'migration.js')));
after(()=>rmSync(bundle,{recursive:true,force:true}));
const START=Date.parse('2026-11-05T10:00:00+08:00');

function fixture(t,options={}){
  const directory=mkdtempSync(join(tmpdir(),'dsh-v2-data-'));let now=START,n=0;
  const store=new Store(directory,{clock:()=>now,...options});
  t.after(()=>{try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});});
  const call=(command,payload={},actor={kind:'ui'},requestId='call-'+(++n))=>store.dispatch(command,payload,requestId,actor);
  const ref=id=>({id,revision:store.node(id).revision});
  const create=(title,parentId=null,extra={})=>call('projectCreate',{title,parent:parentId?ref(parentId):null,...extra});
  const source=(id,text,sessionId='session',extra={})=>store.addSource({id,text,sessionId,role:'user',...extra});
  const capture=(id,projectId,extra={})=>{source(id,'签到先准备离线名单，网络中断时继续核验报名信息');return call('memoryCapture',{sourceId:id,quote:'签到先准备离线名单',title:'离线签到方法',body:'签到先准备离线名单',type:'method',facts:[{subject:'签到',predicate:'准备',value:'离线名单'}],topics:['签到','报名'],occurredAt:'2026-11-05T10:00:00+08:00',reusable:true,...projectId?{projectId}:{},...extra});};
  const apply=(id,decisions,selections=[])=>{const input={sourceId:id,snapshot:store.projects.snapshot(),plan:{decisions},selections};return store.command('apply-'+(++n),input,()=>store.projects.apply(input));};
  const explicit=(id,title,parentId=null,extra={})=>({action:parentId?'create_child':'create_root',...parentId?{parent:ref(parentId)}:{},project:{title,...extra},evidence:{basis:'explicit',sources:[{sourceId:id,quote:store.projects.source(id).text}]},quote:store.projects.source(id).text,reason:'明确开展事项',confidence:1});
  const attach=(id,projectId)=>({action:'attach',target:ref(projectId),quote:store.projects.source(id).text,reason:'继续同一事项',confidence:1});
  const none=(id,disposition='unresolved')=>({action:'none',disposition,quote:store.projects.source(id).text,reason:'当前资料不足',confidence:0});
  const storage={async call(method,a={}){switch(method){
    case'projectInspect':return store.projects.inspect(a.sourceId);
    case'projectPending':return store.projects.pending(a.limit,a.busy);
    case'projectPreview':return store.projects.preview(a);
    case'projectApply':{const {requestId,...input}=a;return store.command(requestId,input,()=>store.projects.apply(input));}
    case'projectRetry':return store.projects.retry(a.sourceId,a.error);
    case'projectMaintenanceContext':return store.projects.maintenanceContext(a.phase,a.limit);
    case'projectMaintenanceApply':return store.projects.maintenanceApply(a.plan,a.phase,a.snapshot,a.requestId);
    case'projectMaintenanceProgress':return{};
    default:throw new Error(method);
  }}};
  const service={storage,shutdownSignal:new AbortController().signal,projectModel:async()=>{throw new Error('MODEL_NOT_CONFIGURED');}};
  return{store,call,ref,create,source,capture,apply,explicit,attach,none,directory,service,lifecycle:new ProjectLifecycle(service),time:value=>now=value};
}

function healthy(f){const health=f.store.health();assert.equal(health.integrity,'ok');assert.deepEqual(health.foreignKeys,[]);assert.equal(health.schemaVersion,2);}

test('v2 stores project attributes once and supports one owner plus many applicable projects',t=>{
  const f=fixture(t),a=f.create('项目甲'),b=f.create('项目乙'),c=f.create('项目丙'),m=f.capture('m',a.id);
  for(const project of [b,c])f.call('projectAttach',{object:f.ref(m.id),project:f.ref(project.id),role:'applies_to'});
  assert.equal(f.store.tree.links(m.id).length,3);assert.equal(f.store.node(m.id).projectId,a.id);
  assert.equal(Object.hasOwn(f.store.node(m.id).data,'projectId'),false);
  assert.deepEqual(Object.keys(JSON.parse(f.store.db.prepare('SELECT data FROM nodes WHERE id=?').get(a.id).data)),['owner']);
  assert.throws(()=>f.store.db.prepare('INSERT INTO links VALUES(?,?,?,?,?,?)').run(m.id,b.id,'contains',1,'test',START),/UNIQUE/);
  assert.throws(()=>f.store.put('nodes',m.id,'memory',{...f.store.node(m.id).data,projectId:b.id}),/STORED_PROJECT_FIELD_FORBIDDEN/);
  healthy(f);
});

test('normalized root, sibling titles and global aliases enforce their respective uniqueness',t=>{
  const f=fixture(t),a=f.create('Ａ B'),b=f.create('另一项目');assert.throws(()=>f.create('ab'),/PROJECT_TITLE_CONFLICT/);
  const c=f.create('模块',a.id);assert.throws(()=>f.create('模 块',a.id),/PROJECT_TITLE_CONFLICT/);f.create('模块',b.id);
  f.call('projectAlias',{...f.ref(a.id),alias:'常用事项',action:'add'});
  assert.throws(()=>f.call('projectAlias',{...f.ref(b.id),alias:'常 用事项',action:'add'}),/PROJECT_ALIAS_CONFLICT/);
  f.source('s','继续常用事项');assert.equal(f.store.projects.inspect('s').projects.filter(p=>p.exact).length,1);
  f.call('projectRename',{...f.ref(c.id),title:'新模块'});assert.equal(f.store.node(c.id).data.key,c.key);healthy(f);
});

test('moving checks the whole subtree and atomically preserves paths on cycle, depth and title failures',t=>{
  const f=fixture(t),a=f.create('甲'),b=f.create('乙'),c=f.create('子',a.id),d=f.create('孙',c.id),e=f.create('第四层',d.id);
  const before=f.call('projectTree');
  assert.throws(()=>f.call('projectMove',{...f.ref(a.id),parent:f.ref(d.id)}),/PROJECT_CYCLE/);
  assert.throws(()=>f.call('projectMove',{...f.ref(c.id),parent:f.ref(d.id)}),/PROJECT_CYCLE/);
  const deep=f.create('深',b.id);assert.throws(()=>f.call('projectMove',{...f.ref(c.id),parent:f.ref(deep.id)}),/PROJECT_DEPTH_EXCEEDED/);
  assert.equal(f.store.node(e.id).data.path,before.items.find(row=>row.id===e.id).data.path);
  f.call('projectMove',{...f.ref(c.id),parent:f.ref(b.id)});
  assert.equal(f.store.node(e.id).data.path,`${f.store.node(b.id).data.path}/${c.key}/${d.key}/${e.key}`);
  assert.equal(f.store.node(e.id).data.depth,4);healthy(f);
});

test('project preview rolls back all writes, notifications, clocks and request records',t=>{
  const f=fixture(t),a=f.create('甲'),b=f.create('乙');
  const before=f.store.db.prepare("SELECT (SELECT value FROM meta WHERE key='revision') AS rev,(SELECT COUNT(*) FROM notifications) AS notices,(SELECT COUNT(*) FROM changes) AS changes").get();
  const preview=f.call('projectPreview',{operation:'projectMerge',payload:{source:f.ref(a.id),target:f.ref(b.id)}});
  assert.ok(preview.changes.length>=2);assert.equal(f.store.node(a.id).data.mergedInto,null);
  assert.deepEqual(f.store.db.prepare("SELECT (SELECT value FROM meta WHERE key='revision') AS rev,(SELECT COUNT(*) FROM notifications) AS notices,(SELECT COUNT(*) FROM changes) AS changes").get(),before);healthy(f);
});

test('merge redirects memberships, aliases, sessions, provenance and existing redirects with versions',t=>{
  const f=fixture(t),a=f.create('甲',null),b=f.create('乙'),c=f.create('丙'),child=f.create('子',a.id),m=f.capture('m',a.id);
  f.call('projectAttach',{object:f.ref(m.id),project:f.ref(b.id),role:'applies_to'});
  f.call('projectBind',{sessionId:'session',project:f.ref(a.id),expectedRevision:0});
  f.store.db.prepare('INSERT INTO source_projects VALUES(?,?)').run('m',a.id);
  const oldVersion=f.ref(m.id);
  f.call('projectMerge',{source:f.ref(a.id),target:f.ref(b.id)});
  assert.equal(f.store.node(a.id).data.mergedInto,b.id);assert.equal(f.store.node(child.id).data.parentId,b.id);
  assert.equal(f.store.tree.membership(m.id),b.id);assert.ok(f.store.node(m.id).revision>oldVersion.revision);
  assert.equal(f.store.tree.binding('session').projectId,b.id);assert.ok(f.store.node(b.id).data.aliases.includes(a.key));
  f.call('projectMerge',{source:f.ref(b.id),target:f.ref(c.id)});assert.equal(f.store.node(a.id).data.mergedInto,c.id);healthy(f);
});

test('different yearly instances never merge and colliding child titles do not recursively merge',t=>{
  const f=fixture(t),a=f.create('今年',null,{context:{year:2026}}),b=f.create('明年',null,{context:{year:2027}});
  assert.throws(()=>f.call('projectMerge',{source:f.ref(a.id),target:f.ref(b.id)}),/PROJECT_CONTEXT_CONFLICT/);
  const c=f.create('其他');f.create('报名',a.id);f.create('报名',c.id);
  assert.throws(()=>f.call('projectMerge',{source:f.ref(a.id),target:f.ref(c.id)}),/PROJECT_TITLE_CONFLICT/);assert.equal(f.store.node(a.id).data.mergedInto,null);healthy(f);
});

test('split uses explicit allocations and failure leaves no partial projects',t=>{
  const f=fixture(t),a=f.create('活动'),x=f.call('taskCreate',{title:'报名',projectId:a.id}),y=f.call('taskCreate',{title:'场地',projectId:a.id});
  const parts=[{project:{title:'报名组'},objects:[f.ref(x.id)]},{project:{title:'场地组'},objects:[f.ref(y.id)]}];
  assert.throws(()=>f.call('projectSplit',{...f.ref(a.id),parts:[parts[0],{...parts[1],objects:[f.ref(x.id)]}]}),/PROJECT_SPLIT_OVERLAP/);
  assert.equal(f.store.tree.all().length,1);
  const result=f.call('projectSplit',{...f.ref(a.id),parts});assert.equal(result.projects.length,2);assert.notEqual(f.store.node(x.id).projectId,f.store.node(y.id).projectId);healthy(f);
});

test('remove reports all blockers and generic remove uses the same rules',t=>{
  const f=fixture(t),a=f.create('活动'),child=f.create('子',a.id),m=f.capture('m',a.id),task=f.call('taskCreate',{title:'任务',projectId:a.id});
  for(const command of ['projectRemove','remove'])assert.throws(()=>f.call(command,f.ref(a.id)),error=>error.code==='PROJECT_REMOVE_BLOCKED'&&error.details.children[0].id===child.id&&error.details.objects.length===2);
  assert.equal(f.store.tree.membership(m.id),a.id);assert.equal(f.store.node(task.id).projectId,a.id);
  const empty=f.create('空项目');f.call('projectRemove',f.ref(empty.id));assert.equal(f.store.get('nodes',empty.id),null);healthy(f);
});

test('archival is distinct from deletion and guards open work, then restores normally',t=>{
  const f=fixture(t),a=f.create('活动'),task=f.call('taskCreate',{title:'准备',projectId:a.id});
  assert.throws(()=>f.call('projectArchive',f.ref(a.id)),/PROJECT_HAS_OPEN_WORK/);
  f.call('taskEdit',{...f.ref(task.id),patch:{status:'completed'}});f.call('projectArchive',f.ref(a.id));
  assert.equal(f.store.node(a.id).data.status,'archived');f.call('projectRestore',f.ref(a.id));assert.equal(f.store.node(a.id).data.status,'active');healthy(f);
});

test('capture, tasks, event exceptions, tools, filtering and removal share links exclusively',t=>{
  const f=fixture(t),a=f.create('项目'),b=f.create('另一个'),m=f.capture('m',a.id);
  const task=f.call('taskCreate',{title:'任务',projectId:a.id});
  const tool=f.call('toolSave',{projectId:a.id,definition:{title:'流程',kind:'workflow',steps:[{tool:'assistant_list',args:{kind:'task'}}]}});
  const event=f.call('eventCreate',{title:'周会',projectId:a.id,start:'2026-11-05T09:00:00+08:00',end:'2026-11-05T10:00:00+08:00',timezone:'Asia/Shanghai',recurrence:'FREQ=WEEKLY;COUNT=2'});
  const dates=f.call('calendar',{from:'2026-11-01T00:00:00Z',to:'2026-12-01T00:00:00Z'});
  const changed=f.call('eventOverride',{...f.ref(event.id),occurrence:dates[1].occurrenceKey,patch:{title:'第二次周会'}});assert.equal(f.store.node(changed.id).projectId,a.id);
  for(const id of [m.id,task.id,tool.id,event.id,changed.id])assert.equal(Object.hasOwn(f.store.node(id).data,'projectId'),false);
  f.call('memoryEdit',{...f.ref(m.id),patch:{projectId:b.id}});assert.equal(f.call('list',{kind:'memory',projectId:a.id}).total,0);assert.equal(f.call('list',{kind:'memory',projectId:b.id}).total,1);
  f.call('remove',f.ref(event.id));assert.equal(f.store.tree.links(changed.id).length,0);healthy(f);
});

test('single non-explicit source stays unresolved; two distinct sources may create a root automatically',t=>{
  const f=fixture(t);f.source('one','决定筹备社区运动会报名和签到');
  const first=f.apply('one',[f.none('one')]);assert.equal(first.status,'unresolved');assert.equal(f.store.tree.all().length,0);
  f.source('two','继续筹备社区运动会报名，安排签到流程');
  const decision=f.explicit('two','社区运动会');decision.evidence={basis:'sustained',sources:['one','two'].map(id=>({sourceId:id,quote:f.store.projects.source(id).text}))};
  const result=f.apply('two',[decision]);assert.equal(result.status,'created');assert.equal(f.store.tree.binding('session').projectId,result.projectId);healthy(f);
});

test('replayed or mirrored source text is not a second independent source',t=>{
  const f=fixture(t);f.source('one','计划筹备报名事项');f.source('two','计划筹备报名事项','other');
  const decision=f.explicit('two','报名事项');decision.evidence={basis:'sustained',sources:['one','two'].map(id=>({sourceId:id,quote:f.store.projects.source(id).text}))};
  assert.throws(()=>f.apply('two',[decision]),/PROJECT_MORE_SOURCES_REQUIRED/);assert.equal(f.store.tree.all().length,0);
});

test('explicit request, continuation, child and independent root are separate decisions',t=>{
  const f=fixture(t);f.source('root','新建社区活动项目');const root=f.apply('root',[f.explicit('root','社区活动')]);
  f.source('continue','继续社区活动的报名安排');const continued=f.apply('continue',[f.attach('continue',root.projectId)]);assert.equal(continued.projectId,root.projectId);assert.equal(f.store.tree.all().length,1);
  f.source('child','为社区活动新建独立的报名系统子项目');const child=f.apply('child',[f.explicit('child','报名系统',root.projectId)]);assert.equal(f.store.node(child.projectId).data.parentId,root.projectId);
  f.source('other','另建一个旅行项目');const other=f.apply('other',[f.explicit('other','旅行')]);assert.equal(f.store.node(other.projectId).data.parentId,null);healthy(f);
});

test('multiple matters in one source preserve separate projects and do not bind an ambiguous session',t=>{
  const f=fixture(t);f.source('two','新建旅行项目和读书项目');const result=f.apply('two',[f.explicit('two','旅行'),f.explicit('two','读书')]);
  assert.equal(result.projectIds.length,2);assert.equal(result.projectId,null);assert.equal(f.store.tree.binding('session').projectId,null);healthy(f);
});

test('replay is idempotent, stale catalog plans reject, and human fields survive continuation',t=>{
  const f=fixture(t);f.source('first','新建活动项目');const input={sourceId:'first',snapshot:f.store.projects.snapshot(),plan:{decisions:[f.explicit('first','活动')]},selections:[]};
  const first=f.store.command('same',input,()=>f.store.projects.apply(input));assert.deepEqual(f.store.command('same',input,()=>f.store.projects.apply(input)),first);
  f.source('next','继续活动');const stale={sourceId:'next',snapshot:f.store.projects.snapshot(),plan:{decisions:[f.attach('next',first.projectId)]},selections:[]};
  f.call('projectEdit',{...f.ref(first.projectId),patch:{statement:'人工目标',status:'paused'}});
  assert.throws(()=>f.store.command('stale',stale,()=>f.store.projects.apply(stale)),/STALE_PROJECT_CATALOG/);
  f.apply('next',[f.attach('next',first.projectId)]);assert.equal(f.store.node(first.projectId).data.statement,'人工目标');assert.equal(f.store.node(first.projectId).data.status,'paused');healthy(f);
});

test('bad quotes or inapplicable selected experiences roll back project creation and source progress',t=>{
  const f=fixture(t),old=f.create('历史签到',null,{context:{venue:'indoor'}}),memory=f.capture('experience',old.id,{requirements:{venue:'indoor'}});
  f.source('new','新建户外签到项目');const decision=f.explicit('new','户外签到',null,{context:{venue:'outdoor'}});
  assert.throws(()=>f.apply('new',[decision],[{index:0,memories:[f.ref(memory.id)],captured:[]}]),/STALE_OR_INAPPLICABLE/);
  assert.throws(()=>f.apply('new',[{...decision,quote:'不存在的原话'}]),/QUOTE_NOT_IN_SOURCE/);
  assert.equal(f.store.tree.all().length,1);assert.equal(f.store.projects.result('new'),null);healthy(f);
});

test('captured selection follows relevance, not merely source identity',t=>{
  const f=fixture(t);const related=f.capture('message');const other=f.call('memoryCapture',{sourceId:'message',quote:'签到先准备离线名单',title:'独立偏好',body:'独立偏好',type:'preference',facts:[{subject:'用户',predicate:'偏好',value:'清晨'}],occurredAt:'2026-11-05T10:00:00+08:00',reusable:false});
  const result=f.apply('message',[f.explicit('message','签到')],[{index:0,memories:[],captured:[f.ref(related.id)]}]);
  assert.equal(f.store.node(related.id).projectId,result.projectId);assert.equal(f.store.node(other.id).projectId,null);healthy(f);
});

test('background queue excludes active and incomplete turns and deferral can finish later',async t=>{
  const f=fixture(t);f.source('buffered','新建活动','busy',{status:'buffered'});f.source('idle','新建读书计划','idle');
  assert.deepEqual(f.store.projects.pending(10,['busy']).map(row=>row.id),['idle']);
  f.apply('idle',[f.none('idle','defer')]);assert.equal(f.store.projects.pending(10,[]).length,1);
  f.service.projectModel=async(_schema,prompt,input)=>prompt.includes('每个 index')?{selections:[]}:{decisions:[f.explicit(input.source.id,'读书计划')]};
  assert.equal(await f.lifecycle.drain(Date.now()+60000,['busy'],10),1);assert.equal(f.store.projects.result('idle').status,'created');healthy(f);
});

test('cancellation after model output cannot commit',async t=>{
  const f=fixture(t);f.source('new','新建活动项目');const controller=new AbortController();
  f.service.projectModel=async()=>{controller.abort();return{decisions:[f.explicit('new','活动')]};};
  await assert.rejects(f.lifecycle.resolve('new',Date.now()+60000,controller.signal));assert.equal(f.store.tree.all().length,0);healthy(f);
});

test('failure backoff does not block other sources and failure is visible',async t=>{
  const f=fixture(t);f.source('bad','新建失败事项','bad');f.source('good','新建成功事项','good');
  f.service.projectModel=async(_schema,_prompt,input)=>{if(input.source.id==='bad')throw new Error('MODEL_FAILURE');return{decisions:[f.explicit('good','成功事项')]};};
  assert.equal(await f.lifecycle.drain(Date.now()+60000,[],10),1);
  assert.ok(f.store.projects.decisions('failed').some(row=>row.reason==='MODEL_FAILURE'));assert.deepEqual(f.store.projects.pending().map(row=>row.id),[]);healthy(f);
});

test('transaction crash leaves no project, links, notifications or processed resolution',t=>{
  let fail=false;const f=fixture(t,{fault:stage=>{if(fail&&stage==='before-commit')throw new Error('FAULT');}});
  f.source('new','新建活动');fail=true;assert.throws(()=>f.apply('new',[f.explicit('new','活动')]),/FAULT/);fail=false;
  assert.equal(f.store.tree.all().length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n,0);assert.equal(f.store.projects.result('new'),null);
  assert.equal(f.apply('new',[f.explicit('new','活动')]).status,'created');healthy(f);
});

test('automatic membership executes without confirmation and records a durable tree diff',t=>{
  const f=fixture(t),a=f.create('项目'),m=f.capture('m');
  const result=f.store.projects.maintenanceApply({operations:[{command:'projectAttach',payload:{object:f.ref(m.id),project:f.ref(a.id),reason:'内容属于该项目'}}],unresolved:[]},'membership',f.store.projects.snapshot(),'maintenance');
  assert.equal(result.results[0].status,'applied');assert.equal(f.store.node(m.id).projectId,a.id);
  f.time(START+1000);const window=f.call('reportWindow',{from:START-1});const item=window.items.find(item=>item.metadata?.treeDiff?.objectId===m.id);
  assert.ok(item);const report=f.call('reportSave',{from:window.from,to:window.to,summary:window.summary,items:window.items,body:'整理完成'});
  assert.ok(f.call('reportGet',{id:report.id}).items.some(item=>item.metadata?.treeDiff?.objectId===m.id));healthy(f);
});

test('automatic structure actions execute once and cannot immediately oscillate without new activity',t=>{
  const f=fixture(t),a=f.create('甲'),b=f.create('乙'),child=f.create('子',a.id);
  const first=f.store.projects.maintenanceApply({operations:[{command:'projectMove',payload:{...f.ref(child.id),parent:f.ref(b.id),reason:'明确属于乙'}}],unresolved:[]},'structure',f.store.projects.snapshot(),'move-1');assert.equal(first.results[0].status,'applied');
  const second=f.store.projects.maintenanceApply({operations:[{command:'projectMove',payload:{...f.ref(child.id),parent:f.ref(a.id),reason:'又改变判断'}}],unresolved:[]},'structure',f.store.projects.snapshot(),'move-2');
  assert.equal(second.results[0].error.code,'PROJECT_RECENTLY_ORGANIZED');assert.equal(f.store.node(child.id).data.parentId,b.id);healthy(f);
});

test('automatic archive checks inactivity plus open work, not just the last edit date',t=>{
  const f=fixture(t),a=f.create('旧项目'),b=f.create('有任务');f.call('taskCreate',{title:'未完成',projectId:b.id});f.time(START+100*86400000);
  const result=f.store.projects.maintenanceApply({operations:[a,b].map(row=>({command:'projectArchive',payload:{...f.ref(row.id),reason:'长期无活动'}})),unresolved:[]},'structure',f.store.projects.snapshot(),'archive');
  assert.equal(result.results[0].status,'applied');assert.equal(result.results[1].error.code,'PROJECT_HAS_OPEN_WORK');healthy(f);
});

test('capability gaps are deduplicated, ordinary validation failures are excluded and usage stores shapes',t=>{
  const f=fixture(t),actor={kind:'model',sessionId:'session'};
  for(const key of ['unknown-a','unknown-a','unknown-b'])assert.throws(()=>f.call('missingCommand',{secret:'do-not-store'},actor,key),/UNKNOWN_COMMAND/);
  const gaps=f.call('capabilityGaps');assert.equal(gaps.length,1);assert.equal(gaps[0].occurrences,2);
  assert.throws(()=>f.call('projectCreate',{title:''},actor),/too_small/);assert.equal(f.call('capabilityGaps').length,1);
  const serialized=JSON.stringify(f.store.db.prepare('SELECT * FROM command_usage').all());assert.ok(!serialized.includes('do-not-store'));
  f.call('capabilityProposal',{gapIds:[gaps[0].id],kind:'implementation',title:'新增命令',plan:'实现服务端命令及注册检查'});assert.equal(f.call('capabilityGaps')[0].status,'planned');healthy(f);
});

test('command catalog exposes every project operation and separates internal operations',()=>{
  const catalog=new Map(commandCatalog().map(row=>[row.name,row.definition]));
  for(const name of ['projectCreate','projectTree','projectAttach','projectDetach','projectMove','projectMerge','projectSplit','projectRename','projectArchive','projectRestore','projectRemove','projectAlias','projectBind','projectPreview'])assert.equal(catalog.get(name)?.agent,true,name);
  for(const name of ['snapshotTake','settingsSave','toolActivate'])assert.equal(catalog.get(name)?.agent,false,name);
});

function legacyFixture(t){
  const directory=mkdtempSync(join(tmpdir(),'dsh-v1-fixture-')),old=join(directory,'old'),destination=join(directory,'new');mkdirSync(old);
  writeFileSync(join(old,'manifest.json'),JSON.stringify({format:'dsh-personal-assistant',schemaVersion:1,datasetId:'legacy-owner',createdAt:new Date(START).toISOString()}));
  mkdirSync(join(old,'content'));writeFileSync(join(old,'content','attachment.txt'),'保留附件');
  const db=new DatabaseSync(join(old,'state.sqlite'));db.exec(`PRAGMA user_version=1;CREATE TABLE nodes(id TEXT PRIMARY KEY,kind TEXT,data TEXT,clocks TEXT,revision INTEGER);CREATE TABLE edges(id TEXT PRIMARY KEY,from_id TEXT,to_id TEXT,data TEXT,clocks TEXT,revision INTEGER);CREATE TABLE sources(id TEXT PRIMARY KEY,session_id TEXT,role TEXT,text TEXT,at INTEGER,status TEXT,project_id TEXT);`);
  const node=(id,kind,data)=>db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?)').run(id,kind,JSON.stringify({owner:'legacy-owner',createdAt:START,...data}),'{}',1);
  node('a','project',{title:'年度活动',goal:'保留原目标',domains:['生活'],topics:['签到'],context:{year:2026},status:'active'});
  node('b','project',{title:'年度活动',goal:'下一届',domains:['生活'],topics:['签到'],context:{year:2027},status:'active'});
  node('task','task',{title:'准备任务',projectId:'a',status:'todo',dependsOn:[],importance:3});
  node('memory','memory',{title:'冲突归属',body:'保留内容',projectId:'b',type:'method',reusable:true,requirements:{},facts:[],observations:[],topics:[],domains:[]});
  db.prepare('INSERT INTO edges VALUES(?,?,?,?,?,?)').run('belongs','a','memory',JSON.stringify({kind:'belongs_to'}),'{}',1);
  db.prepare('INSERT INTO edges VALUES(?,?,?,?,?,?)').run('reuses','a','memory',JSON.stringify({kind:'reuses_method'}),'{}',1);
  db.close();t.after(()=>rmSync(directory,{recursive:true,force:true}));return{directory,old,destination};
}

test('v1 is rejected before mutation, migration preserves data and reports conflicts without dual reads',t=>{
  const f=legacyFixture(t),before=readFileSync(join(f.old,'state.sqlite'));
  assert.throws(()=>new Store(f.old),/MIGRATION_REQUIRED/);assert.deepEqual(readFileSync(join(f.old,'state.sqlite')),before);
  const report=migrateDirectory({source:f.old,destination:f.destination});assert.equal(report.objects,4);assert.equal(report.projects,2);
  assert.ok(report.issues.some(issue=>issue.kind==='membership-conflict'));assert.ok(report.issues.some(issue=>issue.kind==='distinct-title'));
  assert.equal(readFileSync(join(f.destination,'content','attachment.txt'),'utf8'),'保留附件');assert.deepEqual(readFileSync(join(f.old,'state.sqlite')),before);
  const store=new Store(f.destination);try{assert.equal(store.node('a').data.statement,'保留原目标');assert.equal(store.node('task').projectId,'a');assert.equal(store.node('memory').projectId,null);assert.equal(store.tree.links('memory')[0].role,'applies_to');assert.equal(store.health().integrity,'ok');}finally{store.close();}
  assert.ok(existsSync(join(f.destination,'legacy','snapshot.json')));assert.equal(report.snapshot.sha256.length,64);
});

test('fresh initialization is explicit and migration never replaces an existing destination',t=>{
  const directory=mkdtempSync(join(tmpdir(),'dsh-fresh-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const destination=join(directory,'new');
  assert.equal(migrateDirectory({destination}).projects,0);assert.throws(()=>migrateDirectory({destination}),/EXPORT_DESTINATION_EXISTS/);
});


test('structural plans expire after descendant and member changes, including removal',t=>{
  const f=fixture(t),root=f.create('根'),child=f.create('子',root.id),target=f.create('目标');
  let rootRef=f.ref(root.id),targetRef=f.ref(target.id);
  f.call('projectRename',{...f.ref(child.id),title:'子项目'});
  assert.throws(()=>f.call('projectMove',{...rootRef,parent:targetRef}),/STALE_VERSION/);
  rootRef=f.ref(root.id);
  const task=f.call('taskCreate',{title:'成员',projectId:child.id});
  assert.throws(()=>f.call('projectMerge',{source:rootRef,target:targetRef}),/STALE_VERSION/);
  rootRef=f.ref(root.id);
  f.call('taskEdit',{...f.ref(task.id),patch:{title:'成员已修改'}});
  assert.throws(()=>f.call('projectMerge',{source:rootRef,target:targetRef}),/STALE_VERSION/);
  rootRef=f.ref(root.id);
  f.call('remove',f.ref(task.id));
  assert.throws(()=>f.call('projectMerge',{source:rootRef,target:targetRef}),/STALE_VERSION/);
  f.call('projectMerge',{source:f.ref(root.id),target:f.ref(target.id)});healthy(f);
});

test('late split failure rolls back previously created parts and moved memberships',t=>{
  const f=fixture(t),root=f.create('活动'),a=f.call('taskCreate',{title:'甲',projectId:root.id}),b=f.call('taskCreate',{title:'乙',projectId:root.id});
  const before=f.call('projectTree'),beforeLinks=f.store.tree.links();
  assert.throws(()=>f.call('projectSplit',{...f.ref(root.id),parts:[
    {project:{title:'同名组'},objects:[f.ref(a.id)]},{project:{title:'同名组'},objects:[f.ref(b.id)]},
  ]}),/PROJECT_TITLE_CONFLICT/);
  assert.deepEqual(f.call('projectTree'),before);assert.deepEqual(f.store.tree.links(),beforeLinks);healthy(f);
});

test('reports retain every decision and gap in the window, independent of list page sizes',t=>{
  const f=fixture(t);
  for(let i=0;i<125;i++){
    f.call('capabilityGapReport',{kind:'reported',target:'能力-'+i,context:'待补齐'});
    f.store.projects.recordDecision('structure','unresolved','事项-'+i,'事项-'+i,'待补充资料',{i});
  }
  f.time(START+1000);
  const report=f.call('reportWindow',{from:START});
  assert.equal(report.items.filter(item=>item.kind==='capability').length,125);
  assert.equal(report.items.filter(item=>item.action==='unresolved').length,125);
});

test('reading a report does not skip subsequent changes in the next reporting window',t=>{
  const f=fixture(t);f.time(START+1000);
  const window=f.call('reportWindow',{from:START}),saved=f.call('reportSave',{...window,body:'日报'});
  f.time(START+2000);const project=f.create('稍后新增');
  f.time(START+3000);f.call('reportConfirm',{id:saved.id});
  f.time(START+4000);const next=f.call('reportWindow');
  assert.equal(next.from,window.to);assert.ok(next.items.some(item=>item.objectId===project.id));
});

test('membership diff records both old and new paths and detachment clears the destination',t=>{
  const f=fixture(t),a=f.create('甲'),b=f.create('乙'),m=f.capture('m',a.id);
  f.call('projectAttach',{object:f.ref(m.id),project:f.ref(b.id)});
  const moved=f.store.tree.history(START,START+1).filter(row=>row.objectId===m.id&&row.action==='attached').find(row=>row.before.path===f.store.node(a.id).data.path);
  assert.equal(moved.after.path,f.store.node(b.id).data.path);
  f.call('projectDetach',{object:f.ref(m.id),project:f.ref(b.id)});
  const detached=f.store.tree.history(START,START+1).find(row=>row.objectId===m.id&&row.action==='detached');
  assert.equal(detached.before.path,f.store.node(b.id).data.path);assert.equal(detached.after.path,'');healthy(f);
});

test('automatic batches share projects safely, replay exactly and isolate late operation failures',t=>{
  const f=fixture(t),root=f.create('根'),a=f.call('taskCreate',{title:'甲'}),b=f.call('taskCreate',{title:'乙'});
  const plan={operations:[a,b].map(row=>({command:'projectAttach',payload:{object:f.ref(row.id),project:f.ref(root.id)}})),unresolved:[]};
  const snapshot=f.store.projects.snapshot();
  const result=f.store.projects.maintenanceApply(plan,'membership',snapshot,'shared-project');
  assert.deepEqual(result.results.map(row=>row.status),['applied','applied']);
  assert.deepEqual(f.store.projects.maintenanceApply(plan,'membership',snapshot,'shared-project'),result);
  f.time(START+8*86400000);
  const before=f.call('projectTree'),bad={command:'projectSplit',payload:{...f.ref(root.id),parts:[
    {project:{title:'组'},objects:[f.ref(a.id)]},{project:{title:'组'},objects:[f.ref(b.id)]},
  ]}};
  const failed=f.store.projects.maintenanceApply({operations:[bad,{command:'projectRename',payload:{...f.ref(root.id),title:'根已更新'}}],unresolved:[]},'structure',f.store.projects.snapshot(),'isolated-failure');
  assert.deepEqual(failed.results.map(row=>row.status),['failed','applied']);
  assert.equal(f.store.tree.all().length,before.items.length);assert.equal(f.store.tree.membership(a.id),root.id);assert.equal(f.store.tree.membership(b.id),root.id);healthy(f);
});


test('report object changes are counted once and deleted objects retain their final state',t=>{
  const f=fixture(t),a=f.call('taskCreate',{title:'保留任务'}),b=f.call('taskCreate',{title:'删除任务'});
  f.call('taskEdit',{...f.ref(a.id),patch:{title:'更新后的任务'}});
  f.call('remove',f.ref(b.id));f.time(START+1000);
  const report=f.call('reportWindow',{from:START});
  assert.equal(report.items.filter(item=>item.objectId===a.id).length,1);
  const removed=report.items.filter(item=>item.objectId===b.id);assert.equal(removed.length,1);assert.equal(removed[0].action,'removed');
  assert.ok(!report.items.some(item=>item.title==='task.created'||item.title==='task.updated'));healthy(f);
});
