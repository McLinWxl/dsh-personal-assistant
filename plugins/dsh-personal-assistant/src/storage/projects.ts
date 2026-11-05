import {randomUUID} from 'node:crypto';
import {digest, tokens} from './memory-base.mjs';
import {projectApply, projectMaintenancePlan, type ProjectApplication, type ProjectDecision} from '../domain/projects.js';
import {normalizeProjectName, type ProjectData, type ProjectNode} from '../domain/project-types.js';
import {schemas, type Actor} from '../domain/contracts.js';
import {reject} from '../domain/errors.js';
import type {Store} from './store.js';

interface Source {
  id: string; session_id: string; role: string; text: string; at: number; status: string;
}
interface Resolution {
  status: string; projectId: string | null; projectIds: string[]; changeIds: string[]; title?: string;
}
interface Candidate {
  id: string; revision: number; title: string; body: string;
}
interface PreviewTarget {
  index: number; project: Partial<ProjectData>; existing: ProjectNode | null;
  memories: Candidate[]; captured: Candidate[];
}

export class Projects {
  constructor(private readonly store: Store) {}

  enqueue(source: {id: string; role: string; sessionId: string; projectEligible?: boolean}): void {
    if (source.role !== 'user' || source.sessionId === 'manual') return;
    const ignored = source.projectEligible === false;
    this.store.db.prepare('INSERT OR IGNORE INTO project_resolutions(source_id,status,result) VALUES(?,?,?)')
      .run(source.id, ignored ? 'ignore' : 'pending', ignored ? JSON.stringify({status: 'ignore', projectId: null, projectIds: [], changeIds: []}) : null);
    if (!ignored) this.store.db.prepare("UPDATE project_resolutions SET next_at=0 WHERE status='unresolved'").run();
  }

  pending(limit = 20, busy: string[] = []): Source[] {
    return this.store.db.prepare(`SELECT s.* FROM sources s JOIN project_resolutions p ON p.source_id=s.id
      WHERE p.status IN ('pending','unresolved') AND p.next_at<=? AND s.status!='buffered'
      AND s.session_id NOT IN (${busy.map(() => '?').join(',') || "''"}) ORDER BY s.at,s.id LIMIT ?`)
      .all(this.store.now(), ...busy, limit) as Source[];
  }

  retry(sourceId: string, error: string): {nextAt: number} | undefined {
    const row = this.store.db.prepare("SELECT attempts FROM project_resolutions WHERE source_id=? AND status IN ('pending','unresolved')").get(sourceId);
    if (!row) return;
    const attempts = Number(row.attempts) + 1, nextAt = this.store.now() + Math.min(3600000, 60000 * 2 ** Math.min(attempts - 1, 6));
    this.store.db.prepare('UPDATE project_resolutions SET attempts=?,next_at=?,last_error=? WHERE source_id=?')
      .run(attempts, nextAt, error.slice(0, 500), sourceId);
    this.recordDecision('resolution', 'failed', sourceId, this.source(sourceId).text.slice(0, 80), error, {sourceId});
    this.store.notify('project.failed', {title: '项目识别失败', error, sessionId: this.source(sourceId).session_id}, 'project-failed:' + sourceId);
    return {nextAt};
  }

  source(id: string): Source {
    const source = this.store.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as Source | undefined;
    if (!source || source.role !== 'user' || source.session_id === 'manual') reject('PROJECT_USER_SOURCE_REQUIRED');
    return source;
  }

  snapshot(): string {
    return digest({projects: this.store.tree.all(true).map(row => ({id: row.id, revision: row.revision})),
      bindings: this.store.db.prepare('SELECT session_id,revision FROM session_projects ORDER BY session_id').all()});
  }

  private evidenceStamp(): string {
    return digest({catalog: this.snapshot(), sources: this.store.db.prepare("SELECT COUNT(*) AS n,MAX(at) AS at FROM sources WHERE role='user'").get()});
  }

