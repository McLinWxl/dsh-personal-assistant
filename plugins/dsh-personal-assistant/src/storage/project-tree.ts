import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  type Actor,
  projectCreateSchema,
  projectOperations,
  schemas,
  validate,
} from '../domain/contracts.js';
import { reject } from '../domain/errors.js';
import {
  normalizeProjectName,
  projectContextsConflict,
  type ProjectData,
  type ProjectNode,
  type ProjectRef,
  type ProjectLink,
  type LinkRole,
  type TreeChange,
} from '../domain/project-types.js';
import { tokens, digest } from './memory-base.mjs';
import type { Store } from './store.js';

type CreateInput = z.infer<typeof projectCreateSchema>;
type CommandInput<K extends keyof typeof schemas> = z.infer<(typeof schemas)[K]>;
type ChangeContext = { reason: string; confidence: number };
type OperationResult = {
  id?: string;
  revision?: number;
  changeId?: string;
  unchanged?: boolean;
  [key: string]: unknown;
};
type ProjectMutation = { id: string; kind?: string; before?: ProjectNode; data: ProjectData | null };

interface ProjectRecord {
  id: string;
  key: string;
  title: string;
  statement: string;
  parent_id: string | null;
  path: string;
  depth: number;
  status: ProjectData['status'];
  merged_into: string | null;
  domains: string;
  topics: string;
  context: string;
  created_at: number;
  updated_at: number;
}

const projectView = (row: ProjectNode): Record<string, unknown> => ({
  id: row.id,
  key: row.data.key,
  title: row.data.title,
  parentId: row.data.parentId,
  path: row.data.path,
  depth: row.data.depth,
  status: row.data.status,
  mergedInto: row.data.mergedInto,
  revision: row.revision,
});

export class ProjectTree {
  constructor(private readonly store: Store) {}

  read(id: string, owner: string): ProjectData | null {
    const row = this.store.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as
      | ProjectRecord
      | undefined;
    if (!row) return null;
    return {
      owner,
      key: row.key,
      title: row.title,
      statement: row.statement,
      parentId: row.parent_id,
      path: row.path,
      depth: row.depth,
      status: row.status,
      mergedInto: row.merged_into,
      domains: JSON.parse(row.domains),
      topics: JSON.parse(row.topics),
      context: JSON.parse(row.context),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      aliases: this.store.db
        .prepare('SELECT alias FROM project_aliases WHERE project_id=? ORDER BY normalized')
        .all(id)
        .map((alias: { alias: string }) => alias.alias),
    };
  }

  write(id: string, data: ProjectData): void {
    this.store.db
      .prepare(
        `INSERT INTO projects
      (id,key,title,title_norm,statement,parent_id,path,depth,status,merged_into,domains,topics,context,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,title_norm=excluded.title_norm,statement=excluded.statement,
      parent_id=excluded.parent_id,path=excluded.path,depth=excluded.depth,status=excluded.status,
      merged_into=excluded.merged_into,domains=excluded.domains,topics=excluded.topics,context=excluded.context,
      updated_at=excluded.updated_at`,
      )
      .run(
        id,
        data.key,
        data.title,
        normalizeProjectName(data.title),
        data.statement,
        data.parentId,
        data.path,
        data.depth,
        data.status,
        data.mergedInto,
        JSON.stringify(data.domains),
        JSON.stringify(data.topics),
        JSON.stringify(data.context),
        data.createdAt,
        data.updatedAt,
      );
    this.store.db.prepare('DELETE FROM project_aliases WHERE project_id=?').run(id);
    for (const alias of data.aliases) {
      const existing = this.store.db
        .prepare('SELECT project_id FROM project_aliases WHERE normalized=?')
        .get(normalizeProjectName(alias));
      if (existing && existing.project_id !== id)
        reject('PROJECT_ALIAS_CONFLICT', { alias, projectId: existing.project_id });
      this.store.db
        .prepare('INSERT OR IGNORE INTO project_aliases VALUES(?,?,?)')
        .run(id, alias, normalizeProjectName(alias));
    }
    this.store.db.prepare('DELETE FROM project_search WHERE id=?').run(id);
    if (!data.mergedInto)
      this.store.db
        .prepare('INSERT INTO project_search VALUES(?,?)')
        .run(id, tokens([data.title, data.statement, ...data.aliases, ...data.topics].join(' ')).join(' '));
  }

