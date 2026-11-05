import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { ProjectNode, TreeChange } from '../domain/project-types.js';

type Api = <T = unknown>(method: string, payload?: unknown) => Promise<T>;
type Relation = {
  kind: string;
  object: { id: string; kind: string; revision: number; data: { title: string } };
};
interface Props {
  api: Api;
  onChange(): void;
  onOpen(kind: string, id: string): void;
  focusId?: string;
  createNonce?: number;
  onCreateConsumed?(): void;
}
interface ContextField {
  name: string;
  value: string;
  type: 'string' | 'number' | 'boolean';
}
interface ProjectForm {
  title: string;
  statement: string;
  context: ContextField[];
  parentId: string | null;
}
const statuses: Record<string, string> = {
  active: '进行中',
  paused: '暂停',
  completed: '已完成',
  archived: '已归档',
};
const actions: Record<string, string> = {
  created: '新增',
  removed: '删除',
  moved: '移动',
  merged: '合并',
  renamed: '改名',
  updated: '更新',
  split: '拆分',
  archived: '归档',
  restored: '恢复',
  attached: '关联',
  detached: '解除关联',
  bound: '会话归属',
};
const errors: Record<string, string> = {
  PROJECT_CYCLE: '不能移入自身的子项目。',
  PROJECT_DEPTH_EXCEEDED: '项目最多四层。',
  PROJECT_TITLE_CONFLICT: '同一父项目下已有这个名称。',
  PROJECT_CONTEXT_CONFLICT: '项目场景不同，无法合并。',
  PROJECT_ALIAS_CONFLICT: '这个别名已被其他项目使用。',
  PROJECT_MERGE_ANCESTRY: '父子项目不能直接合并。',
  PROJECT_REMOVE_BLOCKED: '项目仍有关联，无法删除。',
  PROJECT_HAS_OPEN_WORK: '项目仍有未完成事项，无法归档。',
  PROJECT_ARCHIVED: '项目已归档。',
  STALE_VERSION: '项目已更新，已重新载入。',
  PROJECT_EMPTY_SPLIT: '每个新子项目至少需要一个成员。',
};

function failure(error: unknown): { message: string; blockers: string[] } {
  const item = error as { code?: string; message?: string; details?: Record<string, unknown> };
  const blockers: string[] = [];
  for (const value of Object.values(item.details ?? {})) {
    if (Array.isArray(value))
      for (const row of value) {
        if (row && typeof row === 'object')
          blockers.push(String(row.title ?? row.objectId ?? row.id ?? '关联项'));
      }
  }
  return { message: errors[item.code ?? item.message ?? ''] ?? item.message ?? '操作失败', blockers };
}

export function TreeDiffView({ changes }: { changes: TreeChange[] }) {
  return (
    <ul className="pa-tree-diff">
      {changes.map((change) => {
        const before = change.before,
          after = change.after;
        const oldPath = String(before?.titlePath ?? before?.path ?? '');
        const nextPath = String(after?.redirectTitlePath ?? after?.titlePath ?? after?.redirectPath ?? after?.path ?? '');
        return (
          <li key={change.id}>
            <span className="pa-tag">{actions[change.action] ?? change.action}</span>
            <strong>{change.title}</strong>
            {oldPath !== nextPath && (
              <span className="pa-tree-path">
                {oldPath || '—'} → {nextPath || '—'}
              </span>
            )}
            {before?.title !== after?.title && Boolean(before?.title) && Boolean(after?.title) && (
              <span>
                {String(before?.title)} → {String(after?.title)}
              </span>
            )}
            {change.reason && <span className="pa-meta">{change.reason}</span>}
          </li>
        );
      })}
    </ul>
  );
}

