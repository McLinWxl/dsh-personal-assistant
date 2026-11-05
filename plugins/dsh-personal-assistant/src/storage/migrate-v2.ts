import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  copyFileSync,
  openSync,
  closeSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { join, resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { hostname } from 'node:os';
import { Store } from './store.js';
import { atomicJson, canonicalDestination } from './files.js';
import { normalizeProjectName, type ProjectData } from '../domain/project-types.js';
import { reject } from '../domain/errors.js';

type LegacyRow = Record<string, SQLInputValue>;
interface LegacyNode {
  id: string;
  kind: string;
  data: Record<string, unknown>;
}
interface MigrationIssue {
  kind: string;
  objectId: string;
  detail: string;
  candidates?: string[];
}
export interface MigrationReport {
  format: 'dsh-personal-assistant-migration';
  schemaVersion: 2;
  datasetId: string;
  source: string | null;
  destination: string;
  snapshot: { path: string; sha256: string } | null;
  objects: number;
  projects: number;
  links: number;
  issues: MigrationIssue[];
  completedAt: string;
}

function rows(db: DatabaseSync, table: string): LegacyRow[] {
  if (!/^[a-z_]+$/.test(table)) reject('INVALID_TABLE');
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return [];
  return db.prepare(`SELECT * FROM ${table}`).all() as LegacyRow[];
}

function sourceLock(root: string, datasetId: string): () => void {
  const directory = join(root, 'runtime');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'writer.lock');
  if (existsSync(path)) {
    const old = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; host: string; datasetId: string };
    if (old.datasetId !== datasetId || old.host !== hostname()) reject('DATA_DIRECTORY_LOCKED');
    try {
      process.kill(old.pid, 0);
      reject('DATA_DIRECTORY_LOCKED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    unlinkSync(path);
  }
  const token = randomUUID(),
    fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), datasetId, token }));
  } finally {
    closeSync(fd);
  }
  return () => {
    if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path);
  };
}

function copyFiles(source: string, destination: string, prefix = ''): void {
  const excluded = new Set([
    'runtime',
    'cache',
    'exports',
    'state.sqlite',
    'state.sqlite-wal',
    'state.sqlite-shm',
    'manifest.json',
    'export.json',
    'migration.receipt.json',
  ]);
  for (const name of readdirSync(join(source, prefix))) {
    if (!prefix && excluded.has(name)) continue;
    const rel = join(prefix, name),
      path = join(source, rel),
      output = join(destination, rel),
      info = lstatSync(path);
    if (info.isSymbolicLink()) reject('MIGRATION_SYMLINK', { path: rel });
    if (info.isDirectory()) {
      mkdirSync(output, { recursive: true, mode: 0o700 });
      copyFiles(source, destination, rel);
    } else if (info.isFile()) {
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
      copyFileSync(path, output);
    }
  }
}