  node(id: string, revision?: number, allowMerged = false): ProjectNode {
    const row = this.store.node(id, 'project') as ProjectNode;
    if (!allowMerged && row.data.mergedInto) reject('PROJECT_MERGED', { id, targetId: row.data.mergedInto });
    if (revision !== undefined && row.revision !== revision)
      reject('STALE_VERSION', { id, expected: revision, actual: row.revision });
    return row;
  }

  all(includeMerged = false): ProjectNode[] {
    return this.store.db
      .prepare(
        'SELECT id FROM projects' + (includeMerged ? '' : ' WHERE merged_into IS NULL') + ' ORDER BY path,id',
      )
      .all()
      .map((row: { id: string }) => this.node(row.id, undefined, includeMerged));
  }

  tree(rootId?: string, includeArchived = true): { items: ProjectNode[]; revision: number } {
    const root = rootId ? this.node(rootId) : null;
    const items = this.all().filter(
      (row) =>
        (!root || row.id === root.id || row.data.path.startsWith(root.data.path + '/')) &&
        (includeArchived || row.data.status !== 'archived'),
    );
    return {
      items,
      revision: Number(this.store.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value),
    };
  }

  links(objectId?: string, projectId?: string): ProjectLink[] {
    const conditions: string[] = [],
      args: string[] = [];
    if (objectId) {
      conditions.push('object_id=?');
      args.push(objectId);
    }
    if (projectId) {
      conditions.push('project_id=?');
      args.push(projectId);
    }
    return this.store.db
      .prepare(
        `SELECT object_id AS objectId,project_id AS projectId,role,confidence,
      created_by AS createdBy,created_at AS createdAt FROM links${conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY project_id,object_id,role`,
      )
      .all(...args) as ProjectLink[];
  }

  membership(objectId: string): string | null {
    return (
      this.store.db
        .prepare("SELECT project_id FROM links WHERE object_id=? AND role='contains'")
        .get(objectId)?.project_id ?? null
    );
  }

  // A project version covers its subtree and members, so a reviewed structural
  // plan becomes stale when any affected descendant changes.
  touchProjects(ids: (string | null)[]): void {
    const visited = new Set<string>();
    for (const id of ids) {
      let current = id;
      while (current && !visited.has(current)) {
        visited.add(current);
        const row = this.store.get('nodes', current) as ProjectNode | null;
        if (!row || row.data.mergedInto) break;
        this.store.put('nodes', row.id, 'project', { ...row.data, updatedAt: this.store.now() }, [
          'contents',
        ]);
        current = row.data.parentId;
      }
    }
  }

  binding(sessionId: string): { sessionId: string; projectId: string | null; revision: number } {
    const row = this.store.db.prepare('SELECT * FROM session_projects WHERE session_id=?').get(sessionId);
    return { sessionId, projectId: row?.project_id ?? null, revision: Number(row?.revision ?? 0) };
  }

  private sessionId(input: string | undefined, actor: Actor): string {
    const sessionId = input ?? actor.sessionId;
    if (!sessionId) reject('SESSION_REQUIRED');
    if (['model', 'maintenance'].includes(actor.kind) && sessionId !== actor.sessionId)
      reject('SOURCE_SESSION_MISMATCH');
    return sessionId;
  }

  private parent(ref: ProjectRef | null): ProjectNode | null {
    if (!ref) return null;
    const parent = this.node(ref.id, ref.revision);
    if (parent.data.status === 'archived') reject('PROJECT_ARCHIVED', { id: parent.id });
    return parent;
  }

  private uniqueTitle(title: string, parentId: string | null, except?: string): void {
    const collision = this.store.db
      .prepare(
        `SELECT id,title FROM projects
      WHERE parent_id IS ? AND title_norm=? AND merged_into IS NULL AND id!=?`,
      )
      .get(parentId, normalizeProjectName(title), except ?? '');
    if (collision) reject('PROJECT_TITLE_CONFLICT', { parentId, project: collision });
  }