  result(sourceId: string): Resolution | null {
    const row = this.store.db.prepare('SELECT * FROM project_resolutions WHERE source_id=?').get(sourceId);
    if (!row || row.status === 'pending' || row.status === 'unresolved' && row.catalog !== this.evidenceStamp()) return null;
    const result = JSON.parse(row.result) as Resolution;
    if (row.status === 'unresolved') this.store.db.prepare('UPDATE project_resolutions SET next_at=? WHERE source_id=?').run(this.store.now() + 86400000, sourceId);
    const existing = [...new Set(result.projectIds.flatMap(id => {const row=this.store.get('nodes',id);return row?[row.data.mergedInto??id]:[];}))];
    return digest(existing) === digest(result.projectIds) ? result : {...result, status: existing.length?'reused':'removed', projectIds: existing, projectId: existing.length === 1 ? existing[0] : null};
  }

  inspect(sourceId: string) {
    const source = this.source(sourceId), query = new Set(tokens(source.text) as string[]), binding = this.store.tree.binding(source.session_id);
    const anchor = binding.projectId ? this.store.tree.node(binding.projectId) : null;
    const expression = [...query].map(term => '"' + term.replaceAll('"', '""') + '"').join(' OR ');
    const ranks = new Map<string, number>(expression ? this.store.db.prepare('SELECT id,bm25(project_search) AS rank FROM project_search WHERE project_search MATCH ? ORDER BY rank,id')
      .all(expression).map((row: {id: string; rank: number}) => [row.id, row.rank]) : []);
    const normalized = normalizeProjectName(source.text);
    const projects = this.store.tree.all().map(row => ({id: row.id, revision: row.revision, ...row.data,
      exact: [row.data.key, row.data.path, row.data.title, ...row.data.aliases].some(name => normalizeProjectName(name).length >= 2 && normalized.includes(normalizeProjectName(name))),
      inAnchor: !!anchor && (row.id === anchor.id || row.data.path.startsWith(anchor.data.path + '/')),
      rank: ranks.get(row.id) ?? null,
    })).sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.inAnchor) - Number(a.inAnchor)
      || (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.path.localeCompare(b.path)).slice(0, 60);
    const evidenceSources = (this.store.db.prepare("SELECT s.id,s.text,s.at FROM sources s JOIN project_resolutions p ON p.source_id=s.id WHERE s.role='user' AND p.status!='ignore' ORDER BY s.at DESC LIMIT 300").all() as {id: string; text: string; at: number}[])
      .filter(item => item.id === source.id || (tokens(item.text) as string[]).filter(term => query.has(term)).length >= 2)
      .slice(0, 20).map(item => ({...item, text: item.text.slice(0, 10000)}));
    const background = this.store.db.prepare("SELECT id,text FROM sources WHERE session_id=? AND id!=? AND at<=? AND role='user' ORDER BY at DESC,id DESC LIMIT 3").all(source.session_id, source.id, source.at);
    return {source, snapshot: this.snapshot(), projects, anchor, binding, evidenceSources, background, result: this.result(sourceId)};
  }

  private validate(source: Source, decision: ProjectDecision): {project: Partial<ProjectData>; existing: ProjectNode | null} | null {
    if (!source.text.includes(decision.quote)) reject('QUOTE_NOT_IN_SOURCE');
    if (decision.action === 'none') return null;
    if (decision.action === 'attach') {
      const existing = this.store.tree.node(decision.target.id, decision.target.revision);
      if (existing.data.status === 'archived') reject('PROJECT_ARCHIVED');
      return {project: existing.data, existing};
    }
    const parent = decision.action === 'create_child' ? decision.parent : null;
    const input = schemas.projectCreate.parse({...decision.project, parent, evidence: decision.evidence, reason: decision.reason, confidence: decision.confidence});
    this.store.tree.validateEvidence(input, {kind: 'model', sourceId: source.id, sessionId: source.session_id});
    if (parent) this.store.tree.node(parent.id, parent.revision);
    return {project: decision.project, existing: null};
  }

  preview(raw: unknown): {result?: Resolution; targets: PreviewTarget[]} {
    const input = projectApply.parse(raw), previous = this.result(input.sourceId);
    if (previous) return {result: previous, targets: []};
    const source = this.source(input.sourceId);
    if (input.snapshot !== this.snapshot()) reject('STALE_PROJECT_CATALOG');
    const targets: PreviewTarget[] = [];
    for (const [index, decision] of input.plan.decisions.entries()) {
      const validated = this.validate(source, decision);
      if (!validated) continue;
      const project = validated.project;
      const memories = this.store.search({query: [project.title, project.statement, ...(project.topics ?? [])].join(' '), purpose: 'personal', limit: 100})
        .filter((hit: {id: string}) => {
          const data = this.store.node(hit.id, 'memory').data;
          return data.reusable && !data.derivedDirty && ['method','fact'].includes(data.type)
            && Object.entries(data.requirements).every(([key, value]) => digest(project.context?.[key] ?? null) === digest(value))
            && !data.observations.some((observation: {sourceId: string}) => observation.sourceId === source.id);
        }).slice(0, 12) as Candidate[];
      const captured = this.store.rows('memory').filter((row: {data: {observations: {sourceId: string}[]}}) => row.data.observations.some(observation => observation.sourceId === source.id))
        .slice(0, 30).map((row: {id: string; revision: number; data: {title: string; body: string}}) => ({id: row.id, revision: row.revision, title: row.data.title, body: row.data.body}));
      targets.push({index, ...validated, memories, captured});
    }
    const selected = new Set<string>();
    for (const selection of input.selections) {
      const target = targets.find(item => item.index === selection.index);
      if (!target) reject('PROJECT_SELECTION_INVALID');
      for (const ref of selection.memories) if (!target.memories.some(item => item.id === ref.id && item.revision === ref.revision)) reject('STALE_OR_INAPPLICABLE_EXPERIENCE');
      for (const ref of selection.captured) {
        if (!target.captured.some(item => item.id === ref.id && item.revision === ref.revision)) reject('STALE_OR_UNRELATED_CAPTURE');
        if (selected.has(ref.id)) reject('PROJECT_MEMBERSHIP_AMBIGUOUS', {id: ref.id});
        selected.add(ref.id);
      }
    }
    return {targets};
  }

  apply(raw: unknown): Resolution {
    const input: ProjectApplication = projectApply.parse(raw), preview = this.preview(input);
    if (preview.result) return preview.result;
    const source = this.source(input.sourceId), changeIds: string[] = [], projectIds: string[] = [];
    let created = false, unresolved = false, deferred = false;
    for (const [index, decision] of input.plan.decisions.entries()) {
      if (decision.action === 'none') {
        unresolved ||= decision.disposition === 'unresolved'; deferred ||= decision.disposition === 'defer';
        if (decision.disposition === 'unresolved') this.recordDecision('resolution', 'unresolved', source.id, decision.quote.slice(0, 80), decision.reason, decision);
        continue;
      }
      const target = preview.targets.find(item => item.index === index)!;
      let projectId = target.existing?.id;
      if (!projectId && decision.action !== 'attach') {
        const result = this.store.tree.create(schemas.projectCreate.parse({...decision.project, parent: decision.action === 'create_child' ? decision.parent : null,
          evidence: decision.evidence, reason: decision.reason, confidence: decision.confidence}), {kind: 'model', sourceId: source.id, sessionId: source.session_id});
        projectId = String(result.id); if (result.changeId) changeIds.push(result.changeId); created = true;
      }
      if (!projectId) reject('PROJECT_DECISION_INVALID');
      projectIds.push(projectId);
      const selection = input.selections.find(item => item.index === index);
      for (const [role, refs] of [['applies_to', selection?.memories ?? []], ['contains', selection?.captured ?? []]] as const) {
        for (const ref of refs) {
          const result = this.store.tree.attach({object: {id: ref.id, revision: this.store.node(ref.id).revision},
            project: {id: projectId, revision: this.store.tree.node(projectId).revision}, role,
            reason: decision.reason, confidence: decision.confidence}, {kind: 'model', sourceId: source.id});
          if (result.changeId) changeIds.push(result.changeId);
        }
      }
      this.store.db.prepare('INSERT OR IGNORE INTO source_projects VALUES(?,?)').run(source.id, projectId);
      this.recordDecision('resolution', 'applied', source.id, this.store.tree.node(projectId).data.title, decision.reason, decision, changeIds.at(-1));
    }
    const unique = [...new Set(projectIds)];
    if (unique.length) {
      const binding = this.store.tree.binding(source.session_id), projectId = unique.length === 1 ? unique[0] : null;
      const result = this.store.tree.bind({sessionId: source.session_id, project: projectId ? {id: projectId, revision: this.store.tree.node(projectId).revision} : null,
        expectedRevision: binding.revision, reason: '更新当前会话项目', confidence: 1}, {kind: 'system'});
      if (result.changeId) changeIds.push(result.changeId);
    }
    const result: Resolution = {status: unresolved ? 'unresolved' : deferred ? 'defer' : created ? 'created' : unique.length ? 'reused' : 'ignore',
      projectId: unique.length === 1 ? unique[0] : null, projectIds: unique, changeIds};
    if (result.projectId) result.title = this.store.tree.node(result.projectId).data.title;
    this.store.db.prepare('UPDATE project_resolutions SET status=?,result=?,catalog=?,next_at=?,last_error=NULL WHERE source_id=?')
      .run(deferred ? 'pending' : result.status === 'created' || result.status === 'reused' ? 'resolved' : result.status,
        JSON.stringify(result), this.evidenceStamp(), unresolved ? this.store.now() + 86400000 : 0, source.id);
    this.store.tree.assertIntegrity();
    return result;
  }

  recordDecision(phase: string, status: 'unresolved' | 'failed' | 'applied', subjectId: string, title: string, reason: string, plan: unknown, changeId?: string): void {
    const fingerprint = digest({phase, subjectId, plan}), now = this.store.now();
    this.store.db.prepare(`INSERT INTO project_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(fingerprint)
      DO UPDATE SET status=excluded.status,reason=excluded.reason,change_id=excluded.change_id,updated_at=excluded.updated_at`)
      .run(randomUUID(), fingerprint, phase, status, subjectId, title, reason, JSON.stringify(plan), changeId ?? null, now, now);
  }

  decisions(status?: string, limit = 40, window?: {from: number; to: number}): Record<string, unknown>[] {
    const query = window
      ? this.store.db.prepare('SELECT * FROM project_decisions WHERE updated_at>=? AND updated_at<? ORDER BY updated_at,id').all(window.from, window.to)
      : this.store.db.prepare(`SELECT * FROM project_decisions${status ? ' WHERE status=?' : ''} ORDER BY updated_at DESC,id LIMIT ?`)
        .all(...status ? [status, limit] : [limit]);
    return query.map((row: Record<string, unknown>) => ({...row, plan: JSON.parse(String(row.plan))}));
  }

  maintenanceContext(phase: 'structure' | 'membership', limit: number) {
    const projects = this.store.tree.all(), now = this.store.now();
    const offset = Number(this.store.db.prepare('SELECT value FROM settings WHERE key=?').get('project-maintenance-offset:' + phase)?.value ?? 0);
    const objects = this.store.rows().filter((row: {kind: string}) => ['memory','task','event','tool'].includes(row.kind));
    const members = projects.map(project => {
      const own = objects.filter((row: {id: string}) => this.store.tree.membership(row.id) === project.id);
      const lastActivity = Math.max(project.data.updatedAt, ...own.map((row: {data: {updatedAt?: number; createdAt?: number; observations?: {recordedAt: string}[]}}) =>
        Math.max(row.data.updatedAt ?? row.data.createdAt ?? 0, ...(row.data.observations ?? []).map(item => Date.parse(item.recordedAt)).filter(Number.isFinite))));
      return {projectId: project.id, lastActivity, idleDays: Math.floor((now - lastActivity) / 86400000),
        objects: own.slice(0, 100).map((row: {id: string; revision: number; kind: string; data: Record<string, unknown>}) => ({id: row.id, revision: row.revision, kind: row.kind, data: row.data})),
        totalObjects: own.length};
    });
    return {phase, snapshot: this.snapshot(), projects, members,
      objects: phase === 'membership' ? objects.slice(offset, offset + limit) : [],
      offset, totalObjects: objects.length,
      recentChanges: this.store.tree.history(now - 7 * 86400000, now + 1).slice(-60),
      unresolved: this.decisions('unresolved', 20)};
  }

  maintenanceApply(raw: unknown, phase: 'structure' | 'membership', snapshot: string, requestId: string) {
    const plan = projectMaintenancePlan.parse(raw);
    return this.store.command(requestId + ':batch', {phase, snapshot, plan}, () => this.applyMaintenance(plan, phase, snapshot, requestId));
  }

  private applyMaintenance(plan: ReturnType<typeof projectMaintenancePlan.parse>, phase: 'structure' | 'membership', snapshot: string, requestId: string) {
    if (snapshot !== this.snapshot()) reject('STALE_PROJECT_CATALOG');
    const originalVersions = new Map<string, number>(this.store.rows().map((row: {id: string; revision: number}) => [row.id, row.revision]));
    // The worker runs this batch serially. Accept version changes caused by
    // earlier operations in this plan, but never rebase an already stale input.
    const rebase = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rebase);
      if (!value || typeof value !== 'object') return value;
      const row = value as Record<string, unknown>;
      if (typeof row.id === 'string' && typeof row.revision === 'number') {
        if (originalVersions.get(row.id) !== row.revision) reject('STALE_VERSION', {id: row.id});
        return {...Object.fromEntries(Object.entries(row).map(([key, item]) => [key, rebase(item)])), revision: this.store.node(row.id).revision};
      }
      return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, rebase(item)]));
    };
    const results: unknown[] = [];
    for (const [index, operation] of plan.operations.entries()) {
      if (phase === 'membership' && !['projectAttach','projectDetach'].includes(operation.command)) reject('MAINTENANCE_COMMAND_NOT_ALLOWED');
      const payload = operation.payload, subject = String(payload.id ?? (payload.source as {id?: string})?.id ?? (payload.object as {id?: string})?.id ?? '');
      try {
        const recent=this.store.db.prepare("SELECT created_at FROM project_changes WHERE object_id=? AND action IN ('moved','merged','split','archived','attached','detached') ORDER BY created_at DESC LIMIT 1").get(subject);
        if(recent&&Number(recent.created_at)>this.store.now()-7*86400000){
          const latest=this.store.db.prepare('SELECT MAX(s.at) AS at FROM source_projects sp JOIN sources s ON s.id=sp.source_id WHERE sp.project_id=?').get(subject);
          const object=this.store.get('nodes',subject);
          const activity=Math.max(Number(latest?.at??0),Number(object?.data.updatedAt??0));
          if(activity<=Number(recent.created_at))reject('PROJECT_RECENTLY_ORGANIZED');
        }
        if (operation.command === 'projectArchive') {
          const context = this.maintenanceContext('structure', 1), member = context.members.find(item => item.projectId === subject);
          if (!member || member.idleDays < 90) reject('PROJECT_STILL_ACTIVE');
        }
        const result = this.store.dispatch(operation.command, rebase(payload), requestId + ':' + index, {kind: 'maintenance'}) as {changeId?: string};
        this.recordDecision(phase, 'applied', subject, this.store.get('nodes', subject)?.data.title ?? subject, String(payload.reason ?? ''), operation, result.changeId);
        results.push({command: operation.command, status: 'applied', ...result});
      } catch (error) {
        const failure = error as Error & {code?: string; details?: unknown};
        this.recordDecision(phase, 'failed', subject, this.store.get('nodes', subject)?.data.title ?? subject, failure.message, operation);
        results.push({command: operation.command, status: 'failed', error: {code: failure.code ?? failure.message, details: failure.details ?? null}});
      }
    }
    for (const item of plan.unresolved) this.recordDecision(phase, 'unresolved', item.subjectId, item.title, item.reason, item);
    return {results};
  }
}