function importTables(source: DatabaseSync, store: Store, sourceRoot: string, destination: string): void {
  const tables = [
    'settings',
    'sources',
    'source_context',
    'jobs',
    'runs',
    'tool_versions',
    'tool_usage',
    'conversations',
    'chat_requests',
    'channel_messages',
    'reports',
    'report_items',
    'report_revisions',
    'snapshots',
  ];
  for (const table of tables) {
    const available = new Set(
      store.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column: { name: string }) => column.name),
    );
    for (const original of rows(source, table)) {
      const row = { ...original };
      if (table === 'settings' && String(row.key).startsWith('maintenance-')) continue;
      if (table === 'jobs' && row.status === 'running') {
        row.status = 'scheduled';
        row.lease_until = null;
      }
      if (table === 'runs' && ['queued', 'running'].includes(String(row.status))) row.status = 'unknown';
      if (table === 'channel_messages' && ['processing', 'sending'].includes(String(row.status)))
        row.status = 'unknown';
      if (table === 'snapshots') {
        const rel = relative(sourceRoot, String(row.path));
        if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) continue;
        row.path = join(destination, rel);
      }
      const columns = Object.keys(row).filter((key) => available.has(key));
      if (!columns.length) continue;
      store.db
        .prepare(
          `INSERT OR REPLACE INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        )
        .run(...columns.map((key) => row[key]));
    }
  }
}

function importObjects(source: DatabaseSync, store: Store, issues: MigrationIssue[]): number {
  const nodes = rows(source, 'nodes').map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    data: JSON.parse(String(row.data)),
  })) as LegacyNode[];
  const projectIds = new Set(nodes.filter((row) => row.kind === 'project').map((row) => row.id));
  const nodeIds = new Set(nodes.map((row) => row.id)),
    titles = new Set<string>();
  const aliasClaims = new Map<string, Set<string>>();
  for (const node of nodes.filter((row) => row.kind === 'project')) {
    for (const name of [
      String(node.data.title ?? node.id),
      ...(Array.isArray(node.data.aliases) ? (node.data.aliases as string[]) : []),
    ]) {
      const normalized = normalizeProjectName(name),
        claims = aliasClaims.get(normalized) ?? new Set<string>();
      claims.add(node.id);
      aliasClaims.set(normalized, claims);
    }
  }
  const contains = new Map<string, Set<string>>(),
    applies: { objectId: string; projectId: string }[] = [];
  const addContains = (objectId: string, projectId: string): void => {
    const existing = contains.get(objectId) ?? new Set<string>();
    existing.add(projectId);
    contains.set(objectId, existing);
  };
  for (const node of nodes) {
    const data = { ...node.data, owner: store.owner() } as Record<string, unknown>;
    if (node.kind === 'project') {
      const originalTitle = String(data.title ?? node.id),
        baseTitle = originalTitle.trim() || node.id;
      let title = baseTitle,
        suffix = 1;
      while (titles.has(normalizeProjectName(title))) title = baseTitle + ' (' + ++suffix + ')';
      titles.add(normalizeProjectName(title));
      if (title !== originalTitle)
        issues.push({
          kind: 'distinct-title',
          objectId: node.id,
          detail: `同名事项保留独立身份：${originalTitle} → ${title}`,
        });
      const project: ProjectData = {
        owner: store.owner(),
        key: 'p-' + createHash('sha256').update(node.id).digest('hex').slice(0, 20),
        title,
        statement: String(data.goal ?? ''),
        parentId: null,
        path: '',
        depth: 1,
        status: ['active', 'paused', 'completed', 'archived'].includes(String(data.status))
          ? (data.status as ProjectData['status'])
          : 'active',
        mergedInto: null,
        domains: Array.isArray(data.domains) ? (data.domains as string[]) : [],
        topics: Array.isArray(data.topics) ? (data.topics as string[]) : [],
        context: (data.context as ProjectData['context']) ?? {},
        aliases: [
          ...new Set([
            ...(Array.isArray(data.aliases) ? (data.aliases as string[]) : []),
            ...(title !== originalTitle ? [originalTitle] : []),
          ]),
        ],
        createdAt: Number(data.createdAt ?? store.now()),
        updatedAt: Number(data.updatedAt ?? data.createdAt ?? store.now()),
      };
      project.aliases = project.aliases.filter((alias) => {
        const claims = aliasClaims.get(normalizeProjectName(alias));
        if (!claims || claims.size === 1) return true;
        issues.push({
          kind: 'alias-conflict',
          objectId: node.id,
          detail: `别名 ${alias} 对应多个项目，保留名称并等待重新分配别名。`,
          candidates: [...claims],
        });
        return false;
      });
      project.path = '/' + project.key;
      store.put('nodes', node.id, 'project', project);
      if (/\s[/-]\s/.test(originalTitle))
        issues.push({
          kind: 'hierarchy',
          objectId: node.id,
          detail: '名称包含分组符号，保留为独立项目并交给结构整理判断层级。',
        });
    } else {
      if (typeof data.projectId === 'string' && data.projectId) addContains(node.id, data.projectId);
      delete data.projectId;
      if (node.kind === 'task' && data.status === 'running') data.status = 'needs-review';
      store.put('nodes', node.id, node.kind, data);
    }
  }
  for (const edge of rows(source, 'edges')) {
    const data = JSON.parse(String(edge.data)) as Record<string, unknown>;
    const from = String(edge.from_id),
      to = String(edge.to_id),
      kind = String(data.kind);
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      issues.push({
        kind: 'dangling-relation',
        objectId: String(edge.id),
        detail: '关联端点不存在，原记录保留在快照。',
      });
      continue;
    }
    if (['belongs_to', 'reuses_method'].includes(kind)) {
      const projectId = projectIds.has(from) ? from : projectIds.has(to) ? to : null;
      const objectId = projectId === from ? to : from;
      if (!projectId || projectIds.has(objectId)) {
        issues.push({ kind: 'invalid-membership', objectId, detail: '旧关联无法唯一识别项目与成员。' });
        continue;
      }
      if (kind === 'belongs_to') addContains(objectId, projectId);
      else applies.push({ objectId, projectId });
    } else {
      store.put('edges', String(edge.id), 'edge', { ...data, from, to });
    }
  }
  const importLink = (objectId: string, projectId: string, role: 'contains' | 'applies_to'): void => {
    const object = store.node(objectId),
      project = store.tree.node(projectId);
    if (!['memory', 'task', 'event', 'tool'].includes(object.kind)) reject('PROJECT_OBJECT_KIND_INVALID');
    if (object.kind === 'memory') {
      if (
        Object.entries(object.data.requirements ?? {}).some(
          ([key, value]) => JSON.stringify(project.data.context[key]) !== JSON.stringify(value),
        )
      )
        reject('REQUIREMENT_NOT_IN_PROJECT_CONTEXT');
      if (role === 'applies_to' && (!object.data.reusable || object.data.derivedDirty))
        reject('INAPPLICABLE_MEMORY');
    }
    store.db
      .prepare('INSERT OR IGNORE INTO links VALUES(?,?,?,?,?,?)')
      .run(objectId, projectId, role, 1, 'migration', store.now());
  };
  for (const [objectId, candidates] of contains) {
    if (candidates.size !== 1 || [...candidates].some((id) => !projectIds.has(id))) {
      issues.push({
        kind: 'membership-conflict',
        objectId,
        detail: '旧字段与关联存在分歧，保留对象为未归属。',
        candidates: [...candidates],
      });
      continue;
    }
    const projectId = [...candidates][0];
    try {
      importLink(objectId, projectId, 'contains');
    } catch (error) {
      issues.push({
        kind: 'membership-conflict',
        objectId,
        detail: (error as Error).message,
        candidates: [projectId],
      });
    }
  }
  for (const { objectId, projectId } of applies) {
    try {
      importLink(objectId, projectId, 'applies_to');
    } catch (error) {
      issues.push({
        kind: 'applicability-conflict',
        objectId,
        detail: (error as Error).message,
        candidates: [projectId],
      });
    }
  }
  for (const sourceRow of rows(source, 'sources')) {
    const id = String(sourceRow.id),
      projectId = String(sourceRow.project_id ?? '');
    if (projectIds.has(projectId))
      store.db.prepare('INSERT OR IGNORE INTO source_projects VALUES(?,?)').run(id, projectId);
  }
  const oldResolutions = new Map(
    rows(source, 'project_resolutions').map((row) => [String(row.source_id), row]),
  );
  for (const sourceRow of rows(source, 'sources').filter(
    (row) => row.role === 'user' && row.session_id !== 'manual',
  )) {
    const id = String(sourceRow.id),
      old = oldResolutions.get(id),
      projectId = String(old?.project_id ?? sourceRow.project_id ?? '');
    const ids = projectIds.has(projectId) ? [projectId] : [];
    if (ids.length) store.db.prepare('INSERT OR IGNORE INTO source_projects VALUES(?,?)').run(id, projectId);
    const status = ['ignore', 'undone'].includes(String(old?.status))
      ? 'ignore'
      : ids.length
        ? 'resolved'
        : 'pending';
    store.db
      .prepare('INSERT OR REPLACE INTO project_resolutions(source_id,status,result) VALUES(?,?,?)')
      .run(
        id,
        status,
        JSON.stringify({
          status: status === 'resolved' ? 'reused' : status,
          projectId: ids[0] ?? null,
          projectIds: ids,
          changeIds: [],
        }),
      );
  }
  for (const issue of issues)
    store.projects.recordDecision(
      'migration',
      'unresolved',
      issue.objectId,
      store.get('nodes', issue.objectId)?.data.title ?? issue.objectId,
      issue.detail,
      issue,
    );
  return nodes.length;
}

export function migrateDirectory(options: { source?: string; destination: string }): MigrationReport {
  if (!isAbsolute(options.destination) || (options.source && !isAbsolute(options.source)))
    reject('ABSOLUTE_DATA_DIRECTORY_REQUIRED');
  const destination = canonicalDestination(options.destination),
    sourceRoot = options.source ? canonicalDestination(options.source) : null;
  if (existsSync(destination)) reject('EXPORT_DESTINATION_EXISTS');
  if (sourceRoot) {
    const rel = relative(sourceRoot, destination);
    if (!rel || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)))
      reject('MIGRATION_DESTINATION_INSIDE_SOURCE');
  }
  let manifest: { format: string; schemaVersion: number; datasetId: string; createdAt: string } | null = null;
  if (sourceRoot) {
    manifest = JSON.parse(readFileSync(join(sourceRoot, 'manifest.json'), 'utf8'));
    if (manifest?.format !== 'dsh-personal-assistant' || manifest.schemaVersion !== 1)
      reject('MIGRATION_V1_REQUIRED');
    for (const name of ['legacy', 'migration-report.json'])
      if (existsSync(join(sourceRoot, name))) reject('MIGRATION_RESERVED_PATH', { path: name });
  }
  const unlock = sourceRoot ? sourceLock(sourceRoot, manifest!.datasetId) : () => undefined;
  const staging = join(dirname(destination), '.' + randomUUID() + '.dsh-v2');
  let store: Store | undefined, legacy: DatabaseSync | undefined;
  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    let snapshot: MigrationReport['snapshot'] = null;
    if (sourceRoot) {
      mkdirSync(join(staging, 'legacy'), { mode: 0o700 });
      const snapshotPath = join(staging, 'legacy', 'v1.sqlite');
      const original = new DatabaseSync(join(sourceRoot, 'state.sqlite'), { readOnly: true });
      try {
        const version = Number(original.prepare('PRAGMA user_version').get()?.user_version);
        if (version !== 1) reject('MIGRATION_V1_REQUIRED');
        original.prepare('VACUUM INTO ?').run(snapshotPath);
      } finally {
        original.close();
      }
      legacy = new DatabaseSync(snapshotPath, { readOnly: true });
      if (legacy.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
        reject('MIGRATION_SNAPSHOT_INVALID');
      snapshot = {
        path: join(destination, 'legacy', 'v1.sqlite'),
        sha256: createHash('sha256').update(readFileSync(snapshotPath)).digest('hex'),
      };
      copyFiles(sourceRoot, staging);
      atomicJson(join(staging, 'manifest.json'), { ...manifest, schemaVersion: 2 });
    }
    store = new Store(staging);
    const issues: MigrationIssue[] = [];
    let objects = 0;
    if (legacy && sourceRoot) {
      const input = legacy,
        target = store;
      target.command('migration-v2', { snapshot: snapshot!.sha256 }, () => {
        importTables(input, target, sourceRoot, destination);
        objects = importObjects(input, target, issues);
        target.tree.assertIntegrity();
        return { objects, issues: issues.length };
      });
    }
    const health = store.health();
    if (health.integrity !== 'ok' || health.foreignKeys.length) reject('MIGRATION_INTEGRITY_FAILED', health);
    const report: MigrationReport = {
      format: 'dsh-personal-assistant-migration',
      schemaVersion: 2,
      datasetId: store.owner(),
      source: sourceRoot,
      destination,
      snapshot,
      objects,
      projects: store.tree.all().length,
      links: store.tree.links().length,
      issues,
      completedAt: new Date().toISOString(),
    };
    atomicJson(join(staging, 'migration-report.json'), report);
    store.close();
    store = undefined;
    legacy?.close();
    legacy = undefined;
    if (snapshot) {
      chmodSync(join(staging, 'legacy', 'v1.sqlite'), 0o400);
      atomicJson(join(staging, 'legacy', 'snapshot.json'), { ...snapshot, complete: true });
    }
    renameSync(staging, destination);
    return report;
  } finally {
    try {
      store?.close();
    } finally {
      legacy?.close();
      unlock();
    }
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}