  validateEvidence(input: CreateInput, actor: Actor): void {
    if (actor.kind === 'ui' || actor.kind === 'system') return;
    if (!input.evidence) reject('PROJECT_EVIDENCE_REQUIRED');
    const identities = new Set<string>();
    for (const ref of input.evidence.sources) {
      const source = this.store.db
        .prepare("SELECT * FROM sources WHERE id=? AND role='user'")
        .get(ref.sourceId);
      if (!source || source.session_id === 'manual' || !source.text.includes(ref.quote))
        reject('QUOTE_NOT_IN_SOURCE', { sourceId: ref.sourceId });
      identities.add(digest(normalizeProjectName(source.text)));
    }
    if (actor.sourceId && !input.evidence.sources.some((source) => source.sourceId === actor.sourceId))
      reject('SOURCE_NOT_IN_CURRENT_TURN');
    if (input.evidence.basis === 'sustained' && identities.size < 2) reject('PROJECT_MORE_SOURCES_REQUIRED');
  }

  private titlePath(path: string, previous: ProjectNode[] = []): string {
    const names = new Map([...this.all(true), ...previous].map(row => [row.data.key, row.data.title]));
    return path.split('/').filter(Boolean).map(key => names.get(key) ?? key).join(' / ');
  }

  private changes(
    changeId: string,
    action: string,
    before: ProjectNode[],
    ids: string[],
    context: ChangeContext,
  ): void {
    const prior = new Map(before.map((row) => [row.id, row]));
    this.touchProjects([
      ...before.map((row) => row.data.parentId),
      ...ids.map((id) => (this.store.get('nodes', id) as ProjectNode | null)?.data.parentId ?? null),
    ]);
    for (const id of new Set([...prior.keys(), ...ids])) {
      const old = prior.get(id),
        next = this.store.get('nodes', id) as ProjectNode | null;
      this.record(
        changeId,
        action,
        id,
        next?.data.title ?? old!.data.title,
        old ? {...projectView(old), titlePath: this.titlePath(old.data.path, before)} : null,
        next
          ? {
              ...projectView(next),
              titlePath: this.titlePath(next.data.path),
              ...(next.data.mergedInto ? { redirectPath: this.node(next.data.mergedInto).data.path,
                redirectTitlePath: this.titlePath(this.node(next.data.mergedInto).data.path) } : {}),
            }
          : null,
        context,
      );
    }
  }

  record(
    changeId: string,
    action: string,
    objectId: string,
    title: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    context: ChangeContext,
  ): void {
    this.store.db
      .prepare('INSERT INTO project_changes VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        changeId,
        action,
        objectId,
        title,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        context.reason,
        context.confidence,
        this.store.now(),
      );
  }

  history(from: number, to: number): TreeChange[] {
    return this.store.db
      .prepare('SELECT * FROM project_changes WHERE created_at>=? AND created_at<? ORDER BY created_at,id')
      .all(from, to)
      .map((row: Record<string, string | number | null>) => ({
        id: String(row.id),
        changeId: String(row.change_id),
        action: String(row.action),
        objectId: String(row.object_id),
        title: String(row.title),
        before: row.before_json ? JSON.parse(String(row.before_json)) : null,
        after: row.after_json ? JSON.parse(String(row.after_json)) : null,
        reason: String(row.reason),
        confidence: Number(row.confidence),
        at: Number(row.created_at),
      }));
  }

  create(input: CreateInput, actor: Actor): OperationResult {
    this.validateEvidence(input, actor);
    const parent = this.parent(input.parent),
      parentId = parent?.id ?? null;
    this.uniqueTitle(input.title, parentId);
    const depth = (parent?.data.depth ?? 0) + 1;
    if (depth > 4) reject('PROJECT_DEPTH_EXCEEDED', { depth });
    const id = randomUUID(),
      key = input.key ?? 'p-' + id.slice(0, 12);
    if (this.store.db.prepare('SELECT 1 FROM projects WHERE key=?').get(key))
      reject('PROJECT_KEY_CONFLICT', { key });
    const now = this.store.now();
    const data: ProjectData = {
      owner: this.store.owner(),
      key,
      title: input.title,
      statement: input.statement,
      parentId,
      path: (parent?.data.path ?? '') + '/' + key,
      depth,
      status: input.status,
      mergedInto: null,
      domains: input.domains,
      topics: input.topics,
      context: input.context,
      aliases: [],
      createdAt: now,
      updatedAt: now,
    };
    const result = this.store.journal('project.created', [{ id, kind: 'project', data }]);
    this.changes(result.changeId, 'created', [], [id], input);
    return { id, revision: this.node(id).revision, key, ...result };
  }