export function ProjectPage({ api, onChange, onOpen, focusId, createNonce, onCreateConsumed }: Props) {
  const [items, setItems] = useState<ProjectNode[]>([]);
  const [selected, setSelected] = useState<string | null>(focusId ?? null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; blockers: string[] } | null>(null);
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<ProjectForm | null>(null);
  const [editing, setEditing] = useState(false);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [destination, setDestination] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');
  const [preview, setPreview] = useState<TreeChange[] | null>(null);
  const previewSequence = useRef(0);
  const [alias, setAlias] = useState('');
  const [split, setSplit] = useState(false);
  const [partNames, setPartNames] = useState(['', '']);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const command = useCallback(
    <T,>(name: string, payload: unknown = {}) =>
      api<T>('command', { command: name, payload, requestId: crypto.randomUUID() }),
    [api],
  );
  const refresh = useCallback(async () => {
    const tree = await command<{ items: ProjectNode[] }>('projectTree');
    setItems(tree.items);
  }, [command]);
  useEffect(() => {
    void refresh().catch((value) => setError(failure(value)));
  }, [refresh]);
  useEffect(() => {
    if (focusId) setSelected(focusId);
  }, [focusId]);
  useEffect(() => {
    if (createNonce) {
      setEditing(false);
      setForm({ title: '', statement: '', context: [], parentId: null });
      onCreateConsumed?.();
    }
  }, [createNonce, onCreateConsumed]);
  const current = items.find((row) => row.id === selected) ?? null;
  useEffect(() => {
    previewSequence.current++;
    let active = true;
    setMergeTarget('');
    setPreview(null);
    setSplit(false);
    setAssignments({});
    setPartNames(['', '']);
    setDestination(current?.data.parentId ?? '');
    if (current)
      void command<Relation[]>('relations', { id: current.id })
        .then((value) => {
          if (active) setRelations(value);
        })
        .catch((value) => {
          if (active) setError(failure(value));
        });
    else setRelations([]);
    return () => {
      active = false;
    };
  }, [current?.id, current?.revision, command]);

  const breadcrumb = useCallback(
    (id: string): string => {
      const names: string[] = [],
        seen = new Set<string>();
      let row = items.find((item) => item.id === id);
      while (row && !seen.has(row.id)) {
        seen.add(row.id);
        names.unshift(row.data.title);
        row = items.find((item) => item.id === row!.data.parentId);
      }
      return names.join(' / ');
    },
    [items],
  );
  const visible = useMemo(() => {
    const keep = new Set<string>();
    for (const row of items) {
      if (status !== 'all' && row.data.status !== status) continue;
      if (
        query &&
        ![row.data.title, row.data.statement, ...row.data.aliases]
          .join(' ')
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())
      )
        continue;
      keep.add(row.id);
      let parent = row.data.parentId;
      while (parent) {
        keep.add(parent);
        parent = items.find((item) => item.id === parent)?.data.parentId ?? null;
      }
    }
    return keep;
  }, [items, query, status]);

  async function execute(name: string, payload: unknown, success: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await command(name, payload);
      await refresh();
      onChange();
      setNotice(success);
      return true;
    } catch (value) {
      setError(failure(value));
      await refresh().catch(() => undefined);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const ref = (row: ProjectNode) => ({ id: row.id, revision: row.revision });
  const parentRef = (id: string | null) => (id ? ref(items.find((row) => row.id === id)!) : null);
  async function move(id: string, parentId: string | null) {
    const row = items.find((item) => item.id === id);
    if (!row || busy) return;
    await execute(
      'projectMove',
      { ...ref(row), parent: parentRef(parentId), reason: '调整项目位置' },
      '已移动',
    );
  }
  function drop(event: DragEvent, parentId: string | null) {
    event.preventDefault();
    event.stopPropagation();
    void move(event.dataTransfer.getData('application/x-dsh-project'), parentId);
  }
  function startCreate(parentId: string | null) {
    setEditing(false);
    setError(null);
    setForm({ title: '', statement: '', context: [], parentId });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    const context: Record<string, string | number | boolean> = {};
    for (const field of form.context) {
      const name = field.name.trim();
      if (!name || Object.hasOwn(context, name)) {
        setError({ message: '条件名称不能为空或重复。', blockers: [] });
        return;
      }
      if (field.type === 'number' && (!field.value.trim() || !Number.isFinite(Number(field.value)))) {
        setError({ message: '条件值须为有效数字。', blockers: [] });
        return;
      }
      context[name] =
        field.type === 'number'
          ? Number(field.value)
          : field.type === 'boolean'
            ? field.value === 'true'
            : field.value;
    }
    const fields = { title: form.title, statement: form.statement, context };
    const ok = await execute(
      editing && current ? 'projectEdit' : 'projectCreate',
      editing && current
        ? { ...ref(current), patch: fields }
        : { ...fields, parent: parentRef(form.parentId) },
      editing ? '已保存' : '已创建',
    );
    if (ok) setForm(null);
  }
  async function loadPreview(id: string) {
    const sequence = ++previewSequence.current;
    setMergeTarget(id);
    setPreview(null);
    setError(null);
    if (!id || !current) return;
    try {
      const result = await command<{ changes: TreeChange[] }>('projectPreview', {
        operation: 'projectMerge',
        payload: { source: ref(current), target: parentRef(id), reason: '合并相同事项' },
      });
      if (sequence === previewSequence.current) setPreview(result.changes);
    } catch (value) {
      if (sequence === previewSequence.current) setError(failure(value));
    }
  }
  const children = current ? items.filter((row) => row.data.parentId === current.id) : [];
  const members = relations.filter((row) => row.kind === 'contains');
  async function saveSplit() {
    if (!current) return;
    const parts = partNames.map((title, index) => ({
      project: {
        title,
        statement: '',
        context: current.data.context,
        domains: current.data.domains,
        topics: current.data.topics,
      },
      objects: members
        .filter((row) => assignments[row.object.id] === String(index))
        .map((row) => ({ id: row.object.id, revision: row.object.revision })),
      children: children.filter((row) => assignments[row.id] === String(index)).map(ref),
    }));
    if (await execute('projectSplit', { ...ref(current), parts, reason: '按成员拆分子项目' }, '已拆分'))
      setSplit(false);
  }
  const renderTree = (parentId: string | null): ReactNode => (
    <ul role={parentId ? 'group' : 'tree'} aria-label={parentId ? undefined : '项目树'}>
      {items
        .filter((row) => row.data.parentId === parentId && visible.has(row.id))
        .map((row) => {
          const hasChildren = items.some((child) => child.data.parentId === row.id && visible.has(child.id));
          const expanded = query.length > 0 || !collapsed.has(row.id);
          return (
            <li
              key={row.id}
              role="treeitem"
              aria-selected={row.id === selected}
              aria-expanded={hasChildren ? expanded : undefined}
            >
              <div
                className={'pa-tree-row' + (row.id === selected ? ' pa-tree-selected' : '')}
                draggable={!busy}
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/x-dsh-project', row.id);
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => drop(event, row.id)}
              >
                <button
                  type="button"
                  className="pa-tree-toggle"
                  disabled={!hasChildren}
                  aria-label={(expanded ? '收起 ' : '展开 ') + row.data.title}
                  onClick={() =>
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (next.has(row.id)) next.delete(row.id);
                      else next.add(row.id);
                      return next;
                    })
                  }
                >
                  {hasChildren ? (expanded ? '▾' : '▸') : '·'}
                </button>
                <button
                  type="button"
                  className="pa-tree-title"
                  onClick={() => {
                    setSelected(row.id);
                    setForm(null);
                    setError(null);
                  }}
                >
                  {row.data.title}
                </button>
                <span className="pa-tag">{statuses[row.data.status]}</span>
              </div>
              {hasChildren && expanded && renderTree(row.id)}
            </li>
          );
        })}
    </ul>
  );

  return (
    <div className="pa-project-page">
      <div className="pa-page-heading">
        <h2>
          项目 <span className="pa-count">{items.length}</span>
        </h2>
        <button type="button" className="pa-primary" onClick={() => startCreate(null)}>
          新建项目
        </button>
      </div>
      <div className="pa-project-filters">
        <input
          aria-label="搜索项目"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索项目"
        />
        <select aria-label="项目状态" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">全部状态</option>
          {Object.entries(statuses).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <div role="alert" className="pa-error">
          {error.message}
          {error.blockers.length > 0 && (
            <ul>
              {error.blockers.map((label, index) => (
                <li key={index}>{label}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {notice && (
        <div role="status" className="pa-meta">
          {notice}
        </div>
      )}
      <div className="pa-project-columns">
        <section className="pa-project-tree">
          <div
            className="pa-root-drop"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => drop(event, null)}
          >
            根项目
          </div>
          {renderTree(null)}
          {!items.length && <div className="pa-empty">暂无项目</div>}
        </section>
        <section className="pa-project-detail">
          {form ? (
            <form className="pa-form" onSubmit={save}>
              <h3>{editing ? '编辑项目' : '新建项目'}</h3>
              <label>
                名称
                <input
                  aria-label="项目名称"
                  required
                  value={form.title}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                />
              </label>
              <label>
                目标
                <textarea
                  aria-label="项目目标"
                  value={form.statement}
                  onChange={(event) => setForm({ ...form, statement: event.target.value })}
                />
              </label>
              {!editing && (
                <label>
                  父项目
                  <select
                    aria-label="父项目"
                    value={form.parentId ?? ''}
                    onChange={(event) => setForm({ ...form, parentId: event.target.value || null })}
                  >
                    <option value="">根项目</option>
                    {items
                      .filter((row) => row.data.status !== 'archived')
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {breadcrumb(row.id)}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <fieldset className="pa-project-context-fields">
                <legend>场景条件</legend>
                {form.context.map((field, index) => (
                  <div className="pa-project-context-row" key={index}>
                    <input
                      aria-label={'条件名称 ' + (index + 1)}
                      placeholder="条件名称"
                      value={field.name}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          context: form.context.map((row, i) =>
                            i === index ? { ...row, name: event.target.value } : row,
                          ),
                        })
                      }
                    />
                    <select
                      aria-label={'条件类型 ' + (index + 1)}
                      value={field.type}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          context: form.context.map((row, i) =>
                            i === index
                              ? {
                                  ...row,
                                  type: event.target.value as ContextField['type'],
                                  value: event.target.value === 'boolean' ? 'true' : row.value,
                                }
                              : row,
                          ),
                        })
                      }
                    >
                      <option value="string">文字</option>
                      <option value="number">数字</option>
                      <option value="boolean">是 / 否</option>
                    </select>
                    {field.type === 'boolean' ? (
                      <select
                        aria-label={'条件值 ' + (index + 1)}
                        value={field.value}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            context: form.context.map((row, i) =>
                              i === index ? { ...row, value: event.target.value } : row,
                            ),
                          })
                        }
                      >
                        <option value="true">是</option>
                        <option value="false">否</option>
                      </select>
                    ) : (
                      <input
                        aria-label={'条件值 ' + (index + 1)}
                        placeholder="值"
                        type={field.type === 'number' ? 'number' : 'text'}
                        step="any"
                        value={field.value}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            context: form.context.map((row, i) =>
                              i === index ? { ...row, value: event.target.value } : row,
                            ),
                          })
                        }
                      />
                    )}
                    <button
                      type="button"
                      aria-label={'删除条件 ' + (index + 1)}
                      onClick={() =>
                        setForm({ ...form, context: form.context.filter((_, i) => i !== index) })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setForm({ ...form, context: [...form.context, { name: '', value: '', type: 'string' }] })
                  }
                >
                  添加条件
                </button>
              </fieldset>
              <div className="pa-project-actions">
                <button className="pa-primary" disabled={busy} type="submit">
                  保存
                </button>
                <button type="button" onClick={() => setForm(null)}>
                  取消
                </button>
              </div>
            </form>
          ) : current ? (
            <>
              <div className="pa-project-detail-heading">
                <div>
                  <span className="pa-meta">{breadcrumb(current.id)}</span>
                  <h3>{current.data.title}</h3>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(true);
                    setForm({
                      title: current.data.title,
                      statement: current.data.statement,
                      context: Object.entries(current.data.context).map(([name, value]) => ({
                        name,
                        value: String(value),
                        type: typeof value as ContextField['type'],
                      })),
                      parentId: current.data.parentId,
                    });
                  }}
                >
                  编辑
                </button>
              </div>
              {current.data.statement && <p>{current.data.statement}</p>}
              {Object.keys(current.data.context).length > 0 && (
                <dl className="pa-project-context">
                  {Object.entries(current.data.context).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="pa-project-actions">
                <button
                  type="button"
                  disabled={busy || current.data.depth >= 4}
                  onClick={() => startCreate(current.id)}
                >
                  新建子项目
                </button>
                <button
                  type="button"
                  disabled={busy || current.data.depth >= 4}
                  onClick={() => setSplit(!split)}
                >
                  拆分
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void execute(
                      current.data.status === 'archived' ? 'projectRestore' : 'projectArchive',
                      ref(current),
                      current.data.status === 'archived' ? '已恢复' : '已归档',
                    )
                  }
                >
                  {current.data.status === 'archived' ? '恢复' : '归档'}
                </button>
                <button
                  type="button"
                  className="pa-danger"
                  disabled={busy}
                  onClick={() => void execute('projectRemove', ref(current), '已删除')}
                >
                  删除
                </button>
              </div>
              <div className="pa-project-inline">
                <label>
                  移动到
                  <select
                    aria-label="移动到"
                    value={destination}
                    onChange={(event) => setDestination(event.target.value)}
                  >
                    <option value="">根项目</option>
                    {items
                      .filter((row) => row.id !== current.id)
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {breadcrumb(row.id)}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={busy || destination === (current.data.parentId ?? '')}
                  onClick={() => void move(current.id, destination || null)}
                >
                  移动
                </button>
              </div>
              <div className="pa-project-inline">
                <label>
                  合并到
                  <select
                    aria-label="合并到"
                    value={mergeTarget}
                    onChange={(event) => void loadPreview(event.target.value)}
                  >
                    <option value="">选择项目</option>
                    {items
                      .filter((row) => row.id !== current.id && row.data.status !== 'archived')
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {breadcrumb(row.id)}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={busy || !preview}
                  onClick={() =>
                    void execute(
                      'projectMerge',
                      { source: ref(current), target: parentRef(mergeTarget), reason: '合并相同事项' },
                      '已合并',
                    ).then((ok) => {
                      if (ok) setSelected(mergeTarget);
                    })
                  }
                >
                  合并
                </button>
              </div>
              {preview && (
                <div className="pa-merge-preview">
                  <h4>合并预览</h4>
                  <TreeDiffView changes={preview} />
                </div>
              )}
              <div className="pa-project-aliases">
                <h4>别名</h4>
                <div className="pa-chip-row">
                  {current.data.aliases.map((value) => (
                    <span key={value} className="pa-chip">
                      {value}
                      <button
                        type="button"
                        aria-label={'移除别名 ' + value}
                        disabled={busy}
                        onClick={() =>
                          void execute(
                            'projectAlias',
                            { ...ref(current), alias: value, action: 'remove' },
                            '已移除别名',
                          )
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <form
                  className="pa-project-inline"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void execute(
                      'projectAlias',
                      { ...ref(current), alias, action: 'add' },
                      '已添加别名',
                    ).then((ok) => {
                      if (ok) setAlias('');
                    });
                  }}
                >
                  <input
                    aria-label="新别名"
                    value={alias}
                    onChange={(event) => setAlias(event.target.value)}
                  />
                  <button disabled={busy || !alias.trim()}>添加</button>
                </form>
              </div>
              {split && (
                <div className="pa-project-split">
                  <h4>拆分子项目</h4>
                  {partNames.map((value, index) => (
                    <label key={index}>
                      子项目 {index + 1}
                      <input
                        aria-label={'子项目 ' + (index + 1)}
                        value={value}
                        onChange={(event) =>
                          setPartNames((names) =>
                            names.map((name, i) => (i === index ? event.target.value : name)),
                          )
                        }
                      />
                    </label>
                  ))}
                  {[
                    ...children.map((row) => ({ id: row.id, title: row.data.title })),
                    ...members.map((row) => ({ id: row.object.id, title: row.object.data.title })),
                  ].map((row) => (
                    <label key={row.id}>
                      {row.title}
                      <select
                        aria-label={'分配 ' + row.title}
                        value={assignments[row.id] ?? ''}
                        onChange={(event) => setAssignments({ ...assignments, [row.id]: event.target.value })}
                      >
                        <option value="">保留原位</option>
                        {partNames.map((title, index) => (
                          <option key={index} value={index}>
                            {title || '子项目 ' + (index + 1)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <button
                    className="pa-primary"
                    disabled={busy || partNames.some((title) => !title.trim())}
                    onClick={() => void saveSplit()}
                  >
                    执行拆分
                  </button>
                </div>
              )}
              <h4>
                关联事项 <span className="pa-count">{relations.length}</span>
              </h4>
              <ul className="pa-project-members">
                {relations.map((row) => (
                  <li key={row.kind + row.object.id}>
                    <span className="pa-tag">
                      {row.kind === 'contains' ? '所属' : row.kind === 'applies_to' ? '复用' : '关联'}
                    </span>
                    <button type="button" onClick={() => onOpen(row.object.kind, row.object.id)}>
                      {row.object.data.title}
                    </button>
                    {['contains', 'applies_to'].includes(row.kind) && (
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={'解除关联 ' + row.object.data.title}
                        onClick={() =>
                          void execute(
                            'projectDetach',
                            {
                              object: { id: row.object.id, revision: row.object.revision },
                              project: ref(current),
                              role: row.kind,
                            },
                            '已解除关联',
                          )
                        }
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="pa-empty">选择项目</div>
          )}
        </section>
      </div>
    </div>
  );
}
