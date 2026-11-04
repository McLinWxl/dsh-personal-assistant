import {randomUUID} from 'node:crypto';
import {digest, tokens} from './memory-base.mjs';
import {projectApply, projectDecision} from '../domain/projects.js';
import type {Store} from './store.js';

const normalized = (value:string) => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
const conflict = (a:any, b:any) => Object.keys(a).some(k => Object.hasOwn(b, k) && normalized(String(a[k])) !== normalized(String(b[k])));
function fail(message:string):never {throw new Error(message);}

export class Projects {
  constructor(private store:Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS project_resolutions(
      source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending', project_id TEXT, change_id TEXT,
      result TEXT, previous_project_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT);
      CREATE INDEX IF NOT EXISTS project_resolution_status ON project_resolutions(status);
      INSERT OR IGNORE INTO project_resolutions(source_id)
        SELECT id FROM sources WHERE role='user' AND session_id!='manual'
        AND session_id NOT IN (SELECT session_id FROM runs WHERE session_id IS NOT NULL);`);
    const columns=new Set(store.db.prepare('PRAGMA table_info(project_resolutions)').all().map((c:any)=>c.name));
    for(const [name,type]of Object.entries({attempts:'INTEGER NOT NULL DEFAULT 0',next_at:'INTEGER NOT NULL DEFAULT 0',last_error:'TEXT'}))
      if(!columns.has(name))store.db.exec(`ALTER TABLE project_resolutions ADD COLUMN ${name} ${type}`);
  }
  enqueue(source:any) {
    if(source.role==='user' && source.sessionId!=='manual') {
      if(source.projectEligible===false)this.store.db.prepare("INSERT OR IGNORE INTO project_resolutions(source_id,status,result) VALUES(?,'ignore',?)").run(source.id,JSON.stringify({status:'ignore',projectId:null,changeId:null}));
      else this.store.db.prepare('INSERT OR IGNORE INTO project_resolutions(source_id) VALUES(?)').run(source.id);
    }
  }
  pending(limit=20,busy:string[]=[]) {
    return this.store.db.prepare(`SELECT s.*,c.workspace,c.preset FROM sources s
      JOIN project_resolutions p ON p.source_id=s.id LEFT JOIN source_context c ON c.id=s.id
      WHERE p.status='pending' AND p.next_at<=? AND s.status!='buffered'
      AND s.session_id NOT IN (${busy.map(()=>'?').join(',')||"''"}) ORDER BY s.at,s.id LIMIT ?`).all(this.store.now(),...busy,limit);
  }
  retry(sourceId:string,error:string) {
    const row=this.store.db.prepare("SELECT attempts FROM project_resolutions WHERE source_id=? AND status='pending'").get(sourceId);if(!row)return;
    const attempts=Number(row.attempts)+1,nextAt=this.store.now()+Math.min(3600000,60000*2**Math.min(attempts-1,6));
    this.store.db.prepare('UPDATE project_resolutions SET attempts=?,next_at=?,last_error=? WHERE source_id=?').run(attempts,nextAt,String(error).slice(0,500),sourceId);
    this.store.notify('project.failed',{title:'项目识别稍后重试',error:'PROJECT_RETRY_PENDING',sessionId:this.source(sourceId).session_id},'project-failed:'+sourceId);
    return {nextAt};
  }
  source(id:string) {
    const source=this.store.db.prepare('SELECT * FROM sources WHERE id=?').get(id);
    if(!source || source.role!=='user' || source.session_id==='manual') fail('PROJECT_USER_SOURCE_REQUIRED');
    return source;
  }
  result(sourceId:string) {
    const row=this.store.db.prepare('SELECT * FROM project_resolutions WHERE source_id=?').get(sourceId);
    if(!row || row.status==='pending') return null;
    if(row.status==='undone') return {status:'undone',projectId:row.project_id,changeId:row.change_id};
    const result=JSON.parse(row.result);
    if(result.projectId && !this.store.get('nodes',result.projectId)) return {...result,status:'removed'};
    return result;
  }
  snapshot() {return digest(this.store.rows('project').map((p:any)=>({id:p.id,revision:p.revision})));}
  inspect(sourceId:string) {
    const source=this.source(sourceId),query=new Set(tokens(source.text));
    const projects=this.store.rows('project').map((p:any)=>{
      const terms=tokens([p.data.title,p.data.goal,...p.data.topics,...p.data.aliases??[]].join(' '));
      const score=terms.filter((t:string)=>query.has(t)).length;
      return {id:p.id,revision:p.revision,...p.data,score};
    }).sort((a:any,b:any)=>b.score-a.score||b.createdAt-a.createdAt).slice(0,40);
    const background=this.store.db.prepare("SELECT text,project_id FROM sources WHERE session_id=? AND id!=? AND at<=? AND role='user' ORDER BY at DESC,id DESC LIMIT 3").all(source.session_id,source.id,source.at);
    return {source,snapshot:this.snapshot(),projects,background,result:this.result(sourceId)};
  }
  validate(sourceId:string, snapshot:string, input:any) {
    const source=this.source(sourceId),plan=projectDecision.parse(input);
    if(!source.text.includes(plan.quote)||plan.instanceQuote&&!source.text.includes(plan.instanceQuote)) fail('QUOTE_NOT_IN_SOURCE');
    if(snapshot!==this.snapshot()) fail('STALE_PROJECT_CATALOG');
    if(['ignore','review','defer'].includes(plan.decision)) {
      if(plan.project||plan.match) fail('PROJECT_DECISION_INVALID');
      return {source,plan,project:null,existing:null};
    }
    if(['hypothetical','one-off','unclear'].includes(plan.basis)) fail('PROJECT_COMMITMENT_REQUIRED');
    if(plan.decision==='reuse') {
      if(!plan.match||plan.instanceQuote) fail('PROJECT_MATCH_REQUIRED');
      const existing=this.store.node(plan.match.id,'project');
      if(existing.revision!==plan.match.revision) fail('STALE_VERSION');
      if(plan.project&&conflict(plan.project.context,existing.data.context)) fail('PROJECT_CONTEXT_CONFLICT');
      return {source,plan,project:existing.data,existing};
    }
    if(!plan.project||plan.match || !['explicit','committed'].includes(plan.basis)) fail('PROJECT_DECISION_INVALID');
    const title=normalized(plan.project.title),terms=tokens(plan.project.title);
    const exact=this.store.rows('project').some((p:any)=>digest(p.data.context)===digest(plan.project!.context)
      &&([p.data.title,...p.data.aliases??[]].some((name:string)=>normalized(name)===title)
        || plan.project!.goal.length>=8&&normalized(p.data.goal)===normalized(plan.project!.goal)));
    if(exact) fail('PROJECT_MATCH_REQUIRES_REVIEW');
    const similar=this.store.rows('project').filter((p:any)=>{
      if(conflict(plan.project!.context,p.data.context)) return false;
      return [p.data.title,...p.data.aliases??[]].some((name:string)=>{
        if(normalized(name)===title) return true;
        const other=tokens(name),overlap=other.filter((t:string)=>terms.includes(t)).length;
        return overlap>=2&&overlap/Math.max(terms.length,other.length)>=0.75;
      });
    });
    // Similarity suggests a review; it never silently merges distinct projects.
    if(similar.length) fail('PROJECT_MATCH_REQUIRES_REVIEW');
    return {source,plan,project:plan.project,existing:null};
  }
  preview(input:any) {
    const a=projectApply.parse(input),previous=this.result(a.sourceId);
    if(previous) return {result:previous};
    const resolved=this.validate(a.sourceId,a.snapshot,a.plan);
    if(!resolved.project) return {...resolved,memories:[],captured:[]};
    const p=resolved.project,query=[p.title,p.goal,...p.topics].join(' ');
    const memories=this.store.search({query,purpose:'personal',limit:100}).filter((hit:any)=>{
      const row=this.store.node(hit.id,'memory'),d=row.data;
      return d.reusable&&!d.derivedDirty&&['method','fact'].includes(d.type)
        &&Object.entries(d.requirements).every(([k,v])=>JSON.stringify(p.context[k])===JSON.stringify(v))
        &&!d.observations.some((o:any)=>o.sourceId===a.sourceId);
    }).slice(0,12);
    const captured=this.store.rows('memory').filter((m:any)=>m.data.observations.some((o:any)=>o.sourceId===a.sourceId))
      .slice(0,30).map((m:any)=>({id:m.id,revision:m.revision,title:m.data.title,body:m.data.body}));
    return {...resolved,memories,captured};
  }
  apply(input:any) {
    const a=projectApply.parse(input),previous=this.result(a.sourceId);
    if(previous) return previous;
    const preview=this.preview(a);if('result' in preview)return preview.result;
    const {source,plan,project,existing,memories,captured}=preview;
    const selected=new Map(memories.map((m:any)=>[m.id,m]));
    for(const ref of a.memories){const candidate:any=selected.get(ref.id);if(!candidate||candidate.revision!==ref.revision) fail('STALE_OR_INAPPLICABLE_EXPERIENCE');}
    for(const ref of a.captured)if(!captured.some((m:any)=>m.id===ref.id&&m.revision===ref.revision))fail('STALE_OR_UNRELATED_CAPTURE');
    if(!project) {
      const result={status:plan.decision,projectId:null,changeId:null};
      if(plan.decision==='defer')return result;
      this.store.db.prepare('UPDATE project_resolutions SET status=?,result=? WHERE source_id=?').run(plan.decision,JSON.stringify(result),a.sourceId);
      if(plan.decision==='review') this.store.notify('project.review-needed',{title:source.text.slice(0,80),sessionId:source.session_id},'project-review:'+a.sourceId);
      return result;
    }
    const projectId=existing?.id??randomUUID(),mutations:any[]=[];
    if(!existing) mutations.push({id:projectId,kind:'project',data:{...project,aliases:[],owner:this.store.owner(),createdAt:this.store.now()}});
    else if(plan.project&&normalized(plan.project.title)!==normalized(existing.data.title)&&!(existing.data.aliases??[]).includes(plan.project.title)) {
      mutations.push({id:projectId,before:existing,data:{...existing.data,aliases:[...existing.data.aliases??[],plan.project.title].slice(-30)}});
    }
    const edges=this.store.all('edges'),add=(memoryId:string,kind:string)=>{
      if(!edges.some((e:any)=>e.data.from===projectId&&e.data.to===memoryId&&e.data.kind===kind)&&!mutations.some(m=>m.table==='edges'&&m.data.to===memoryId&&m.data.kind===kind))
        mutations.push({id:randomUUID(),table:'edges',kind:'edge',data:{from:projectId,to:memoryId,kind}});
    };
    for(const ref of a.memories) add(ref.id,'reuses_method');
    for(const ref of a.captured)add(ref.id,'belongs_to');
    const change=mutations.length?this.store.journal(existing?'project.recognized':'project.created',mutations):{changeId:null};
    const result={status:existing?'reused':'created',projectId,title:project.title,linkedMemories:a.memories.length,...change};
    this.store.db.prepare('UPDATE project_resolutions SET status=?,project_id=?,change_id=?,result=?,previous_project_id=? WHERE source_id=?')
      .run('resolved',projectId,change.changeId,JSON.stringify(result),source.project_id,a.sourceId);
    this.store.db.prepare('UPDATE sources SET project_id=? WHERE id=?').run(projectId,a.sourceId);
    if(change.changeId){this.store.db.prepare('UPDATE notifications SET payload=? WHERE id=?').run(JSON.stringify(result),change.changeId);
      this.store.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run(JSON.stringify(result),change.changeId);}
    return result;
  }
  undo(changeId:string) {
    for(const row of this.store.db.prepare('SELECT * FROM project_resolutions WHERE change_id=?').all(changeId)) {
      this.store.db.prepare('UPDATE sources SET project_id=? WHERE id=? AND project_id=?').run(row.previous_project_id,row.source_id,row.project_id);
    }
    this.store.db.prepare("UPDATE project_resolutions SET status='undone' WHERE change_id=?").run(changeId);
  }
}
