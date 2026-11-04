import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';

const TABLES = new Set(['nodes', 'edges']);
const clone = value => JSON.parse(JSON.stringify(value));
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
const unique = values => [...new Map(values.map(value => [digest(value), value])).values()];
const pairKey = (a, b) => digest([a, b].sort());
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
const requireString = value => { if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT'); return value; };
const earliestObservation = row => Math.min(...row.data.observations.map(o => Date.parse(o.at)));
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const functionWords = new Set('的 地 得 了 着 过 是 在 和 与 及 或 而 也 都 就 又 才 吗 呢 啊 吧 把 被 将 于 从 对 为 以 一个 这个 那个 我 你 他 她 它 我们 你们 他们 a an the and or is are was were of to in on for with'.split(' '));

// Search is intentionally lexical. Structured applicability is checked separately.
export function tokens(text) {
  const normalized = String(text).normalize('NFKC').toLowerCase();
  return [...new Set([...segmenter.segment(normalized)].filter(part => part.isWordLike)
    .map(part => part.segment).filter(term => !functionWords.has(term)))];
}

export class MemoryStore {
  constructor(root, { clock = () => Date.now(), retentionHours = 72, fault = () => {}, codec = { seal: v => v, open: v => v } } = {}) {
    if (!Number.isFinite(retentionHours) || retentionHours <= 0) fail('INVALID_RETENTION');
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(join(root, 'state.sqlite'));
    this.clock = clock;
    this.retentionMs = retentionHours * 3_600_000;
    this.fault = fault;
    this.codec = codec;
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES('revision',0),('clock',0);
      CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        data TEXT NOT NULL, clocks TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS edges(id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
        to_id TEXT NOT NULL REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
        data TEXT NOT NULL, clocks TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS edge_target ON edges(to_id);
      CREATE TABLE IF NOT EXISTS versions(table_name TEXT, id TEXT, revision INTEGER NOT NULL,
        PRIMARY KEY(table_name,id));
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED, terms);
      CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, undo_result TEXT);
      CREATE TABLE IF NOT EXISTS deltas(change_id TEXT REFERENCES changes(id), position INTEGER,
        table_name TEXT NOT NULL, object_id TEXT NOT NULL, before_json TEXT, after_json TEXT,
        after_revision INTEGER NOT NULL, PRIMARY KEY(change_id,position));
      CREATE TABLE IF NOT EXISTS merge_blocks(pair_hash TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL);
    `);
    this.purgeExpired();
  }

  close() { this.db.close(); }
  now() {
    const now = this.clock();
    if (!Number.isFinite(now)) fail('INVALID_CLOCK');
    const high = this.db.prepare("SELECT value FROM meta WHERE key='clock'").get().value;
    const effective = Math.max(high, now);
    this.db.prepare("UPDATE meta SET value=? WHERE key='clock'").run(effective);
    return effective;
  }

  command(key, payload, execute) {
    requireString(key);
    const fingerprint = digest(payload);
    const outer = !this.db.isTransaction;
    if (outer) this.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const prior = this.db.prepare('SELECT * FROM requests WHERE key=?').get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail('REQUEST_KEY_REUSED');
        if (outer) this.db.exec('COMMIT'); committed = true;
        return JSON.parse(prior.result);
      }
      const result = execute();
      if (this.db.prepare('PRAGMA foreign_key_check').all().length) fail('BROKEN_REFERENCE');
      this.db.prepare('INSERT INTO requests VALUES(?,?,?)').run(key, fingerprint, JSON.stringify(result));
      if (outer) this.fault('before-commit');
      if (outer) this.db.exec('COMMIT'); committed = true;
      if (outer) this.fault('after-commit');
      return result;
    } catch (error) {
      if (!committed && outer) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  get(table, id) {
    if (!TABLES.has(table)) fail('INVALID_TABLE');
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!row) return null;
    const data = JSON.parse(row.data);
    if (table === 'edges') Object.assign(data, { from: row.from_id, to: row.to_id });
    return { id, kind: row.kind ?? 'edge', data, clocks: JSON.parse(row.clocks), revision: row.revision };
  }

  all(table) {
    if (!TABLES.has(table)) fail('INVALID_TABLE');
    return this.db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(row => this.get(table, row.id));
  }

  version(table, id) {
    return this.db.prepare('SELECT revision FROM versions WHERE table_name=? AND id=?').get(table, id)?.revision ?? 0;
  }

  put(table, id, kind, data, touched = []) {
    if (!TABLES.has(table)) fail('INVALID_TABLE');
    const before = this.get(table, id);
    const revision = this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision' RETURNING value").get().value;
    const clocks = { ...before?.clocks };
    for (const field of new Set([...Object.keys(before?.data ?? {}), ...Object.keys(data ?? {}), ...touched])) {
      if (!equal(before?.data[field], data?.[field]) || touched.includes(field)) clocks[field] = revision;
    }
    this.db.prepare('INSERT OR REPLACE INTO versions VALUES(?,?,?)').run(table, id, revision);
    if (data === null) {
      this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
    } else if (table === 'nodes') {
      this.db.prepare('INSERT OR REPLACE INTO nodes VALUES(?,?,?,?,?)')
        .run(id, kind, JSON.stringify(data), JSON.stringify(clocks), revision);
    } else {
      const { from, to, ...rest } = data;
      this.db.prepare('INSERT OR REPLACE INTO edges VALUES(?,?,?,?,?,?)')
        .run(id, from, to, JSON.stringify(rest), JSON.stringify(clocks), revision);
    }
    if (table === 'nodes') {
      this.db.prepare('DELETE FROM memory_search WHERE id=?').run(id);
      if (data && kind === 'memory') this.db.prepare('INSERT INTO memory_search VALUES(?,?)')
        .run(id, tokens([data.title, data.body, JSON.stringify(data.derivedDirty ? [] : data.facts ?? []), JSON.stringify(data.derivedDirty || data.manualFields?.includes('body') ? [] : data.originalClaims ?? []), ...(data.topics ?? [])].join(' ')).join(' '));
    }
    return { record: this.get(table, id), revision };
  }

  createProject(data, key) {
    requireString(data.title); requireString(data.owner);
    if (!Array.isArray(data.domains) || !data.context || typeof data.context !== 'object') fail('INVALID_INPUT');
    return this.command(key, { action: 'create-project', data }, () => {
      const id = randomUUID();
      this.put('nodes', id, 'project', { ...clone(data), createdAt: this.now() });
      return { id };
    });
  }

  captureMemory(data, key) {
    requireString(data.owner); requireString(data.body); requireString(data.title);
    const fields = new Set(['owner', 'body', 'title', 'type', 'facts', 'observations', 'topics', 'visibility',
      'pinned', 'protected', 'requirements', 'validFrom', 'validTo', 'coverage', 'notes', 'importance', 'reusable', 'domains', 'timePrecision', 'originalClaims', 'canonicalFacts', 'derivedDirty']);
    if (Object.keys(data).some(k => !fields.has(k))) fail('UNKNOWN_MEMORY_FIELD');
    if (!Array.isArray(data.facts) || !Array.isArray(data.observations) || !data.observations.length) fail('INVALID_INPUT');
    if (!data.facts.every(f => ['subject', 'predicate', 'value'].every(k => typeof f[k] === 'string'))) fail('INVALID_FACT');
    if (!data.observations.every(o => typeof o.sourceId === 'string' && Number.isFinite(Date.parse(o.at)))) fail('INVALID_TIME');
    for (const field of ['validFrom', 'validTo']) if (data[field] != null && !Number.isFinite(Date.parse(data[field]))) fail('INVALID_TIME');
    if (data.validFrom && data.validTo && Date.parse(data.validFrom) >= Date.parse(data.validTo)) fail('INVALID_TIME_RANGE');
    return this.command(key, { action: 'capture', data }, () => {
      const id = randomUUID();
      this.put('nodes', id, 'memory', { visibility: 'personal', manualFields: [], pinned: false,
        protected: false, requirements: {}, validFrom: null, validTo: null, ...clone(data),
        observations: data.observations.map(o => ({ ...clone(o), recordedAt: o.recordedAt ?? new Date(this.now()).toISOString() })) });
      return { id };
    });
  }

  link(from, to, kind, key) {
    return this.command(key, { action: 'link', from, to, kind }, () => {
      const a = this.get('nodes', from); const b = this.get('nodes', to);
      if (!a || !b || a.data.owner !== b.data.owner) fail('INVALID_REFERENCE');
      const found = this.all('edges').find(e => e.data.from === from && e.data.to === to && e.data.kind === kind);
      if (found) return { id: found.id };
      const id = randomUUID(); this.put('edges', id, 'edge', { from, to, kind }); return { id };
    });
  }

  findRelated(projectId) {
    const project = this.get('nodes', projectId);
    if (project?.kind !== 'project') fail('PROJECT_NOT_FOUND');
    const query = tokens([project.data.title, project.data.goal, ...(project.data.topics ?? [])].join(' '));
    if (!query.length) return [];
    const expression = query.map(t => `"${t.replaceAll('"', '""')}"`).join(' OR ');
    const now = this.now();
    // Filter identity/applicability BEFORE truncating; unrelated private hits cannot crowd out valid ones.
    return this.db.prepare('SELECT id, bm25(memory_search) AS rank FROM memory_search WHERE memory_search MATCH ? ORDER BY rank,id')
      .all(expression).flatMap(({ id, rank }) => {
        const memory = this.get('nodes', id); const d = memory.data;
        if (d.owner !== project.data.owner || d.visibility !== 'personal') return [];
        if (d.validFrom && Date.parse(d.validFrom) > now || d.validTo && Date.parse(d.validTo) <= now) return [];
        if (Object.entries(d.requirements).some(([k, v]) => !equal(project.data.context[k], v))) return [];
        return [{ id, rank, observations: d.observations, title: d.title,
          matched: query.filter(t => tokens([d.title, d.body, ...(d.topics ?? [])].join(' ')).includes(t)) }];
      }).slice(0, 12);
  }

  associate(projectId, key) {
    return this.command(key, { action: 'associate', projectId }, () => {
      const candidates = this.findRelated(projectId);
      const links = [];
      for (const candidate of candidates) {
        if (this.all('edges').some(e => e.data.from === projectId && e.data.to === candidate.id && e.data.kind === 'reuses_method')) continue;
        const id = randomUUID();
        this.put('edges', id, 'edge', { from: projectId, to: candidate.id, kind: 'reuses_method' });
        links.push(id);
      }
      return { projectId, memoryIds: candidates.map(c => c.id), createdLinks: links.length };
    });
  }

  associateSelected(projectId, versions, key) {
    return this.command(key, { action: 'associate-selected', projectId, versions }, () => {
      const candidates = new Set(this.findRelated(projectId).map(c => c.id));
      const links = [];
      for (const { id, revision } of versions) {
        if (!candidates.has(id)) fail('INAPPLICABLE_MEMORY');
        if (this.get('nodes', id).revision !== revision) fail('STALE_VERSION');
        if (this.all('edges').some(e => e.data.from === projectId && e.data.to === id && e.data.kind === 'reuses_method')) continue;
        const edgeId = randomUUID(); this.put('edges', edgeId, 'edge', { from: projectId, to: id, kind: 'reuses_method' });
        links.push(edgeId);
      }
      return { projectId, memoryIds: versions.map(v => v.id), createdLinks: links.length };
    });
  }

  editMemory(id, patch, expectedRevision, key) {
    const allowed = new Set(['title', 'body', 'notes', 'pinned']);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length
      || Object.keys(patch).some(k => !allowed.has(k))) fail('INVALID_PATCH');
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'pinned' ? typeof v !== 'boolean' : typeof v !== 'string') fail('INVALID_PATCH');
    }
    return this.command(key, { action: 'edit', id, patch, expectedRevision }, () => {
      const row = this.get('nodes', id);
      if (row?.kind !== 'memory') fail('MEMORY_NOT_FOUND');
      if (row.revision !== expectedRevision) fail('STALE_VERSION');
      const manualFields = [...new Set([...row.data.manualFields, ...Object.keys(patch)])].sort();
      this.put('nodes', id, row.kind, { ...row.data, ...patch, manualFields }, Object.keys(patch));
      return { id, revision: this.version('nodes', id) };
    });
  }

  signature(memory) {
    const d = memory.data;
    return digest({ owner: d.owner, visibility: d.visibility, type: d.type,
      facts: [...d.facts].sort((a, b) => digest(a).localeCompare(digest(b))),
      requirements: d.requirements, validFrom: d.validFrom, validTo: d.validTo });
  }

  consolidationEligible(memory, reviews = []) {
    const d = memory.data;
    const reviewed = d.coverage === 'model-extracted' && reviews.some(r => r.id === memory.id && r.revision === memory.revision)
      && d.observations.every(o => typeof o.quote === 'string' && o.quote.length > 0);
    return d.reusable && !d.derivedDirty && ['method', 'fact'].includes(d.type) && (d.coverage === 'verified-structured' || reviewed) && d.facts.length > 0;
  }

  planConsolidation({ reviews = [] } = {}) {
    if (reviews.some(r => this.get('nodes', r.id)?.revision !== r.revision)) fail('STALE_REVIEW');
    const groups = new Map();
    for (const memory of this.all('nodes').filter(n => n.kind === 'memory')) {
      const d = memory.data;
      // Exact normalized structured propositions only. Episode identity is never deduplicated by text.
      if (!this.consolidationEligible(memory, reviews)) continue;
      const signature = this.signature(memory);
      if (!groups.has(signature)) groups.set(signature, []);
      groups.get(signature).push(memory);
    }
    const plan = { groups: [], reviews };
    for (const group of groups.values()) {
      if (group.length < 2 || group.some(n => n.data.pinned || n.data.protected || n.data.manualFields.length || n.data.notes)) continue;
      if (group.some((a, i) => group.slice(i + 1).some(b => this.db.prepare('SELECT 1 FROM merge_blocks WHERE pair_hash=?').get(pairKey(a.id, b.id))))) continue;
      const members = group.sort((a, b) => earliestObservation(a) - earliestObservation(b) || a.id.localeCompare(b.id));
      const ids = members.map(n => n.id);
      const edges = this.all('edges').filter(e => ids.includes(e.data.from) || ids.includes(e.data.to));
      plan.groups.push({ members, edges });
    }
    return clone(plan);
  }

  maintain(key) {
    // The logical request fingerprint stays stable across crash/retry, regardless of regenerated plan.
    return this.command(key, { action: 'maintain' }, () => this.commitPlan(this.planConsolidation()));
  }

  planSemanticConsolidation(proposals) {
    if (!Array.isArray(proposals)) fail('INVALID_PLAN');
    const plan = { groups: [], reviews: [] }, seen = new Set();
    for (const proposal of proposals) {
      const { memories, canonicalFacts } = proposal;
      if (!Array.isArray(memories) || memories.length < 2 || !Array.isArray(canonicalFacts) || !canonicalFacts.length
        || !canonicalFacts.every(f => ['subject', 'predicate', 'value'].every(k => typeof f[k] === 'string' && f[k].trim()))) fail('INVALID_PLAN');
      const members = memories.map(({ id, revision }) => {
        const row = this.get('nodes', id);
        if (!row || row.revision !== revision) fail('STALE_REVIEW');
        if (seen.has(id)) fail('OVERLAPPING_GROUP');
        seen.add(id);
        if (row.kind !== 'memory' || row.data.coverage !== 'model-extracted'
          || !this.consolidationEligible(row, memories)) fail('UNREVIEWABLE_MEMORY');
        if (row.data.pinned || row.data.protected || row.data.manualFields.length || row.data.notes) fail('PROTECTED_MEMORY');
        return row;
      }).sort((a, b) => earliestObservation(a) - earliestObservation(b) || a.id.localeCompare(b.id));
      const normalized = row => this.signature({ ...row, data: { ...row.data, facts: canonicalFacts } });
      if (members.some(m => normalized(m) !== normalized(members[0]))) fail('INCOMPATIBLE_CONTEXT');
      if (members.some((a, i) => members.slice(i + 1).some(b => this.db.prepare('SELECT 1 FROM merge_blocks WHERE pair_hash=?').get(pairKey(a.id, b.id))))) fail('MERGE_PREVIOUSLY_UNDONE');
      const ids = members.map(m => m.id);
      plan.groups.push({ members, canonicalFacts,
        edges: this.all('edges').filter(e => ids.includes(e.data.from) || ids.includes(e.data.to)) });
      plan.reviews.push(...memories);
    }
    return clone(plan);
  }

  applyPlan(plan, key) {
    return this.command(key, { action: 'apply-plan', plan }, () => this.commitPlan(plan));
  }

  commitPlan(plan) {
    const now = this.now(); const changeId = randomUUID();
    const mutations = new Map(); const pairs = [];
    const mutate = (table, before, data) => mutations.set(`${table}/${before.id}`, { table, before, data });
    const replacements = new Map();
    for (const { members, edges, canonicalFacts } of plan.groups) {
      if (members.length < 2) fail('INVALID_PLAN');
      const ids = members.map(m => m.id);
      for (const before of [...members, ...edges]) {
        const table = before.kind === 'edge' ? 'edges' : 'nodes';
        if (!equal(this.get(table, before.id), before)) fail('STALE_PLAN');
      }
      const currentEdges = this.all('edges').filter(e => ids.includes(e.data.from) || ids.includes(e.data.to));
      if (!equal(currentEdges, edges)) fail('STALE_GRAPH');
      const [survivor, ...duplicates] = members;
      const signature = n => this.signature(canonicalFacts ? { ...n, data: { ...n.data, facts: canonicalFacts } } : n);
      if (members.some(n => signature(n) !== signature(survivor) || !['method', 'fact'].includes(n.data.type)
        || !this.consolidationEligible(n, plan.reviews) || n.data.pinned || n.data.protected || n.data.manualFields.length || n.data.notes)) fail('INVALID_PLAN');
      const facts = canonicalFacts ?? survivor.data.facts;
      const data = { ...survivor.data, facts: unique(members.flatMap(n => n.data.facts)), canonicalFacts: facts,
        originalClaims: unique(members.flatMap(n => n.data.originalClaims ?? [])),
        body: facts.map(f => `${f.subject}：${f.predicate} ${f.value}`).join('；'),
        observations: unique(members.flatMap(n => n.data.observations)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.sourceId.localeCompare(b.sourceId)),
        topics: [...new Set(members.flatMap(n => n.data.topics ?? []))].sort() };
      mutate('nodes', survivor, data);
      for (const duplicate of duplicates) {
        replacements.set(duplicate.id, survivor.id);
        mutate('nodes', duplicate, null);
      }
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push(pairKey(ids[i], ids[j]));
    }
    // Build the complete final edge set across all groups before writing. This also handles cross-group edges.
    const seen = new Set();
    const rewired = edge => replacements.has(edge.data.from) || replacements.has(edge.data.to);
    for (const edge of this.all('edges').sort((a, b) => Number(rewired(a)) - Number(rewired(b)))) {
      const data = { ...edge.data, from: replacements.get(edge.data.from) ?? edge.data.from, to: replacements.get(edge.data.to) ?? edge.data.to };
      const identity = digest(data);
      if (seen.has(identity) && (replacements.has(edge.data.from) || replacements.has(edge.data.to))) mutate('edges', edge, null);
      else { seen.add(identity); if (!equal(data, edge.data)) mutate('edges', edge, data); }
    }
    if (!mutations.size) return { changeId: null, groups: 0, changedObjects: 0 };
    const summary = { groups: plan.groups.length, changedObjects: mutations.size, pairs, reviews: plan.reviews ?? [] };
    this.db.prepare('INSERT INTO changes(id,created_at,expires_at,status,summary) VALUES(?,?,?,?,?)')
      .run(changeId, now, now + this.retentionMs, 'applied', JSON.stringify(summary));
    let position = 0;
    for (const { table, before, data } of mutations.values()) {
      const after = this.put(table, before.id, before.kind, data);
      this.db.prepare('INSERT INTO deltas VALUES(?,?,?,?,?,?,?)').run(changeId, position++, table, before.id,
        this.codec.seal(JSON.stringify(before)), after.record ? this.codec.seal(JSON.stringify(after.record)) : null, after.revision);
      this.fault('after-mutation');
    }
    const result = { changeId, groups: summary.groups, changedObjects: summary.changedObjects, expiresAt: now + this.retentionMs };
    this.db.prepare('INSERT INTO outbox VALUES(?,?,?)').run(changeId, 'maintenance.completed', JSON.stringify(result));
    return result;
  }

  change(id) {
    const row = this.db.prepare('SELECT * FROM changes WHERE id=?').get(id);
    if (!row) fail('CHANGE_NOT_FOUND');
    return { id, createdAt: row.created_at, expiresAt: row.expires_at, status: row.status,
      summary: JSON.parse(row.summary), undoResult: row.undo_result ? JSON.parse(row.undo_result) : null };
  }

  rollbackItems(id) {
    const change = this.change(id);
    if (this.now() >= change.expiresAt) fail('UNDO_EXPIRED');
    return this.db.prepare('SELECT * FROM deltas WHERE change_id=? ORDER BY position').all(id).map(row => ({ ...row, before_json: this.codec.open(row.before_json), after_json: row.after_json ? this.codec.open(row.after_json) : null }));
  }

  undo(id, key) {
    return this.command(key, { action: 'undo', id }, () => {
      const change = this.change(id);
      if (change.undoResult) return change.undoResult;
      const deltas = this.rollbackItems(id);
      const result = { changeId: id, restoredFields: 0, restoredObjects: 0, preserved: [] };
      for (const delta of deltas) {
        const before = JSON.parse(delta.before_json);
        const after = delta.after_json ? JSON.parse(delta.after_json) : null;
        const current = this.get(delta.table_name, delta.object_id);
        if (!before) {
          if (current && current.revision === delta.after_revision && (this.canRemoveCreated?.(delta.table_name, delta.object_id, deltas) ?? true)) { this.put(delta.table_name, delta.object_id, current.kind, null); result.restoredObjects++; }
          else if (current) result.preserved.push({ id: delta.object_id, field: '*', reason: 'later-object-change' });
          continue;
        }
        if (!after) {
          if (current || this.version(delta.table_name, delta.object_id) !== delta.after_revision) {
            result.preserved.push({ id: delta.object_id, field: '*', reason: 'later-object-change' }); continue;
          }
          this.put(delta.table_name, before.id, before.kind, before.data);
          result.restoredObjects++; continue;
        }
        if (!current) { result.preserved.push({ id: before.id, field: '*', reason: 'later-deletion' }); continue; }
        const data = clone(current.data); let modified = false;
        for (const field of new Set([...Object.keys(before.data), ...Object.keys(after.data)])) {
          if (equal(before.data[field], after.data[field])) continue;
          if (current.clocks[field] !== after.clocks[field]) {
            result.preserved.push({ id: before.id, field, reason: 'later-field-edit' }); continue;
          }
          if (Object.hasOwn(before.data, field)) data[field] = before.data[field]; else delete data[field];
          modified = true; result.restoredFields++;
        }
        if (modified) this.put(delta.table_name, before.id, before.kind, data);
      }
      // A later edit may have removed an endpoint required by restored relations: atomic failure, never a broken graph.
      if (this.db.prepare('PRAGMA foreign_key_check').all().length) fail('UNDO_DEPENDENCY_CONFLICT');
      for (const pair of change.summary.pairs) this.db.prepare('INSERT OR IGNORE INTO merge_blocks VALUES(?)').run(pair);
      this.db.prepare('UPDATE changes SET status=?,undo_result=? WHERE id=?')
        .run(result.preserved.length ? 'undone-with-preserved-edits' : 'undone', JSON.stringify(result), id);
      this.db.prepare('INSERT INTO outbox VALUES(?,?,?)').run(`undo:${id}`, 'maintenance.undone', JSON.stringify(result));
      return result;
    });
  }

  purgeExpired() {
    this.db.exec('BEGIN IMMEDIATE');
    let count;
    try {
      const now = this.now();
      count = this.db.prepare('DELETE FROM deltas WHERE change_id IN (SELECT id FROM changes WHERE expires_at<=?)').run(now).changes;
      this.db.prepare("UPDATE changes SET status='expired' WHERE expires_at<=?").run(now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { purgedItems: count };
  }

  inspect() {
    return { integrity: this.db.prepare('PRAGMA integrity_check').get().integrity_check,
      foreignKeyErrors: this.db.prepare('PRAGMA foreign_key_check').all().length,
      nodes: this.all('nodes'), edges: this.all('edges'),
      changes: this.db.prepare('SELECT id FROM changes ORDER BY created_at,id').all().map(r => this.change(r.id)),
      rollbackItems: this.db.prepare('SELECT count(*) AS count FROM deltas').get().count,
      outbox: this.db.prepare('SELECT * FROM outbox ORDER BY id').all().map(r => ({ ...r, payload: JSON.parse(r.payload) })) };
  }
}