  edit(input: CommandInput<'projectEdit'>): OperationResult {
    const before = this.node(input.id, input.revision),
      patch = input.patch as Partial<ProjectData>;
    if (patch.title) this.uniqueTitle(patch.title, before.data.parentId, before.id);
    if (patch.status === 'archived') this.assertArchivable(before.id);
    const data = { ...before.data, ...patch, updatedAt: this.store.now() };
    if (patch.context) {
      for (const link of this.links(undefined, before.id))
        this.assertApplicable(link.objectId, data, link.role);
    }
    if (
      Object.entries(patch).every(
        ([key, value]) => digest(value) === digest(before.data[key as keyof ProjectData]),
      )
    ) {
      return { id: before.id, revision: before.revision, unchanged: true };
    }
    if (patch.title && normalizeProjectName(patch.title) !== normalizeProjectName(before.data.title)) {
      data.aliases = [...new Set([...data.aliases, before.data.title])];
    }
    const result = this.store.journal('project.updated', [{ id: before.id, before, data }]);
    if (patch.status === 'archived')
      this.store.db
        .prepare(
          'UPDATE session_projects SET project_id=NULL,revision=revision+1,updated_at=? WHERE project_id=?',
        )
        .run(this.store.now(), before.id);
    const action = patch.title
      ? 'renamed'
      : patch.status === 'archived'
        ? 'archived'
        : before.data.status === 'archived' && patch.status
          ? 'restored'
          : 'updated';
    this.changes(result.changeId, action, [before], [before.id], input);
    return { id: before.id, revision: this.node(before.id).revision, ...result };
  }

  private movedRows(row: ProjectNode, parent: ProjectNode | null): ProjectMutation[] {
    if (parent && (parent.id === row.id || parent.data.path.startsWith(row.data.path + '/')))
      reject('PROJECT_CYCLE');
    this.uniqueTitle(row.data.title, parent?.id ?? null, row.id);
    const prefix = (parent?.data.path ?? '') + '/' + row.data.key;
    const delta = (parent?.data.depth ?? 0) + 1 - row.data.depth;
    return this.all()
      .filter((item) => item.id === row.id || item.data.path.startsWith(row.data.path + '/'))
      .map((before) => {
        const depth = before.data.depth + delta;
        if (depth > 4) reject('PROJECT_DEPTH_EXCEEDED', { id: before.id, depth });
        return {
          id: before.id,
          before,
          data: {
            ...before.data,
            parentId: before.id === row.id ? (parent?.id ?? null) : before.data.parentId,
            path: prefix + before.data.path.slice(row.data.path.length),
            depth,
            updatedAt: this.store.now(),
          },
        };
      });
  }

  move(input: CommandInput<'projectMove'>): OperationResult {
    const before = this.node(input.id, input.revision),
      parent = this.parent(input.parent);
    if (before.data.parentId === (parent?.id ?? null))
      return { id: before.id, revision: before.revision, unchanged: true };
    const mutations = this.movedRows(before, parent);
    const result = this.store.journal('project.moved', mutations);
    this.changes(
      result.changeId,
      'moved',
      mutations.map((row) => row.before!),
      mutations.map((row) => row.id),
      input,
    );
    return { id: before.id, revision: this.node(before.id).revision, ...result };
  }

  private assertApplicable(objectId: string, project: ProjectData, role: LinkRole): void {
    const object = this.store.node(objectId);
    if (!['memory', 'task', 'event', 'tool'].includes(object.kind))
      reject('PROJECT_OBJECT_KIND_INVALID', { objectId, kind: object.kind });
    if (object.kind === 'memory') {
      const requirements = object.data.requirements as Record<string, unknown>;
      if (
        Object.entries(requirements).some(
          ([key, value]) => digest(project.context[key] ?? null) !== digest(value),
        )
      ) {
        reject('REQUIREMENT_NOT_IN_PROJECT_CONTEXT', { objectId });
      }
      if (role === 'applies_to' && (!object.data.reusable || object.data.derivedDirty))
        reject('INAPPLICABLE_MEMORY', { objectId });
    }
  }

  attach(input: CommandInput<'projectAttach'>, actor: Actor, remove = false): OperationResult {
    const object = this.store.node(input.object.id);
    if (object.revision !== input.object.revision) reject('STALE_VERSION', { id: object.id });
    const project = this.node(input.project.id, input.project.revision);
    const existing = this.links(object.id).find(
      (link) => link.projectId === project.id && link.role === input.role,
    );
    if (remove ? !existing : !!existing) return { id: object.id, revision: object.revision, unchanged: true };
    if (!remove) {
      if (project.data.status === 'archived') reject('PROJECT_ARCHIVED', { id: project.id });
      this.assertApplicable(object.id, project.data, input.role);
    }
    const beforeLinks = this.links(object.id);
    if (remove)
      this.store.db
        .prepare('DELETE FROM links WHERE object_id=? AND project_id=? AND role=?')
        .run(object.id, project.id, input.role);
    else {
      if (input.role === 'contains')
        this.store.db.prepare("DELETE FROM links WHERE object_id=? AND role='contains'").run(object.id);
      this.store.db
        .prepare('INSERT INTO links VALUES(?,?,?,?,?,?)')
        .run(object.id, project.id, input.role, input.confidence, actor.kind, this.store.now());
    }
    const result = this.store.journal(remove ? 'project.detached' : 'project.attached', [
      { id: object.id, before: object, data: object.data, touched: ['membership'] },
    ]);
    this.touchProjects([...beforeLinks.map((link) => link.projectId), project.id]);
    const afterLinks = this.links(object.id);
    const paths = (links: ProjectLink[]) =>
      links
        .filter((link) => link.role === input.role)
        .map((link) => this.node(link.projectId).data.path)
        .join(', ');
    const titlePaths = (links: ProjectLink[]) => links.filter(link => link.role === input.role)
      .map(link => this.titlePath(this.node(link.projectId).data.path)).join('、');
    this.record(
      result.changeId,
      remove ? 'detached' : 'attached',
      object.id,
      object.data.title,
      { links: beforeLinks, path: paths(beforeLinks), titlePath: titlePaths(beforeLinks) },
      { links: afterLinks, path: paths(afterLinks), titlePath: titlePaths(afterLinks) },
      input,
    );
    return { id: object.id, revision: this.store.node(object.id).revision, ...result };
  }

  merge(input: CommandInput<'projectMerge'>): OperationResult {
    const source = this.node(input.source.id, input.source.revision),
      target = this.node(input.target.id, input.target.revision);
    if (
      source.id === target.id ||
      source.data.path.startsWith(target.data.path + '/') ||
      target.data.path.startsWith(source.data.path + '/')
    )
      reject('PROJECT_MERGE_ANCESTRY');
    if (target.data.status === 'archived') reject('PROJECT_ARCHIVED', { id: target.id });
    if (projectContextsConflict(source.data.context, target.data.context)) reject('PROJECT_CONTEXT_CONFLICT');
    const targetData: ProjectData = {
      ...target.data,
      context: { ...source.data.context, ...target.data.context },
      statement: target.data.statement || source.data.statement,
      domains: [...new Set([...target.data.domains, ...source.data.domains])],
      topics: [...new Set([...target.data.topics, ...source.data.topics])],
      aliases: [
        ...new Set([
          ...target.data.aliases,
          ...source.data.aliases,
          source.data.title,
          source.data.key,
          source.data.path,
        ]),
      ],
      updatedAt: this.store.now(),
    };
    for (const link of [...this.links(undefined, source.id), ...this.links(undefined, target.id)])
      this.assertApplicable(link.objectId, targetData, link.role);
    const descendants = this.all()
      .filter((row) => row.data.parentId === source.id)
      .flatMap((row) => this.movedRows(row, target));
    const mutations: ProjectMutation[] = [
      {
        id: source.id,
        before: source,
        data: {
          ...source.data,
          mergedInto: target.id,
          status: 'archived',
          aliases: [],
          updatedAt: this.store.now(),
        },
      },
      { id: target.id, before: target, data: targetData },
      ...descendants,
      ...this.all(true)
        .filter((row) => row.data.mergedInto === source.id)
        .map((before) => ({
          id: before.id,
          before,
          data: { ...before.data, mergedInto: target.id, updatedAt: this.store.now() },
        })),
    ];
    const affectedObjects = [...new Set(this.links(undefined, source.id).map((link) => link.objectId))].map(
      (id) => this.store.node(id),
    );
    this.store.db
      .prepare('UPDATE OR IGNORE links SET project_id=? WHERE project_id=?')
      .run(target.id, source.id);
    this.store.db.prepare('DELETE FROM links WHERE project_id=?').run(source.id);
    this.store.db
      .prepare('UPDATE OR IGNORE source_projects SET project_id=? WHERE project_id=?')
      .run(target.id, source.id);
    this.store.db.prepare('DELETE FROM source_projects WHERE project_id=?').run(source.id);
    this.store.db
      .prepare('UPDATE session_projects SET project_id=?,revision=revision+1,updated_at=? WHERE project_id=?')
      .run(target.id, this.store.now(), source.id);
    const result = this.store.journal('project.merged', [
      ...mutations,
      ...affectedObjects.map((before) => ({
        id: before.id,
        before,
        data: before.data,
        touched: ['membership'],
      })),
    ]);
    // Generic entity relations retain their meaning while following the surviving identity.
    const edges = this.store.all('edges') as {
      id: string;
      data: { from: string; to: string; kind: string };
    }[];
    const identities = new Set(
      edges
        .filter((edge) => edge.data.from !== source.id && edge.data.to !== source.id)
        .map((edge) => digest(edge.data)),
    );
    for (const edge of edges.filter((row) => row.data.from === source.id || row.data.to === source.id)) {
      const data = {
        ...edge.data,
        from: edge.data.from === source.id ? target.id : edge.data.from,
        to: edge.data.to === source.id ? target.id : edge.data.to,
      };
      if (identities.has(digest(data)) || data.from === data.to)
        this.store.put('edges', edge.id, 'edge', null);
      else {
        identities.add(digest(data));
        this.store.put('edges', edge.id, 'edge', data);
      }
    }
    this.changes(
      result.changeId,
      'merged',
      mutations.map((row) => row.before!),
      mutations.map((row) => row.id),
      input,
    );
    return { id: target.id, revision: this.node(target.id).revision, mergedId: source.id, ...result };
  }

  split(input: CommandInput<'projectSplit'>, actor: Actor): OperationResult {
    const source = this.node(input.id, input.revision),
      used = new Set<string>();
    if (source.data.depth >= 4) reject('PROJECT_DEPTH_EXCEEDED');
    for (const part of input.parts) {
      if (!part.objects.length && !part.children.length) reject('PROJECT_EMPTY_SPLIT');
      for (const ref of [...part.objects, ...part.children]) {
        if (used.has(ref.id)) reject('PROJECT_SPLIT_OVERLAP', { id: ref.id });
        used.add(ref.id);
        if (this.store.node(ref.id).revision !== ref.revision) reject('STALE_VERSION', { id: ref.id });
      }
      for (const ref of part.objects)
        if (this.membership(ref.id) !== source.id) reject('PROJECT_SPLIT_NOT_MEMBER', { id: ref.id });
      for (const ref of part.children)
        if (this.node(ref.id).data.parentId !== source.id) reject('PROJECT_SPLIT_NOT_CHILD', { id: ref.id });
    }
    const created: { id: string; key: string }[] = [],
      changeIds: string[] = [];
    for (const part of input.parts) {
      const result = this.create(
        {
          ...part.project,
          key: part.key,
          parent: { id: source.id, revision: this.node(source.id).revision },
          reason: input.reason,
          confidence: input.confidence,
        },
        { kind: 'system' },
      );
      const id = String(result.id);
      created.push({ id, key: String(result.key) });
      changeIds.push(String(result.changeId));
      for (const object of part.objects) {
        const attached = this.attach(
          { object, project: { id, revision: this.node(id).revision }, role: 'contains', ...input },
          actor,
        );
        if (attached.changeId) changeIds.push(attached.changeId);
      }
      for (const child of part.children) {
        const moved = this.move({
          ...child,
          parent: { id, revision: this.node(id).revision },
          reason: input.reason,
          confidence: input.confidence,
        });
        if (moved.changeId) changeIds.push(moved.changeId);
      }
    }
    const result = this.store.journal('project.split', [
      { id: source.id, before: source, data: { ...source.data, updatedAt: this.store.now() } },
    ]);
    this.changes(result.changeId, 'split', [source], [source.id], input);
    return {
      id: source.id,
      revision: this.node(source.id).revision,
      projects: created,
      changeIds,
      ...result,
    };
  }

  private assertArchivable(id: string): void {
    const children = this.all().filter((row) => row.data.parentId === id && row.data.status !== 'archived');
    const blockers = this.links(undefined, id)
      .filter((link) => link.role === 'contains')
      .flatMap((link) => {
        const object = this.store.node(link.objectId);
        if (object.kind === 'task' && !['completed', 'cancelled'].includes(object.data.status))
          return [{ id: object.id, kind: object.kind, title: object.data.title }];
        if (
          object.kind === 'event' &&
          (object.data.recurrence || Date.parse(object.data.end) > this.store.now())
        )
          return [{ id: object.id, kind: object.kind, title: object.data.title }];
        return [];
      });
    if (children.length || blockers.length)
      reject('PROJECT_HAS_OPEN_WORK', { children: children.map(projectView), objects: blockers });
  }

  remove(input: CommandInput<'projectRemove'>): OperationResult {
    const before = this.node(input.id, input.revision, true);
    const children = this.all(true).filter((row) => row.data.parentId === before.id);
    const objects = this.links(undefined, before.id).map((link) => ({
      ...link,
      title: this.store.node(link.objectId).data.title,
    }));
    const sessions = this.store.db
      .prepare('SELECT session_id AS id FROM session_projects WHERE project_id=?')
      .all(before.id);
    const redirects = this.store.db
      .prepare('SELECT id,title FROM projects WHERE merged_into=?')
      .all(before.id);
    const relations = this.store
      .all('edges')
      .filter(
        (edge: { data: { from: string; to: string } }) =>
          edge.data.from === before.id || edge.data.to === before.id,
      );
    if (children.length || objects.length || sessions.length || redirects.length || relations.length) {
      reject('PROJECT_REMOVE_BLOCKED', {
        children: children.map(projectView),
        objects,
        sessions,
        redirects,
        relations,
      });
    }
    this.store.db.prepare('DELETE FROM source_projects WHERE project_id=?').run(before.id);
    this.store.db.prepare('DELETE FROM project_aliases WHERE project_id=?').run(before.id);
    this.store.db.prepare('DELETE FROM project_search WHERE id=?').run(before.id);
    this.store.db.prepare('DELETE FROM projects WHERE id=?').run(before.id);
    const result = this.store.journal('project.removed', [{ id: before.id, before, data: null }]);
    this.changes(result.changeId, 'removed', [before], [], input);
    return { id: before.id, ...result };
  }

  alias(input: CommandInput<'projectAlias'>): OperationResult {
    const before = this.node(input.id, input.revision),
      normalized = normalizeProjectName(input.alias);
    const aliases = before.data.aliases.filter((alias) => normalizeProjectName(alias) !== normalized);
    if (input.action === 'add') aliases.push(input.alias);
    if (digest(aliases) === digest(before.data.aliases))
      return { id: before.id, revision: before.revision, unchanged: true };
    const result = this.store.journal('project.alias.updated', [
      { id: before.id, before, data: { ...before.data, aliases, updatedAt: this.store.now() } },
    ]);
    this.changes(result.changeId, 'updated', [before], [before.id], input);
    return { id: before.id, revision: this.node(before.id).revision, ...result };
  }

  bind(input: CommandInput<'projectBind'>, actor: Actor): OperationResult {
    const sessionId = this.sessionId(input.sessionId, actor),
      before = this.binding(sessionId);
    if (before.revision !== input.expectedRevision) reject('STALE_SESSION_BINDING', before);
    const project = input.project ? this.node(input.project.id, input.project.revision) : null;
    if (before.projectId === (project?.id ?? null)) return { ...before, unchanged: true };
    if (project?.data.status === 'archived') reject('PROJECT_ARCHIVED', { id: project.id });
    this.store.db
      .prepare(
        `INSERT INTO session_projects VALUES(?,?,?,?) ON CONFLICT(session_id)
      DO UPDATE SET project_id=excluded.project_id,revision=excluded.revision,updated_at=excluded.updated_at`,
      )
      .run(sessionId, project?.id ?? null, before.revision + 1, this.store.now());
    const result = this.store.journal('project.session.bound', []);
    this.record(
      result.changeId,
      'bound',
      sessionId,
      project?.data.title ?? sessionId,
      before,
      this.binding(sessionId),
      input,
    );
    return { ...this.binding(sessionId), ...result };
  }

  execute(command: string, payload: unknown, actor: Actor): OperationResult {
    switch (command) {
      case 'projectCreate':
        return this.create(schemas.projectCreate.parse(payload), actor);
      case 'projectEdit':
        return this.edit(schemas.projectEdit.parse(payload));
      case 'projectRename': {
        const input = schemas.projectRename.parse(payload);
        return this.edit({ ...input, patch: { title: input.title } });
      }
      case 'projectMove':
        return this.move(schemas.projectMove.parse(payload));
      case 'projectMerge':
        return this.merge(schemas.projectMerge.parse(payload));
      case 'projectSplit':
        return this.split(schemas.projectSplit.parse(payload), actor);
      case 'projectArchive': {
        const input = schemas.projectArchive.parse(payload);
        return this.edit({ ...input, patch: { status: 'archived' } });
      }
      case 'projectRestore': {
        const input = schemas.projectRestore.parse(payload);
        return this.edit({ ...input, patch: { status: input.status } });
      }
      case 'projectRemove':
        return this.remove(schemas.projectRemove.parse(payload));
      case 'projectAttach':
        return this.attach(schemas.projectAttach.parse(payload), actor);
      case 'projectDetach':
        return this.attach(schemas.projectDetach.parse(payload), actor, true);
      case 'projectAlias':
        return this.alias(schemas.projectAlias.parse(payload));
      case 'projectBind':
        return this.bind(schemas.projectBind.parse(payload), actor);
      default:
        return reject('UNKNOWN_COMMAND', { command });
    }
  }

  preview(
    input: CommandInput<'projectPreview'>,
    actor: Actor,
  ): { result: OperationResult; changes: TreeChange[] } {
    const payload = validate(input.operation, input.payload);
    const existing = new Set(
      this.store.db
        .prepare('SELECT id FROM project_changes')
        .all()
        .map((row: { id: string }) => row.id),
    );
    this.store.db.exec('SAVEPOINT project_preview');
    try {
      const result = this.execute(input.operation, payload, actor);
      this.assertIntegrity();
      const changes = this.history(0, Number.MAX_SAFE_INTEGER).filter((change) => !existing.has(change.id));
      return { result, changes };
    } finally {
      this.store.db.exec('ROLLBACK TO project_preview; RELEASE project_preview');
    }
  }

  assertIntegrity(): void {
    const rows = this.all(true),
      projects = new Map(rows.map((row) => [row.id, row]));
    for (const row of rows) {
      if (row.data.mergedInto) {
        const target = projects.get(row.data.mergedInto);
        if (!target || target.data.mergedInto || target.id === row.id)
          reject('PROJECT_INVALID_REDIRECT', { id: row.id });
        if (
          this.links(undefined, row.id).length ||
          rows.some((child) => child.data.parentId === row.id && !child.data.mergedInto)
        )
          reject('PROJECT_MERGED_HAS_MEMBERS', { id: row.id });
        continue;
      }
      const seen = new Set([row.id]);
      let ancestor = row.data.parentId;
      while (ancestor) {
        if (seen.has(ancestor)) reject('PROJECT_CYCLE', { id: row.id });
        seen.add(ancestor);
        const parent = projects.get(ancestor);
        if (!parent || parent.data.mergedInto) reject('PROJECT_PARENT_INVALID', { id: row.id });
        ancestor = parent.data.parentId;
      }
      const parent = row.data.parentId ? projects.get(row.data.parentId)! : null;
      if (
        row.data.depth !== (parent?.data.depth ?? 0) + 1 ||
        row.data.path !== (parent?.data.path ?? '') + '/' + row.data.key
      )
        reject('PROJECT_PATH_INVALID', { id: row.id });
    }
    const invalid = this.store.db
      .prepare(
        "SELECT l.object_id FROM links l JOIN nodes n ON n.id=l.object_id WHERE n.kind NOT IN ('memory','task','event','tool')",
      )
      .all();
    if (invalid.length) reject('PROJECT_OBJECT_KIND_INVALID', invalid);
  }

  isOperation(command: string): boolean {
    return (projectOperations as readonly string[]).includes(command);
  }
}
