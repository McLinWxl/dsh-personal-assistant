import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ComponentType,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from 'react';
import styles from './style.css';
import {ProjectPage, TreeDiffView} from './projects.js';
import type {TreeChange} from '../domain/project-types.js';

export const name = 'personal-assistant-client';
export const inject = ['slots', 'connection', 'locale', 'layout', 'uiWorkspace'];

declare global {
  interface Window {
    __DSH_DIRECTORY_PICKER__?: { pick: () => Promise<string | null> };
  }
}

/* ------------------------------------------------------------------ */
/* Backend transport                                                   */
/* ------------------------------------------------------------------ */

type Payload = unknown;
type Api = <T = unknown>(method: string, payload?: Payload) => Promise<T>;

interface RpcResponse {
  ok?: boolean;
  value?: unknown;
  error?: { message?: string; code?: string; details?: unknown };
}

const command = async <T,>(
  api: Api,
  name: string,
  payload: Payload = {},
): Promise<T> =>
  api<T>('command', {
    command: name,
    payload,
    requestId: crypto.randomUUID(),
  });

/* ------------------------------------------------------------------ */
/* Labels and small helpers                                            */
/* ------------------------------------------------------------------ */

const TIMEZONES = Array.from(
  new Set(['Asia/Shanghai', 'UTC', ...Intl.supportedValuesOf('timeZone')]),
);

const LABELS: Record<string, string> = {
  fact: '事实',
  method: '方法',
  episode: '经历',
  preference: '偏好',
  decision: '决定',
  goal: '目标',
  active: '进行中',
  paused: '暂停',
  completed: '已完成',
  archived: '归档',
  todo: '待办',
  scheduled: '已安排',
  running: '执行中',
  'needs-review': '待核对',
  cancelled: '已取消',
  failed: '失败',
  draft: '草稿',
  applied: '已应用',
  expired: '已到期',
};

const ERROR_LABELS: Record<string, string> = {
  PROJECT_RETRY_PENDING: '模型暂未完成识别，将自动重试。',
  PROJECT_MODEL_INCOMPLETE: '项目识别未完成，稍后重试。',
  STALE_PROJECT_CATALOG: '项目已更新，请重试。',
  PROJECT_MATCH_REQUIRES_REVIEW: '请确认这是已有项目还是新的事项。',
  PROJECT_CONTEXT_CONFLICT: '事项条件与所选项目不同。',
  WEIXIN_SECURE_STORE_UNAVAILABLE: '系统凭据存储不可用，请启用或解锁后重试。',
  WEIXIN_SECURE_STORE_INVALID: '本机微信凭据无法读取，请重新连接。',
  STALE_VERSION: '内容已更新，请刷新后重试。',
  QUOTE_NOT_IN_SOURCE: '引用与来源不一致。',
  DATA_DIRECTORY_LOCKED: '此目录正在使用。',
  PROJECT_HAS_ACTIVE_REFERENCES: '项目仍有任务或日程，暂时不能删除。',
  VAULT_LOCKED: '请先解锁凭据。',
  VAULT_UNLOCK_FAILED: '口令不正确。',
  PASSPHRASE_MINIMUM_10_CHARACTERS: '口令至少需要 10 个字符。',
  TASK_DEPENDENCY_NOT_COMPLETED: '前置任务尚未完成。',
  CALENDAR_TIMEZONE_RULES_NEED_UPDATE: '此时区规则需要更新。',
  EXPORT_DESTINATION_EXISTS: '导出目录已存在。',
  INVALID_CALENDAR_RANGE: '日期范围不正确。',
};

function message(error: unknown): string {
  let raw = '';
  if (typeof error === 'string') raw = error;
  else if (error && typeof error === 'object' && 'message' in error) {
    const value = (error as { message?: unknown }).message;
    raw = typeof value === 'string' ? value : String(value ?? '');
  }
  if (!raw) return '操作失败';
  return ERROR_LABELS[raw] ?? raw;
}

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function splitList(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function formatDate(value: unknown, zone?: string): string {
  if (value === null || value === undefined || value === '') return '';
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}

function formatTime(value: unknown, zone: string): string {
  if (value === null || value === undefined || value === '') return '';
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

function localInput(value: string | number, zone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(value))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function fromLocal(value: string, zone: string): string {
  if (!value) throw new Error('请选择时间。');
  const desired = Date.parse(`${value}Z`);
  if (!Number.isFinite(desired)) throw new Error('日期不正确。');
  let time = desired;
  for (let index = 0; index < 4; index += 1) {
    const shown = Date.parse(`${localInput(time, zone)}Z`);
    time += desired - shown;
  }
  if (localInput(time, zone) !== value) {
    throw new Error('该时区不存在此时刻。');
  }
  return new Date(time).toISOString();
}

function dayString(zone: string, offset = 0): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  const base = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + offset),
  );
  const year = base.getUTCFullYear();
  const month = String(base.getUTCMonth() + 1).padStart(2, '0');
  const day = String(base.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dayBounds(zone: string, offset = 0): { start: string; end: string } {
  return {
    start: fromLocal(`${dayString(zone, offset)}T00:00`, zone),
    end: fromLocal(`${dayString(zone, offset + 1)}T00:00`, zone),
  };
}

function dayKeyOf(value: unknown, zone: string): string {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function relativeDay(value: unknown, zone: string): string {
  const key = dayKeyOf(value, zone);
  if (!key) return '';
  if (key === dayString(zone, 0)) return '今天';
  if (key === dayString(zone, -1)) return '昨天';
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone,
    month: 'short',
    day: 'numeric',
  }).format(new Date(ms));
}

function updatedTime(row: Row): number {
  const value =
    row.data.updatedAt ??
    row.data.observations?.at(-1)?.at ??
    row.data.createdAt;
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : 0;
}

function projectColor(projectId: string | null | undefined): string | undefined {
  if (!projectId) return undefined;
  const palette = ['#4f8f72', '#b07d3a', '#6b7fc4', '#a45f8a', '#3f8a9c', '#8a6f3f'];
  let hash = 0;
  for (const char of projectId) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  return palette[hash % palette.length];
}

/* ------------------------------------------------------------------ */
/* Data shapes                                                         */
/* ------------------------------------------------------------------ */

interface RowData {
  title?: string;
  body?: string;
  statement?: string;
  description?: string;
  notes?: string;
  status?: string;
  type?: string;
  kind?: string;
  domains?: string[];
  topics?: string[];
  importance?: number;
  pinned?: boolean;
  important?: boolean;
  urgent?: boolean;
  derivedDirty?: boolean;
  dueAt?: string | null;
  start?: string;
  end?: string;
  allDay?: boolean;
  timezone?: string;
  recurrence?: string;
  location?: string;
  activeVersion?: string;
  pendingVersion?: string;
  steps?: unknown[];
  source?: string;
  language?: string;
  capabilities?: string[];
  parameters?: Record<string, unknown>;
  dependsOn?: string[];
  observations?: Array<{ at: string; body?: string }>;
  originalClaims?: Array<{ at: string; body: string; quote?: string }>;
  facts?: Array<{ subject?: string; predicate?: string; value?: string }>;
  canonicalFacts?: Array<{ subject?: string; predicate?: string; value?: string }>;
  context?: Record<string, unknown>;
  name?: string;
  aliases?: string[];
  result?: string;
  selected?: boolean;
  createdAt?: string | number;
  updatedAt?: string | number;
}

interface Row {
  projectId?: string | null;
  id: string;
  revision: number;
  kind?: string;
  data: RowData;
  occurrenceStart?: string;
  occurrenceEnd?: string;
  occurrenceKey?: string;
}

interface ListResult {
  items: Row[];
  total: number;
  offset?: number;
}

interface Overview {
  counts: Record<string, number>;
  unread: number;
  dataRoot: string;
  settings: AssistantSettings;
}

interface ChangeSummary {
  type?: string;
  changedObjects?: number;
  pairs?: string[];
}

interface ChangeRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
  status: string;
  summary: ChangeSummary;
}

interface ChangeItem {
  kind: string;
  objectId: string | null;
  title: string;
  action: string;
  detail: string;
}

interface ChangeDetail extends ChangeRecord {
  items: ChangeItem[];
  expiresDisplay?: string;
}

type ReportStatus = 'draft' | 'confirmed' | 'auto-confirmed' | 'superseded';

interface ReportRow {
  id: string;
  windowFrom: number;
  windowTo: number;
  status: ReportStatus;
  revision: number;
  conversationId: string | null;
  sessionId: string | null;
  body: string;
  createdAt: number;
  confirmedAt: number | null;
  counts: number;
  summary: Record<string, unknown> | null;
}

interface ReportItem {
  metadata?: { treeDiff?: TreeChange; gap?: Record<string, unknown> };
  id: string;
  kind: string;
  objectId: string | null;
  action: string;
  title: string;
  detail: string;
  at: number;
}

interface ReportRevision {
  revision: number;
  body: string;
  createdAt: number;
}

interface ReportDetail extends ReportRow {
  items: ReportItem[];
  revisions: ReportRevision[];
}

interface Relation {
  id: string;
  kind: string;
  direction?: string;
  object: Row;
}

interface RelatedMemory {
  id: string;
  revision: number;
  title?: string;
  body?: string;
}

type SearchKind = 'memory' | 'project' | 'task' | 'event' | 'tool' | 'entity';

interface SearchItem {
  id: string;
  kind: SearchKind;
  title: string;
  snippet?: string;
}

interface SearchResult {
  query: string;
  groups: Partial<Record<SearchKind, SearchItem[]>>;
  total: number;
}

interface HealthReport {
  integrity?: string;
  foreignKeyErrors?: unknown;
  foreignKeys?: unknown;
  nodes?: unknown;
  edges?: unknown;
  changes?: unknown;
  rollbackItems?: unknown;
  outbox?: unknown;
  dataRoot?: string;
  schemaVersion?: number;
}

type Density = 'standard' | 'compact';

function readDensity(): Density {
  try {
    return localStorage.getItem('pa.density') === 'compact' ? 'compact' : 'standard';
  } catch {
    return 'standard';
  }
}

function readLastExport(): { at: number; name: string; destination?: string } | null {
  try {
    const raw = localStorage.getItem('pa.lastExport');
    if (!raw) return null;
    const value = JSON.parse(raw) as { at?: number; name?: string; destination?: string };
    if (!value || typeof value.at !== 'number' || typeof value.name !== 'string') return null;
    return { at: value.at, name: value.name, destination: value.destination };
  } catch {
    return null;
  }
}

function countValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  return null;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

async function exportBackup(
  api: Api,
): Promise<{ at: number; name: string; destination: string; files?: number } | null> {
  const parent = await api<string | null>('native.pickDirectory');
  if (!parent) return null;
  const destination = await api<string>('data.exportDestination', { parent });
  const result = await api<{ destination?: string; files?: number }>('data.export', {
    destination,
    requestId: crypto.randomUUID(),
  });
  const actual = result?.destination ?? destination;
  return {
    at: Date.now(),
    name: baseName(actual),
    destination: actual,
    files: result?.files,
  };
}

interface Job {
  kind: string;
  status: string;
  next_at: number;
}

interface RunRow {
  id: string;
  title?: string;
  status: string;
  created_at: number;
  result?: string;
  session_id?: string;
  task_id?: string;
}

interface AssistantSettings {
  timezone: string;
  retentionHours: number;
  rawDays: number;
  maintenanceHour: number;
  maintenanceEnabled: boolean;
  maintenanceMaxItems: number;
  maintenanceMaxSeconds: number;
  contextCharacters: number;
  rollbackMegabytes: number;
  model: string;
  basePreset: string;
  workspace: string;
  reportEnabled: boolean;
  reportHour: number;
  snapshotDays: number;
  changeSummaryDays: number;
}

const REPORT_SETTING_DEFAULTS = {
  reportEnabled: true,
  reportHour: 7,
  snapshotDays: 7,
  changeSummaryDays: 90,
};

interface SettingsOptions {
  models: Array<{ id: string; name: string }>;
  presets: Array<{ id: string; name?: string; broken?: boolean }>;
  defaults: {
    model?: string;
    modelName?: string;
    basePreset?: string;
    presetName?: string;
    workspace?: string;
    exportDirectory: string;
    exportName: string;
  };
}

interface WeixinState {
  status: string;
  attemptId?: string;
  qrImage?: string;
  error?: string;
  account?: string;
}

/* ------------------------------------------------------------------ */
/* Form state                                                          */
/* ------------------------------------------------------------------ */

interface FormState {
  title: string;
  body: string;
  statement: string;
  description: string;
  notes: string;
  status: string;
  type: string;
  kind: string;
  dueLocal: string;
  startLocal: string;
  endLocal: string;
  allDay: boolean;
  timezone: string;
  repeat: string;
  recurrence: string;
  location: string;
  domainsText: string;
  importance: number;
  pinned: boolean;
  projectId: string;
  stepsText: string;
  source: string;
  language: string;
  capabilitiesText: string;
  scope: string;
  occurrenceKey: string;
  id?: string;
  revision?: number;
  dependsOn?: string[];
  parameters?: Record<string, unknown>;
  seriesStart?: string;
  seriesEnd?: string;
  instanceStart?: string;
  instanceEnd?: string;
}

function formFromRow(
  kind: Kind,
  row: Row | undefined,
  timezone: string,
): FormState {
  const data = row?.data ?? {};
  const zone = data.timezone ?? timezone;
  const occurrenceStart = row?.occurrenceStart;
  const occurrenceEnd = row?.occurrenceEnd;
  const start = occurrenceStart ?? data.start;
  const end = occurrenceEnd ?? data.end;
  const startLocal = start
    ? data.allDay
      ? start.slice(0, 10)
      : localInput(start, zone)
    : '';
  const endLocal = end
    ? data.allDay
      ? end.slice(0, 10)
      : localInput(end, zone)
    : '';
  return {
    title: data.title ?? '',
    body: data.body ?? '',
    statement: data.statement ?? '',
    description: data.description ?? '',
    notes: data.notes ?? '',
    status: data.status ?? (kind === 'project' ? 'active' : 'todo'),
    type: data.type ?? 'fact',
    kind: data.kind ?? 'workflow',
    dueLocal: data.dueAt ? localInput(data.dueAt, zone) : '',
    startLocal,
    endLocal,
    allDay: data.allDay ?? false,
    timezone: zone,
    repeat: data.recurrence ? 'custom' : 'none',
    recurrence: data.recurrence ?? '',
    location: data.location ?? '',
    domainsText: (data.domains ?? []).join('，'),
    importance: data.importance ?? 3,
    pinned: data.pinned ?? false,
    projectId: row?.projectId ?? '',
    stepsText: JSON.stringify(data.steps ?? [], null, 2),
    source: data.source ?? '',
    language: data.language ?? 'javascript',
    capabilitiesText: (data.capabilities ?? []).join(','),
    scope: row?.occurrenceKey ? 'occurrence' : 'series',
    occurrenceKey: row?.occurrenceKey ?? '',
    id: row?.id,
    revision: row?.revision,
    dependsOn: data.dependsOn ?? [],
    parameters: data.parameters ?? {},
  };
}

function makeEventForm(
  row: Row | undefined,
  day: string | undefined,
  timezone: string,
): FormState {
  const form = formFromRow('event', row, timezone);
  const data = row?.data ?? {};
  const zone = data.timezone ?? timezone;
  const occurrenceStart = row?.occurrenceStart;
  const occurrenceEnd = row?.occurrenceEnd;
  const seriesStart = data.start
    ? data.allDay
      ? data.start.slice(0, 10)
      : localInput(data.start, zone)
    : '';
  const seriesEnd = data.end
    ? data.allDay
      ? data.end.slice(0, 10)
      : localInput(data.end, zone)
    : '';
  const instanceStart = occurrenceStart
    ? data.allDay
      ? occurrenceStart.slice(0, 10)
      : localInput(occurrenceStart, zone)
    : '';
  const instanceEnd = occurrenceEnd
    ? data.allDay
      ? occurrenceEnd.slice(0, 10)
      : localInput(occurrenceEnd, zone)
    : '';
  return {
    ...form,
    seriesStart,
    seriesEnd,
    instanceStart,
    instanceEnd,
    startLocal:
      instanceStart ||
      seriesStart ||
      (day ? `${day}T09:00` : localInput(Date.now(), timezone)),
    endLocal:
      instanceEnd ||
      seriesEnd ||
      (day ? `${day}T10:00` : localInput(Date.now() + 3600000, timezone)),
    projectId: row?.projectId ?? '',
  };
}

function recordPayload(kind: Kind, form: FormState, timezone: string): Payload {
  const domains = splitList(form.domainsText);
  if (kind === 'project') {
    return {
      title: form.title,
      statement: form.statement,
      domains,
      status: form.status,
    };
  }
  if (kind === 'memory') {
    const base = {
      title: form.title,
      body: form.body,
      notes: form.notes,
      pinned: form.pinned,
      importance: form.importance,
      domains,
      projectId: form.projectId || null,
    };
    return form.id ? base : { ...base, type: form.type };
  }
  if (kind === 'task') {
    return {
      title: form.title,
      description: form.description,
      dueAt: form.dueLocal ? fromLocal(form.dueLocal, timezone) : null,
      domains,
      importance: form.importance,
      status: form.status,
      projectId: form.projectId || null,
      dependsOn: form.dependsOn ?? [],
    };
  }
  let steps: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(form.stepsText || '[]');
    if (!Array.isArray(parsed)) throw new Error('步骤需要是 JSON 数组。');
    steps = parsed;
  } catch {
    throw new Error('工作流步骤不是有效的 JSON 数组。');
  }
  return {
    title: form.title,
    description: form.description,
    kind: form.kind,
    steps: form.kind === 'script' ? [] : steps,
    source: form.source,
    language: form.language,
    capabilities: splitList(form.capabilitiesText),
    parameters: form.parameters ?? {},
  };
}

async function persistRecord(
  api: Api,
  kind: Kind,
  form: FormState,
  timezone: string,
): Promise<void> {
  const data = recordPayload(kind, form, timezone);
  if (kind === 'tool') {
    const definition = data as Record<string, unknown>;
    await command(api, 'toolSave', form.id
      ? { id: form.id, revision: form.revision, projectId: form.projectId || null, definition }
      : { projectId: form.projectId || null, definition });
    return;
  }
  if (kind === 'memory' && !form.id) {
    const body = data as Record<string, unknown>;
    await api('memory.manual', {
      ...body,
      occurredAt: new Date().toISOString(),
      timePrecision: 'instant',
      requestId: crypto.randomUUID(),
    });
    return;
  }
  if (kind === 'memory') {
    await command(api, 'memoryEdit', {
      id: form.id,
      revision: form.revision,
      patch: data,
    });
    return;
  }
  const commandName =
    kind === 'project'
      ? form.id
        ? 'projectEdit'
        : 'projectCreate'
      : form.id
        ? 'taskEdit'
        : 'taskCreate';
  await command(
    api,
    commandName,
    form.id ? { id: form.id, revision: form.revision, patch: data } : data,
  );
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function usePolling(
  task: () => void | Promise<void>,
  interval: number,
  enabled = true,
): void {
  const latest = useRef(task);
  useEffect(() => {
    latest.current = task;
  }, [task]);
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const tick = () => {
      if (!document.hidden) void latest.current();
    };
    const start = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = window.setInterval(tick, interval);
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (timer !== undefined) window.clearInterval(timer);
        timer = undefined;
      } else {
        tick();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [interval, enabled]);
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

interface ToastOptions {
  tone?: 'info' | 'error';
  action?: ToastAction;
}

interface ToastItem {
  id: number;
  text: string;
  tone: 'info' | 'error';
  action?: ToastAction;
}

const ToastContext = createContext<(text: string, options?: ToastOptions) => void>(
  () => undefined,
);

function useToast(): (text: string, options?: ToastOptions) => void {
  return useContext(ToastContext);
}

function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const sequence = useRef(0);
  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);
  const notify = useCallback((text: string, options: ToastOptions = {}) => {
    const id = sequence.current + 1;
    sequence.current = id;
    const item: ToastItem = {
      id,
      text,
      tone: options.tone ?? 'info',
      action: options.action,
    };
    setItems((current) => [...current.slice(-3), item]);
    window.setTimeout(() => dismiss(id), 3500);
  }, [dismiss]);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="pa-toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div className={cx('pa-toast', item.tone === 'error' && 'pa-toast-error')} key={item.id}>
            <span>{item.text}</span>
            {item.action && (
              <button
                type="button"
                className="pa-toast-action"
                onClick={async () => {
                  try {
                    await item.action?.run();
                  } catch (errorValue) {
                    notify(message(errorValue), { tone: 'error' });
                  } finally {
                    dismiss(item.id);
                  }
                }}
              >
                {item.action.label}
              </button>
            )}
            <button
              type="button"
              className="pa-toast-close"
              aria-label="关闭提示"
              onClick={() => dismiss(item.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Confirm dialog                                                      */
/* ------------------------------------------------------------------ */

interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel?: string;
}

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(
  async () => false,
);

function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return useContext(ConfirmContext);
}

function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<{
    options: ConfirmOptions;
    resolve: (value: boolean) => void;
  } | null>(null);
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setRequest({ options, resolve })),
    [],
  );
  const settle = (value: boolean) => {
    request?.resolve(value);
    setRequest(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && (
        <Modal
          title={request.options.title}
          onClose={() => settle(false)}
        >
          <div className="pa-dialog-body">
            <p className="pa-confirm-body">{request.options.body}</p>
          </div>
          <footer className="pa-dialog-footer">
            <button type="button" onClick={() => settle(false)}>取消</button>
            <button
              type="button"
              className="pa-danger"
              data-autofocus
              onClick={() => settle(true)}
            >
              {request.options.confirmLabel ?? '确认'}
            </button>
          </footer>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Base UI                                                             */
/* ------------------------------------------------------------------ */

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  dirty?: boolean;
  wide?: boolean;
}

function Modal({ title, onClose, children, dirty = false, wide = false }: ModalProps) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const confirm = useConfirm();
  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current;
    const target =
      node?.querySelector<HTMLElement>('[data-autofocus]') ??
      node?.querySelector<HTMLElement>(
        'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ) ??
      node;
    target?.focus();
    return () => {
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);
  const attemptClose = async () => {
    if (dirty) {
      const ok = await confirm({
        title: '放弃未保存的修改？',
        body: '关闭后，本次填写的内容不会保存。',
        confirmLabel: '放弃修改',
      });
      if (!ok) return;
    }
    onClose();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      void attemptClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = dialog.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])',
    );
    if (!nodes || nodes.length === 0) return;
    const list = Array.from(nodes);
    const first = list[0];
    const last = list[list.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      className="pa-modal"
      onClick={(event) => {
        if (event.target === event.currentTarget) void attemptClose();
      }}
    >
      <div
        className={cx('pa-dialog', wide && 'pa-dialog-wide')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialog}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header>
          <h2 id={titleId}>{title}</h2>
          <button type="button" aria-label="关闭" onClick={() => void attemptClose()}>
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="pa-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  multiline = false,
  required = false,
  placeholder,
  autofocus = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  required?: boolean;
  placeholder?: string;
  autofocus?: boolean;
}) {
  return (
    <Field label={label}>
      {multiline ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required={required}
          placeholder={placeholder}
        />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required={required}
          placeholder={placeholder}
          data-autofocus={autofocus ? true : undefined}
        />
      )}
    </Field>
  );
}

function EmptyState({
  text,
  actionLabel,
  onAction,
  compact = false,
}: {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={cx('pa-empty', compact && 'pa-empty-small')}>
      <div>
        <p>{text}</p>
        {actionLabel && onAction && (
          <button type="button" className="pa-text-button" onClick={onAction}>
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function SkeletonCards() {
  return (
    <div className="pa-records" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div className="pa-card pa-skeleton" key={index}>
          <div className="pa-skeleton-line" />
          <div className="pa-skeleton-line pa-skeleton-short" />
          <div className="pa-skeleton-line" />
        </div>
      ))}
    </div>
  );
}

function Pager({
  offset,
  total,
  onPage,
}: {
  offset: number;
  total: number;
  onPage: (offset: number) => void;
}) {
  const page = Math.floor(offset / 30) + 1;
  return (
    <div className="pa-pager">
      <button type="button" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - 30))}>
        上一页
      </button>
      <span>第 {page} 页 · 共 {total} 条</span>
      <button
        type="button"
        disabled={offset + 30 >= total}
        onClick={() => onPage(offset + 30)}
      >
        下一页
      </button>
    </div>
  );
}

interface DownloadProps {
  name: string;
  content: () => Promise<string>;
  label: string;
}

function Download({ name, content, label }: DownloadProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const notify = useToast();
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const url = URL.createObjectURL(
              new Blob([await content()], { type: 'text/calendar;charset=utf-8' }),
            );
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = name;
            anchor.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            notify('已导出 ICS');
          } catch (errorValue) {
            const mapped = message(errorValue);
            setError(mapped);
            notify(mapped, { tone: 'error' });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '导出中…' : label}
      </button>
      {error && <span className="pa-error-inline" role="alert">{error}</span>}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Tabs and kinds                                                      */
/* ------------------------------------------------------------------ */

type TabId =
  | 'today'
  | 'memory'
  | 'project'
  | 'calendar'
  | 'task'
  | 'tool'
  | 'report'
  | 'settings';

type Kind = 'memory' | 'project' | 'task' | 'tool' | 'event';

const NAV_TABS: Array<{ id: TabId; label: string }> = [
  { id: 'today', label: '今天' },
  { id: 'memory', label: '记忆' },
  { id: 'project', label: '项目' },
  { id: 'calendar', label: '日历' },
  { id: 'task', label: '任务' },
  { id: 'tool', label: '工具' },
  { id: 'report', label: '日报' },
];

function kindLabel(kind: Kind): string {
  return {
    memory: '记忆',
    project: '项目',
    task: '任务',
    tool: '工具',
    event: '日程',
  }[kind];
}

function statusText(kind: Kind, data: RowData): string {
  if (kind === 'tool') {
    if (data.status === 'active') return '已启用';
    return LABELS[data.status ?? ''] ?? data.status ?? '草稿';
  }
  if (kind === 'memory') {
    return LABELS[data.type ?? ''] ?? data.type ?? '';
  }
  return LABELS[data.status ?? ''] ?? data.status ?? '';
}

function bodyTextOf(kind: Kind, data: RowData): string {
  if (kind === 'memory') return data.body ?? '';
  if (kind === 'project') return data.statement ?? '';
  if (kind === 'task') return data.description ?? '';
  return data.description ?? '';
}

/* ------------------------------------------------------------------ */
/* Editor fields                                                       */
/* ------------------------------------------------------------------ */

interface EditorFieldsProps {
  kind: Kind;
  form: FormState;
  update: (patch: Partial<FormState>) => void;
  projects: Row[];
  timezone: string;
}

function EditorFields({ kind, form, update, projects, timezone }: EditorFieldsProps) {
  const selectProject = (
    <Field label="项目">
      <select
        value={form.projectId}
        onChange={(event) => update({ projectId: event.target.value })}
      >
        <option value="">不归属任何项目</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.data.title}
          </option>
        ))}
      </select>
    </Field>
  );
  let stepsValid = true;
  if (kind === 'tool' && form.kind !== 'script') {
    try {
      stepsValid = Array.isArray(JSON.parse(form.stepsText || '[]'));
    } catch {
      stepsValid = false;
    }
  }
  return (
    <>
      <TextField
        label="名称"
        value={form.title}
        onChange={(value) => update({ title: value })}
        required
        autofocus
      />
      {kind === 'project' && (
        <>
          <TextField
            label="目标"
            value={form.statement}
            onChange={(value) => update({ statement: value })}
            multiline
          />
          <Field label="状态">
            <select
              value={form.status}
              onChange={(event) => update({ status: event.target.value })}
            >
              {['active', 'paused', 'completed', 'archived'].map((value) => (
                <option key={value} value={value}>{LABELS[value]}</option>
              ))}
            </select>
          </Field>
        </>
      )}
      {kind === 'memory' && (
        <>
          <TextField
            label="内容"
            value={form.body}
            onChange={(value) => update({ body: value })}
            multiline
          />
          {!form.id && (
            <Field label="类别">
              <select
                value={form.type}
                onChange={(event) => update({ type: event.target.value })}
              >
                {['fact', 'method', 'episode', 'preference', 'decision', 'goal'].map(
                  (value) => (
                    <option key={value} value={value}>{LABELS[value]}</option>
                  ),
                )}
              </select>
            </Field>
          )}
          {selectProject}
          <TextField
            label="备注"
            value={form.notes}
            onChange={(value) => update({ notes: value })}
            multiline
          />
          <Field label="固定">
            <input
              type="checkbox"
              checked={form.pinned}
              onChange={(event) => update({ pinned: event.target.checked })}
            />
          </Field>
        </>
      )}
      {kind === 'task' && (
        <>
          <TextField
            label="内容"
            value={form.description}
            onChange={(value) => update({ description: value })}
            multiline
          />
          {selectProject}
          <Field label="截止时间">
            <input
              type="datetime-local"
              value={form.dueLocal}
              onChange={(event) => update({ dueLocal: event.target.value })}
            />
          </Field>
          <Field label="状态">
            <select
              value={form.status}
              onChange={(event) => update({ status: event.target.value })}
            >
              {['todo', 'scheduled', 'running', 'needs-review', 'completed', 'cancelled', 'failed'].map(
                (value) => (
                  <option key={value} value={value}>{LABELS[value]}</option>
                ),
              )}
            </select>
          </Field>
        </>
      )}
      {kind === 'event' && (
        <>
          {form.occurrenceKey && (
            <Field label="修改范围">
              <select
                value={form.scope}
                onChange={(event) => {
                  const scope = event.target.value;
                  update({
                    scope,
                    startLocal:
                      scope === 'series'
                        ? form.seriesStart || form.startLocal
                        : form.instanceStart || form.startLocal,
                    endLocal:
                      scope === 'series'
                        ? form.seriesEnd || form.endLocal
                        : form.instanceEnd || form.endLocal,
                  });
                }}
              >
                <option value="occurrence">本次</option>
                <option value="series">整个系列</option>
              </select>
            </Field>
          )}
          <Field label="全天">
            <input
              type="checkbox"
              checked={form.allDay}
              onChange={(event) => update({ allDay: event.target.checked })}
            />
          </Field>
          <div className="pa-grid2">
            <Field label="开始">
              <input
                type={form.allDay ? 'date' : 'datetime-local'}
                value={form.allDay ? form.startLocal.slice(0, 10) : form.startLocal}
                onChange={(event) => update({ startLocal: event.target.value })}
                required
              />
            </Field>
            <Field label="结束">
              <input
                type={form.allDay ? 'date' : 'datetime-local'}
                value={form.allDay ? form.endLocal.slice(0, 10) : form.endLocal}
                onChange={(event) => update({ endLocal: event.target.value })}
                required
              />
            </Field>
          </div>
          <Field label="时区">
            <select
              value={form.timezone}
              onChange={(event) => update({ timezone: event.target.value })}
            >
              {Array.from(new Set([form.timezone, timezone, ...TIMEZONES])).map((zone) => (
                <option key={zone} value={zone}>{zone}</option>
              ))}
            </select>
          </Field>
          <Field label="重复">
            <select
              value={form.repeat}
              onChange={(event) => update({ repeat: event.target.value })}
            >
              <option value="none">不重复</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
              <option value="custom">自定义</option>
            </select>
          </Field>
          {form.repeat === 'custom' && (
            <TextField
              label="重复规则"
              value={form.recurrence}
              onChange={(value) => update({ recurrence: value })}
              placeholder="FREQ=WEEKLY;BYDAY=MO"
            />
          )}
          {selectProject}
          <TextField
            label="地点"
            value={form.location}
            onChange={(value) => update({ location: value })}
          />
          <TextField
            label="备注"
            value={form.description}
            onChange={(value) => update({ description: value })}
            multiline
          />
        </>
      )}
      {['project', 'memory', 'task', 'event'].includes(kind) && (
        <TextField
          label="领域"
          value={form.domainsText}
          onChange={(value) => update({ domainsText: value })}
          placeholder="用逗号分隔"
        />
      )}
      {['task', 'event', 'memory'].includes(kind) && (
        <Field label="重要性">
          <select
            value={form.importance}
            onChange={(event) => update({ importance: Number(event.target.value) })}
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </Field>
      )}
      {kind === 'tool' && (
        <>
          <TextField
            label="用途"
            value={form.description}
            onChange={(value) => update({ description: value })}
            multiline
          />
          <Field label="类型">
            <select
              value={form.kind}
              onChange={(event) => update({ kind: event.target.value })}
            >
              <option value="workflow">工作流</option>
              <option value="script">脚本</option>
            </select>
          </Field>
          {form.kind === 'script' ? (
            <>
              <Field label="语言">
                <select
                  value={form.language}
                  onChange={(event) => update({ language: event.target.value })}
                >
                  <option value="javascript">JavaScript</option>
                  <option value="python">Python</option>
                  <option value="shell">Shell</option>
                </select>
              </Field>
              <TextField
                label="源码"
                value={form.source}
                onChange={(value) => update({ source: value })}
                multiline
              />
            </>
          ) : (
            <>
              <TextField
                label="工作流步骤"
                value={form.stepsText}
                onChange={(value) => update({ stepsText: value })}
                multiline
              />
              <p className={cx('pa-hint', !stepsValid && 'pa-hint-error')}>
                {stepsValid
                  ? '步骤为 JSON 数组，每项包含 tool 与 args。'
                  : '步骤需要是 JSON 数组，保存前请修正。'}
              </p>
            </>
          )}
          <TextField
            label="能力"
            value={form.capabilitiesText}
            onChange={(value) => update({ capabilitiesText: value })}
            placeholder="read-files, network"
          />
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Merged detail / edit dialog                                         */
/* ------------------------------------------------------------------ */

interface RecordDialogProps {
  api: Api;
  kind: Kind;
  seed?: Row;
  initialMode?: 'read' | 'edit';
  create?: boolean;
  projects: Row[];
  timezone: string;
  onClose: () => void;
  onChanged: () => void;
  inline?: boolean;
  onQuickCreate?: (kind: 'task', projectId: string) => void;
}

function RecordDialog({
  api,
  kind,
  seed,
  initialMode = 'read',
  create = false,
  projects,
  timezone,
  onClose,
  onChanged,
  inline = false,
  onQuickCreate,
}: RecordDialogProps) {
  const [row, setRow] = useState<Row | null>(seed ?? null);
  const [mode, setMode] = useState<'read' | 'edit'>(create ? 'edit' : initialMode);
  const [form, setForm] = useState<FormState>(() =>
    formFromRow(kind, seed, timezone),
  );
  const [baseline, setBaseline] = useState<FormState>(() =>
    formFromRow(kind, seed, timezone),
  );
  const [relations, setRelations] = useState<Relation[]>([]);
  const [related, setRelated] = useState<RelatedMemory[]>([]);
  const [projectTasks, setProjectTasks] = useState<Row[]>([]);
  const [projectCounts, setProjectCounts] = useState({ memory: 0, task: 0 });
  const relatedRef = useRef<HTMLElement | null>(null);
  const [loading, setLoading] = useState(!create);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const notify = useToast();
  const confirm = useConfirm();

  const update = (patch: Partial<FormState>) =>
    setForm((current) => ({ ...current, ...patch }));

  const loadRelations = useCallback(async (id: string) => {
    try {
      const rows = await command<Relation[]>(api, 'relations', { id });
      setRelations(rows);
      if (kind === 'project') {
        const [memories, tasks, memoryTotal, taskTotal] = await Promise.all([
          command<RelatedMemory[]>(api, 'related', { projectId: id }),
          command<ListResult>(api, 'list', {
            kind: 'task',
            projectId: id,
            limit: 8,
            sort: 'updated',
          }),
          command<ListResult>(api, 'list', { kind: 'memory', projectId: id, limit: 1 }),
          command<ListResult>(api, 'list', { kind: 'task', projectId: id, limit: 1 }),
        ]);
        setRelated(memories);
        setProjectTasks(tasks.items);
        setProjectCounts({
          memory: memoryTotal.total,
          task: taskTotal.total,
        });
      }
    } catch {
      setRelations([]);
    }
  }, [api, kind]);

  useEffect(() => {
    if (create || !seed) return;
    let live = true;
    const load = async () => {
      try {
        const fresh = await command<Row>(api, 'get', { id: seed.id });
        if (!live) return;
        setRow(fresh);
        setForm(formFromRow(kind, fresh, timezone));
        setBaseline(formFromRow(kind, fresh, timezone));
        await loadRelations(seed.id);
      } catch (errorValue) {
        if (live) setError(message(errorValue));
      } finally {
        if (live) setLoading(false);
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [api, create, kind, seed, timezone, loadRelations]);

  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const title = create
    ? `新建${kindLabel(kind)}`
    : row?.data.title ?? `${kindLabel(kind)}详情`;

  const requestClose = async () => {
    if (dirty) {
      const ok = await confirm({
        title: '放弃未保存的修改？',
        body: '关闭后，本次填写的内容不会保存。',
        confirmLabel: '放弃修改',
      });
      if (!ok) return;
    }
    onClose();
  };

  useEffect(() => {
    if (!inline) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('.pa-modal')) return;
      event.preventDefault();
      void requestClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim()) {
      const mapped = '请填写名称。';
      setError(mapped);
      notify(mapped, { tone: 'error' });
      return;
    }
    setSaving(true);
    setError('');
    try {
      await persistRecord(api, kind, form, timezone);
      if (form.id) {
        const fresh = await command<Row>(api, 'get', { id: form.id });
        setRow(fresh);
        setForm(formFromRow(kind, fresh, timezone));
        setBaseline(formFromRow(kind, fresh, timezone));
        setMode('read');
        await loadRelations(form.id);
        notify('已保存');
        onChanged();
      } else {
        notify(`${kindLabel(kind)}已创建`);
        onChanged();
        onClose();
      }
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!row) return;
    const ok = await confirm({
      title: `删除${kindLabel(kind)}？`,
      body: `将删除「${row.data.title ?? '未命名'}」，并一并移除它的关联记录。此操作不可撤销。`,
      confirmLabel: '删除',
    });
    if (!ok) return;
    setSaving(true);
    setError('');
    try {
      await command(api, 'remove', { id: row.id, revision: row.revision });
      notify('已删除');
      onChanged();
      onClose();
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const run = async () => {
    if (!row) return;
    setBusyKey('run');
    try {
      await api('task.run', {
        ...(kind === 'task' ? { taskId: row.id } : { toolId: row.id }),
        requestId: crypto.randomUUID(),
      });
      notify('已提交执行');
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setBusyKey('');
    }
  };

  const associate = async (memory: RelatedMemory) => {
    if (!row) return;
    setBusyKey(`associate:${memory.id}`);
    try {
      await command(api, 'associate', {
        projectId: row.id,
        memories: [{ id: memory.id, revision: memory.revision }],
      });
      notify('已关联');
      await loadRelations(row.id);
      onChanged();
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setBusyKey('');
    }
  };

  const data = row?.data ?? {};
  const body = bodyTextOf(kind, data);
  const meta: Array<{ label: string; value: string }> = [];
  if (data.status) meta.push({ label: '状态', value: statusText(kind, data) });
  if (kind === 'memory' && data.type) {
    meta.push({ label: '类别', value: LABELS[data.type] ?? data.type });
  }
  if (data.importance) meta.push({ label: '重要性', value: String(data.importance) });
  if ((data.domains ?? []).length > 0) {
    meta.push({ label: '领域', value: (data.domains ?? []).join('、') });
  }
  if (data.dueAt) meta.push({ label: '截止', value: formatDate(data.dueAt, timezone) });
  if (row?.projectId) {
    const project = projects.find((item) => item.id === row?.projectId);
    if (project) meta.push({ label: '项目', value: project.data.title ?? '' });
  }
  if (kind === 'event' && data.start) {
    meta.push({ label: '开始', value: formatDate(data.start, timezone) });
  }
  if (data.location) meta.push({ label: '地点', value: data.location });

  const projectName = row?.projectId
    ? projects.find((item) => item.id === row?.projectId)?.data.title ?? ''
    : '';
  const facts = data.canonicalFacts ?? data.facts ?? [];
  const memoryRelations = relations.filter((relation) => relation.object.kind === 'memory');
  const otherRelations = relations.filter((relation) => relation.object.kind !== 'memory');
  const relationLabel = (relation: Relation) =>
    ({
      contains: '所属',
      applies_to: '复用',
      about: '主题',
      related_to: '相关',
    })[relation.kind] ?? relation.kind;

  const refreshRecord = async () => {
    if (row) {
      try {
        const fresh = await command<Row>(api, 'get', { id: row.id });
        setRow(fresh);
        setForm(formFromRow(kind, fresh, timezone));
        setBaseline(formFromRow(kind, fresh, timezone));
      } catch {
        /* keep the stale view; the parent refresh still runs */
      }
    }
    onChanged();
  };

  const metaNode =
    meta.length > 0 ? (
      <div className="pa-detail-meta">
        {meta.map((item) => (
          <span className="pa-tag" key={item.label}>
            {item.label}：{item.value}
          </span>
        ))}
      </div>
    ) : null;

  const observationsNode = (data.observations ?? []).length > 0 && (
    <section className="pa-detail-section">
      <h3>观察记录</h3>
      {(data.observations ?? []).map((item, index) => (
        <div className="pa-meta" key={`${item.at}-${index}`}>
          {formatDate(item.at, timezone)} {item.body ?? ''}
        </div>
      ))}
    </section>
  );

  const content = loading ? (
    <div className="pa-dialog-body">
      <div className="pa-skeleton-line" />
      <div className="pa-skeleton-line pa-skeleton-short" />
    </div>
  ) : mode === 'read' ? (
    <>
      {kind === 'memory' ? (
        <>
          <div className="pa-detail">
            <section className="pa-detail-section pa-detail-first">
              <h3>概要</h3>
              {metaNode}
              {body && <p className="pa-detail-body">{body}</p>}
              {data.notes && <p className="pa-detail-note">{data.notes}</p>}
              {observationsNode}
            </section>
            <section className="pa-detail-section">
              <h3>事实</h3>
              {facts.length === 0 ? (
                <p className="pa-detail-note">还没有提炼出结构化事实。</p>
              ) : (
                facts.map((fact, index) => (
                  <article key={`${fact.subject ?? ''}-${index}`}>
                    <h3>
                      {fact.subject || '—'}
                      {fact.predicate ? ` · ${fact.predicate}` : ''}
                    </h3>
                    <p>{fact.value || '—'}</p>
                  </article>
                ))
              )}
              {(data.originalClaims ?? []).length > 0 && (
                <div className="pa-claims">
                  <h4>原话</h4>
                  {(data.originalClaims ?? []).map((claim, index) => (
                    <blockquote key={`${claim.at}-${index}`}>
                      {claim.quote ?? claim.body}
                      <cite>{formatDate(claim.at, timezone)}</cite>
                    </blockquote>
                  ))}
                </div>
              )}
            </section>
            <section className="pa-detail-section">
              <h3>关联</h3>
              {projectName && <p className="pa-meta">所属项目：{projectName}</p>}
              {memoryRelations.length > 0 && (
                <div className="pa-related-list">
                  <h4>相关记忆</h4>
                  {memoryRelations.map((relation) => (
                    <article key={relation.id}>
                      <span className="pa-tag">{relationLabel(relation)}</span>
                      <h3>{relation.object.data.title || '未命名记忆'}</h3>
                      <p>{bodyTextOf('memory', relation.object.data)}</p>
                    </article>
                  ))}
                </div>
              )}
              {otherRelations.length > 0 && (
                <div className="pa-related-list">
                  <h4>关系</h4>
                  {otherRelations.map((relation) => (
                    <article key={relation.id}>
                      <span className="pa-tag">{relationLabel(relation)}</span>
                      <h3>
                        {relation.object.data.title ||
                          relation.object.data.name ||
                          '未命名'}
                      </h3>
                    </article>
                  ))}
                </div>
              )}
              {!projectName && relations.length === 0 && (
                <p className="pa-detail-note">暂无关联。</p>
              )}
            </section>
            {row && <RecordHistory api={api} id={row.id} />}
            {error && <div role="alert" className="pa-error">{error}</div>}
          </div>
          <footer className="pa-dialog-footer">
            <button type="button" onClick={onClose}>关闭</button>
            <button
              type="button"
              className="pa-primary"
              onClick={() => setMode('edit')}
            >
              编辑
            </button>
          </footer>
        </>
      ) : kind === 'project' ? (
        <>
          <div className="pa-detail">
            <section className="pa-detail-section pa-detail-first">
              <h3>概览</h3>
              {metaNode}
              {data.statement && <p className="pa-detail-body">{data.statement}</p>}
              <div className="pa-tags">
                <span className="pa-tag">记忆 {projectCounts.memory}</span>
                <span className="pa-tag">任务 {projectCounts.task}</span>
              </div>
              {Object.entries(data.context ?? {}).length > 0 && (
                <div className="pa-context">
                  <h4>上下文</h4>
                  {Object.entries(data.context ?? {}).map(([key, value]) => (
                    <div className="pa-meta" key={key}>
                      <b>{key}</b>：{textOf(value) || '—'}
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section className="pa-detail-section" ref={relatedRef}>
              <h3>相关记忆</h3>
              {relations.filter((relation) => relation.object.kind === 'memory').length > 0 && (
                <div className="pa-related-list">
                  <h4>已关联</h4>
                  {relations
                    .filter((relation) => relation.object.kind === 'memory')
                    .map((relation) => (
                      <article key={relation.id}>
                        <span className="pa-tag">记忆</span>
                        <h3>{relation.object.data.title || '未命名记忆'}</h3>
                        <p>{bodyTextOf('memory', relation.object.data)}</p>
                      </article>
                    ))}
                </div>
              )}
              {related.length === 0 && relations.filter((relation) => relation.object.kind === 'memory').length === 0 ? (
                <p className="pa-detail-note">还没有关联记忆，可在下方选择候选记忆关联。</p>
              ) : (
                related.map((memory) => (
                  <article key={memory.id}>
                    <h3>{memory.title || '未命名记忆'}</h3>
                    <p>{memory.body}</p>
                    <button
                      type="button"
                      disabled={busyKey !== ''}
                      onClick={() => void associate(memory)}
                    >
                      {busyKey === `associate:${memory.id}` ? '处理中…' : '关联'}
                    </button>
                  </article>
                ))
              )}
            </section>
            <section className="pa-detail-section">
              <h3>关联任务</h3>
              {projectTasks.length === 0 ? (
                <p className="pa-detail-note">这个项目下还没有任务。</p>
              ) : (
                projectTasks.map((task) => (
                  <article key={task.id}>
                    <h3>{task.data.title || '未命名任务'}</h3>
                    <p>
                      {statusText('task', task.data)}
                      {task.data.dueAt ? ` · 截止 ${formatDate(task.data.dueAt, timezone)}` : ''}
                    </p>
                  </article>
                ))
              )}
            </section>
            {row && <RecordHistory api={api} id={row.id} />}
            {error && <div role="alert" className="pa-error">{error}</div>}
          </div>
          <footer className="pa-dialog-footer">
            <button
              type="button"
              onClick={() => {
                if (row && onQuickCreate) onQuickCreate('task', row.id);
                else notify('请回到项目列表，在工具栏新建任务。');
              }}
            >
              新建任务
            </button>
            <button
              type="button"
              onClick={() => relatedRef.current?.scrollIntoView({ block: 'nearest' })}
            >
              关联记忆
            </button>
            <button type="button" onClick={onClose}>关闭</button>
            <button
              type="button"
              className="pa-primary"
              onClick={() => setMode('edit')}
            >
              编辑项目
            </button>
          </footer>
        </>
      ) : (
        <>
          <div className="pa-detail">
            {metaNode}
            {body && <p className="pa-detail-body">{body}</p>}
            {data.notes && <p className="pa-detail-note">{data.notes}</p>}
            {data.result && <pre>{data.result}</pre>}
            {observationsNode}
            {kind === 'tool' && row && (
              <ToolVersions
                api={api}
                tool={row}
                timezone={timezone}
                onChange={async () => {
                  const fresh = await command<Row>(api, 'get', { id: row.id });
                  setRow(fresh);
                  onChanged();
                }}
              />
            )}
            {relations.length > 0 && (
              <section className="pa-detail-section">
                <h3>关联</h3>
                {relations.map((relation) => (
                  <article key={relation.id}>
                    <span className="pa-tag">{relationLabel(relation)}</span>
                    <h3>{relation.object.data.title || relation.object.data.name || '未命名'}</h3>
                  </article>
                ))}
              </section>
            )}
            {error && <div role="alert" className="pa-error">{error}</div>}
          </div>
          <footer className="pa-dialog-footer">
            {(kind === 'task' || kind === 'tool') && (
              <button
                type="button"
                disabled={busyKey !== '' || (kind === 'tool' && !data.activeVersion)}
                onClick={() => void run()}
              >
                {busyKey === 'run' ? '处理中…' : '执行'}
              </button>
            )}
            <button type="button" onClick={onClose}>关闭</button>
            <button
              type="button"
              className="pa-primary"
              onClick={() => setMode('edit')}
            >
              编辑
            </button>
          </footer>
        </>
      )}
    </>
  ) : (
    <form onSubmit={(event) => void handleSave(event)}>
      <div className="pa-dialog-body">
        <EditorFields
          kind={kind}
          form={form}
          update={update}
          projects={projects}
          timezone={timezone}
        />
        {error && <div role="alert" className="pa-error">{error}</div>}
      </div>
      <footer className="pa-dialog-footer">
        {row && (
          <button
            type="button"
            className="pa-danger"
            disabled={saving}
            onClick={() => void handleDelete()}
          >
            删除
          </button>
        )}
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            if (row) {
              setForm(formFromRow(kind, row, timezone));
              setBaseline(formFromRow(kind, row, timezone));
              setError('');
              setMode('read');
            } else {
              onClose();
            }
          }}
        >
          取消
        </button>
        <button className="pa-primary" type="submit" disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
      </footer>
    </form>
  );

  if (inline) {
    return (
      <section className="pa-split-detail" aria-label={title}>
        <header className="pa-split-head">
          <h2>{title}</h2>
          <button type="button" aria-label="关闭详情" onClick={() => void requestClose()}>
            ×
          </button>
        </header>
        {content}
      </section>
    );
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      dirty={dirty}
      wide={mode === 'edit' && kind === 'event'}
    >
      {content}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Record history (recent changes touching one node)                   */
/* ------------------------------------------------------------------ */

function changeActionLabel(action: string): string {
  const labels: Record<string,string> = {created:'创建',updated:'更新',deleted:'删除',removed:'删除',merged:'合并',
    moved:'移动',split:'拆分',renamed:'改名',archived:'归档',restored:'恢复',attached:'关联',detached:'解除关联',
    bound:'会话归属',unresolved:'未决',failed:'失败',applied:'已执行',open:'待处理',planned:'已规划',resolved:'已解决',
    dismissed:'已关闭',ran:'已运行',confirmed:'已完成'};
  return labels[action] ?? action ?? '变更';
}

function changeStatusLabel(status: string): string {
  return status === 'applied' ? '已应用' : '已归档';
}

function RecordHistory({
  api,
  id,
}: {
  api: Api;
  id: string;
}) {
  const [entries, setEntries] = useState<Array<{ change: ChangeDetail; item: ChangeItem }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const changes = await command<ChangeRecord[]>(api, 'changes', { offset: 0 });
      const recent = (changes ?? []).slice(0, 12);
      const details = await Promise.all(
        recent.map((change) =>
          command<ChangeDetail>(api, 'change', { id: change.id }).catch(() => null),
        ),
      );
      const found: Array<{ change: ChangeDetail; item: ChangeItem }> = [];
      for (const detail of details) {
        if (!detail) continue;
        for (const item of detail.items ?? []) {
          if (item.objectId === id) found.push({ change: detail, item });
        }
      }
      setEntries(found);
      setError('');
    } catch (err) {
      setError(message(err));
    } finally {
      setLoading(false);
    }
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <section className="pa-detail-section">
        <h3>变更历史</h3>
        <p className="pa-detail-note">正在读取最近整理记录…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section className="pa-detail-section">
        <h3>变更历史</h3>
        <p className="pa-error-inline">{error}</p>
      </section>
    );
  }
  return (
    <section className="pa-detail-section">
      <h3>变更历史</h3>
      {entries.length === 0 ? (
        <p className="pa-detail-note">最近没有涉及这条记录的整理变更。</p>
      ) : (
        entries.map(({ change, item }, index) => (
          <article
            key={`${change.id}:${item.objectId ?? index}:${index}`}
            className="pa-history-entry"
          >
            <div className="pa-card-head">
              <h3>{item.title || '这条记录'}</h3>
              <span className="pa-tag">{changeActionLabel(item.action)}</span>
            </div>
            <p className="pa-meta">
              {formatDate(change.createdAt)} · {changeStatusLabel(change.status)}
            </p>
            {item.detail && <p className="pa-detail-note">{item.detail}</p>}
          </article>
        ))
      )}
      <p className="pa-meta">仅显示最近 12 条整理记录中涉及这条记录的变更。</p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Memory timeline                                                     */
/* ------------------------------------------------------------------ */

function MemoryTimeline({
  rows,
  projects,
  timezone,
  onOpen,
}: {
  rows: Row[];
  projects: Row[];
  timezone: string;
  onOpen: (row: Row) => void;
}) {
  const groups = useMemo(() => {
    const sorted = [...rows].sort((a, b) => updatedTime(b) - updatedTime(a));
    const map = new Map<string, Row[]>();
    for (const row of sorted) {
      const month = new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone || undefined,
        year: 'numeric',
        month: 'long',
      }).format(new Date(updatedTime(row)));
      const list = map.get(month) ?? [];
      list.push(row);
      map.set(month, list);
    }
    return Array.from(map.entries());
  }, [rows, timezone]);

  const projectTitle = (projectId?: string | null) =>
    projects.find((project) => project.id === projectId)?.data.title ?? '';

  return (
    <div className="pa-timeline">
      {groups.map(([month, items]) => (
        <section key={month} className="pa-timeline-month">
          <div className="pa-timeline-month-label">{month}</div>
          <div className="pa-timeline-items">
            {items.map((row) => {
              const project = projectTitle(row.projectId);
              const observed = row.data.observations?.at(-1)?.at ?? updatedTime(row);
              return (
                <article key={row.id} className="pa-timeline-item">
                  <div className="pa-timeline-date">
                    {new Intl.DateTimeFormat('zh-CN', {
                      timeZone: timezone || undefined,
                      month: '2-digit',
                      day: '2-digit',
                    }).format(new Date(updatedTime(row)))}
                  </div>
                  <div className="pa-timeline-main">
                    <div className="pa-timeline-head">
                      <span className="pa-tag">{LABELS[row.data.type ?? ''] ?? '记忆'}</span>
                      <button
                        type="button"
                        className="pa-title"
                        onClick={() => onOpen(row)}
                      >
                        {row.data.title || '未命名记忆'}
                      </button>
                    </div>
                    <p className="pa-clamp">{bodyTextOf('memory', row.data) || '（无摘要）'}</p>
                    <div className="pa-tags">
                      {project && <span className="pa-tag">{project}</span>}
                      {(row.data.domains ?? []).map((domain) => (
                        <span key={domain} className="pa-tag">
                          {domain}
                        </span>
                      ))}
                    </div>
                    <div className="pa-timeline-meta">
                      <span>最后观察 {formatDate(observed, timezone)}</span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Command palette (⌘K)                                                */
/* ------------------------------------------------------------------ */

const SEARCH_ORDER: SearchKind[] = [
  'memory',
  'project',
  'task',
  'event',
  'tool',
  'entity',
];

const SEARCH_KIND_LABEL: Record<SearchKind, string> = {
  memory: '记忆',
  project: '项目',
  task: '任务',
  event: '事件',
  tool: '工具',
  entity: '实体',
};

interface CommandEntry {
  id: string;
  label: string;
  run: () => void;
}

function CommandPalette({
  api,
  density,
  onClose,
  onNavigate,
  onOpenItem,
  onCreateMemory,
  onMaintain,
  onExport,
  onToggleDensity,
  onHelp,
}: {
  api: Api;
  density: Density;
  onClose: () => void;
  onNavigate: (tab: TabId) => void;
  onOpenItem: (item: SearchItem) => void;
  onCreateMemory: () => void;
  onMaintain: () => void;
  onExport: () => void;
  onToggleDensity: () => void;
  onHelp: () => void;
}) {
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 200);
  const [results, setResults] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const text = debounced.trim();
    if (!text) {
      setResults(null);
      setSearching(false);
      setError('');
      return;
    }
    let live = true;
    setSearching(true);
    command<SearchResult>(api, 'searchAll', { query: text, limit: 20 })
      .then((value) => {
        if (!live) return;
        setResults(value);
        setError('');
      })
      .catch((err) => {
        if (!live) return;
        setError(message(err));
        setResults(null);
      })
      .finally(() => {
        if (live) setSearching(false);
      });
    return () => {
      live = false;
    };
  }, [api, debounced]);

  const commands: CommandEntry[] = [
    { id: 'today', label: '切换到 今天', run: () => onNavigate('today') },
    { id: 'memory', label: '切换到 记忆', run: () => onNavigate('memory') },
    { id: 'project', label: '切换到 项目', run: () => onNavigate('project') },
    { id: 'calendar', label: '切换到 日历', run: () => onNavigate('calendar') },
    { id: 'task', label: '切换到 任务', run: () => onNavigate('task') },
    { id: 'tool', label: '切换到 工具', run: () => onNavigate('tool') },
    { id: 'report', label: '切换到 日报', run: () => onNavigate('report') },
    { id: 'settings', label: '切换到 设置', run: () => onNavigate('settings') },
    { id: 'new-memory', label: '新建记忆', run: onCreateMemory },
    { id: 'maintain', label: '立即整理', run: onMaintain },
    { id: 'export', label: '导出数据', run: onExport },
    {
      id: 'density',
      label: `切换界面密度（当前：${density === 'compact' ? '紧凑' : '标准'}）`,
      run: onToggleDensity,
    },
    { id: 'help', label: '快捷键帮助', run: onHelp },
  ];

  const groups: Array<{ title: string; items: SearchItem[] }> = [];
  if (results) {
    for (const kind of SEARCH_ORDER) {
      const items = results.groups[kind] ?? [];
      if (items.length > 0) groups.push({ title: SEARCH_KIND_LABEL[kind], items });
    }
  }
  const lower = query.trim().toLowerCase();
  const visibleCommands = commands.filter(
    (entry) => !lower || entry.label.toLowerCase().includes(lower),
  );
  const totalEntries =
    groups.reduce((sum, group) => sum + group.items.length, 0) + visibleCommands.length;

  useEffect(() => {
    setActive(0);
  }, [debounced]);

  useEffect(() => {
    if (active < 0) setActive(0);
    if (active >= totalEntries) setActive(Math.max(0, totalEntries - 1));
  }, [active, totalEntries]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('.pa-palette-item.pa-active')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const runEntry = (entry: () => void) => {
    onClose();
    entry();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if ((event.nativeEvent as { isComposing?: boolean }).isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (totalEntries > 0) setActive((value) => (value + 1) % totalEntries);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (totalEntries > 0) setActive((value) => (value - 1 + totalEntries) % totalEntries);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const searchItems = groups.flatMap((group) => group.items);
      if (active < searchItems.length) {
        const item = searchItems[active];
        const entry = item;
        onClose();
        onOpenItem(entry);
      } else {
        const entry = visibleCommands[active - searchItems.length];
        if (entry) runEntry(entry.run);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  let index = 0;
  return (
    <Modal title="搜索与命令" onClose={onClose} wide>
      <div className="pa-palette">
        <input
          className="pa-palette-input"
          data-autofocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜索记忆、项目、任务、事件、工具、实体，或输入命令…"
          aria-label="搜索与命令"
          role="combobox"
          aria-expanded="true"
          aria-controls="pa-palette-list"
          aria-activedescendant={
            totalEntries > 0 ? `pa-palette-option-${active}` : undefined
          }
        />
        <div className="pa-palette-body" id="pa-palette-list" role="listbox" ref={listRef}>
          {searching && <div className="pa-palette-empty">搜索中…</div>}
          {!searching && error && <p className="pa-error-inline">{error}</p>}
          {!searching && !error && totalEntries === 0 && (
            <div className="pa-palette-empty">
              {query.trim() ? '没有匹配结果。' : '输入关键词开始搜索，或选择下方命令。'}
            </div>
          )}
          {groups.map((group) => (
            <section key={group.title} className="pa-palette-group">
              <h3>{group.title}</h3>
              <div className="pa-palette-list">
                {group.items.map((item) => {
                  const current = index++;
                  return (
                    <button
                      key={`${item.kind}:${item.id}`}
                      id={`pa-palette-option-${current}`}
                      type="button"
                      role="option"
                      aria-selected={active === current}
                      className={cx('pa-palette-item', active === current && 'pa-active')}
                      onMouseEnter={() => setActive(current)}
                      onClick={() => {
                        onClose();
                        onOpenItem(item);
                      }}
                    >
                      <span className="pa-palette-kind">{SEARCH_KIND_LABEL[item.kind]}</span>
                      <strong>{item.title || '（无标题）'}</strong>
                      {item.snippet && (
                        <span className="pa-palette-snippet">{item.snippet}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {visibleCommands.length > 0 && (
            <section className="pa-palette-group">
              <h3>命令</h3>
              <div className="pa-palette-list">
                {visibleCommands.map((entry) => {
                  const current = index++;
                  return (
                    <button
                      key={entry.id}
                      id={`pa-palette-option-${current}`}
                      type="button"
                      role="option"
                      aria-selected={active === current}
                      className={cx('pa-palette-item', active === current && 'pa-active')}
                      onMouseEnter={() => setActive(current)}
                      onClick={() => runEntry(entry.run)}
                    >
                      <strong>{entry.label}</strong>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>
        <div className="pa-palette-foot">
          <span>
            <span className="pa-kbd">↑</span>
            <span className="pa-kbd">↓</span> 选择
          </span>
          <span>
            <span className="pa-kbd">Enter</span> 打开
          </span>
          <span>
            <span className="pa-kbd">Esc</span> 关闭
          </span>
          <span>⌘K 随时呼出</span>
        </div>
      </div>
    </Modal>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const items: Array<{ keys: string[]; text: string }> = [
    { keys: ['⌘', 'K'], text: '打开全局搜索与命令面板' },
    { keys: ['Ctrl', 'K'], text: '同上（Windows / Linux）' },
    { keys: ['/'], text: '聚焦当前页面的搜索框' },
    { keys: ['n'], text: '在当前页面新建记录' },
    { keys: ['?'], text: '打开本快捷键帮助' },
    { keys: ['Esc'], text: '关闭弹窗 / 面板，焦点回到原处' },
    { keys: ['↑', '↓'], text: '在搜索结果中移动' },
    { keys: ['Enter'], text: '打开选中的结果或执行命令' },
  ];
  return (
    <Modal title="快捷键帮助" onClose={onClose}>
      <div className="pa-dialog-body">
        <dl className="pa-help-list">
          {items.map((item) => (
            <div key={item.text} style={{ display: 'contents' }}>
              <dt>
                {item.keys.map((key) => (
                  <span className="pa-kbd" key={key}>
                    {key}
                  </span>
                ))}
              </dt>
              <dd>{item.text}</dd>
            </div>
          ))}
        </dl>
        <p className="pa-detail-note">
          快捷键在输入框内不会触发；打开弹窗时按 Esc 先关闭最上层弹窗。
        </p>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Entity peek                                                         */
/* ------------------------------------------------------------------ */

function EntityPeek({
  api,
  id,
  onClose,
}: {
  api: Api;
  id: string;
  onClose: () => void;
}) {
  const [row, setRow] = useState<Row | null>(null);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([
      command<Row>(api, 'get', { id }),
      command<Relation[]>(api, 'relations', { id }).catch(() => []),
    ])
      .then(([value, edges]) => {
        if (!live) return;
        setRow(value);
        setRelations(edges ?? []);
        setError('');
      })
      .catch((err) => {
        if (live) setError(message(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, id]);

  const data = row?.data ?? {};
  return (
    <Modal title={data.name || data.title || '实体详情'} onClose={onClose}>
      {loading ? (
        <div className="pa-dialog-body">
          <p className="pa-detail-note">正在读取实体…</p>
        </div>
      ) : error ? (
        <div className="pa-dialog-body">
          <p className="pa-error-inline">{error}</p>
        </div>
      ) : (
        <>
          <div className="pa-detail">
            <div className="pa-detail-meta">
              <span className="pa-tag">{LABELS[data.type ?? ''] ?? data.type ?? '实体'}</span>
              {(data.domains ?? []).map((domain) => (
                <span className="pa-tag" key={domain}>
                  {domain}
                </span>
              ))}
            </div>
            {(data.aliases ?? []).length > 0 && (
              <div className="pa-detail-section">
                <h3>别名</h3>
                <div className="pa-tags">
                  {(data.aliases ?? []).map((alias) => (
                    <span className="pa-tag" key={alias}>
                      {alias}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="pa-detail-section">
              <h3>关联</h3>
              {relations.length === 0 ? (
                <p className="pa-detail-note">暂无关联。</p>
              ) : (
                relations.map((relation) => (
                  <article key={relation.id}>
                    <h3>{relation.object.data.title || relation.object.data.name || '未命名'}</h3>
                    <p>
                      {LABELS[relation.kind] ?? relation.kind} ·{' '}
                      {relation.direction ?? ''}
                    </p>
                  </article>
                ))
              )}
            </div>
          </div>
          <footer className="pa-dialog-footer">
            <button type="button" onClick={onClose}>
              关闭
            </button>
          </footer>
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Data health                                                         */
/* ------------------------------------------------------------------ */

function DataHealth({ api, root }: { api: Api; root: string }) {
  const notify = useToast();
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [lastExport, setLastExport] = useState(readLastExport);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [report, summary] = await Promise.all([
        command<HealthReport>(api, 'health', {}),
        command<Overview>(api, 'overview'),
      ]);
      setHealth(report ?? null);
      setOverview(summary ?? null);
      setError('');
    } catch (err) {
      setError(message(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const maintain = async () => {
    setBusy('maintain');
    try {
      await api('maintenance.run', { requestId: crypto.randomUUID() });
      notify('已安排立即整理');
      window.setTimeout(() => void load(), 1200);
    } catch (err) {
      notify(message(err), { tone: 'error' });
    } finally {
      setBusy('');
    }
  };

  const exportData = async () => {
    setBusy('export');
    try {
      const record = await exportBackup(api);
      if (!record) return;
      try {
        localStorage.setItem('pa.lastExport', JSON.stringify(record));
      } catch {
        /* ignore storage failures */
      }
      setLastExport(record);
      notify(`已导出 ${record.name}`);
    } catch (err) {
      notify(message(err), { tone: 'error' });
    } finally {
      setBusy('');
    }
  };

  const openDirectory = async () => {
    const path = health?.dataRoot || overview?.dataRoot || root;
    if (!path) {
      notify('还没有可用的数据目录。', { tone: 'error' });
      return;
    }
    const ok = await copyText(path);
    notify(ok ? '数据目录路径已复制到剪贴板。' : '复制失败，请手动选择路径。', {
      tone: ok ? 'info' : 'error',
    });
  };

  const fallbackNodes = overview
    ? Object.values(overview.counts ?? {}).reduce((sum, value) => sum + (value ?? 0), 0)
    : null;
  const nodes = countValue(health?.nodes) ?? fallbackNodes;
  const edges = countValue(health?.edges);
  const changes = countValue(health?.changes);
  const rollback = countValue(health?.rollbackItems);
  const outbox = countValue(health?.outbox);
  const foreign = countValue(health?.foreignKeyErrors ?? health?.foreignKeys);
  const integrity = health?.integrity ?? '';
  const integrityOk = integrity.toLowerCase() === 'ok';
  const rootPath = health?.dataRoot || overview?.dataRoot || root;

  const stat = (label: string, value: number | null | string, bad = false) => (
    <div className={cx('pa-health-stat', bad && 'pa-health-bad')}>
      <span>{label}</span>
      <strong>{value === null || value === undefined || value === '' ? '—' : value}</strong>
    </div>
  );

  return (
    <section className="pa-settings-card">
      <header>
        <h3>数据健康</h3>
        <button type="button" onClick={() => void load()} disabled={loading}>
          {loading ? '读取中…' : '刷新'}
        </button>
      </header>
      {error ? (
        <p className="pa-error-inline">{error}</p>
      ) : (
        <>
          <div className="pa-health-grid">
            {stat('完整性', integrity ? (integrityOk ? '正常' : integrity) : '—', Boolean(integrity) && !integrityOk)}
            {stat('外键错误', foreign, (foreign ?? 0) > 0)}
            {stat('节点', nodes)}
            {stat('边', edges)}
            {stat('整理记录', changes)}
            {stat('恢复点', rollback)}
            {stat('待发通知', outbox)}
            <div className="pa-health-stat pa-health-path">
              <span>数据目录</span>
              <strong>{rootPath || '—'}</strong>
            </div>
          </div>
          <p className="pa-export-note">
            {lastExport
              ? `最近导出：${lastExport.name} · ${formatDate(lastExport.at)}`
              : '暂无导出记录'}
          </p>
          <div className="pa-settings-footer">
            <button type="button" onClick={() => void openDirectory()}>
              复制目录路径
            </button>
            <button type="button" disabled={busy === 'maintain'} onClick={() => void maintain()}>
              {busy === 'maintain' ? '整理中…' : '立即整理'}
            </button>
            <button
              type="button"
              className="pa-primary"
              disabled={busy === 'export'}
              onClick={() => void exportData()}
            >
              {busy === 'export' ? '导出中…' : '导出数据'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Records (memory / project / task / tool)                            */
/* ------------------------------------------------------------------ */

interface RecordsProps {
  api: Api;
  kind: Kind;
  timezone: string;
  onChange: () => void;
  createSignal: number;
  wide?: boolean;
  openRequest?: { kind: Kind; id: string; mode: 'read' | 'edit'; nonce: number } | null;
  onOpenConsumed?: () => void;
  createRequest?: { kind: Kind; nonce: number } | null;
  onCreateConsumed?: () => void;
}

type TaskSegment = 'all' | 'today' | 'week' | 'overdue' | 'nodue' | 'done';

function Records({
  api,
  kind,
  timezone,
  onChange,
  createSignal,
  wide = false,
  openRequest = null,
  onOpenConsumed,
  createRequest = null,
  onCreateConsumed,
}: RecordsProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 300);
  const [sort, setSort] = useState<'updated' | 'created' | 'title'>('updated');
  const [project, setProject] = useState('');
  const [projects, setProjects] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<{ row: Row; mode: 'read' | 'edit' } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createSeed, setCreateSeed] = useState<Row | undefined>(undefined);
  const [busyKey, setBusyKey] = useState('');
  const [history, setHistory] = useState(false);
  const [view, setView] = useState<'cards' | 'timeline'>('cards');
  const [segment, setSegment] = useState<TaskSegment>('all');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleValue, setRescheduleValue] = useState('');
  const [extraDeps, setExtraDeps] = useState<Record<string, Row>>({});
  const notify = useToast();
  const confirm = useConfirm();
  const sequence = useRef(0);
  const label = kindLabel(kind);
  const filterable = kind !== 'project' && kind !== 'tool';
  const projectTitle = projects.find((item) => item.id === project)?.data.title;
  const isTask = kind === 'task';

  const pageSize = isTask ? 100 : 30;

  const refresh = useCallback(async () => {
    const current = sequence.current + 1;
    sequence.current = current;
    try {
      const data = await command<ListResult>(api, 'list', {
        kind,
        query: debouncedQuery,
        projectId: project || undefined,
        offset: isTask ? 0 : offset,
        limit: pageSize,
        sort,
      });
      if (current !== sequence.current) return;
      setRows(data.items);
      setTotal(data.total);
      setError('');
    } catch (errorValue) {
      if (current === sequence.current) setError(message(errorValue));
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, [api, debouncedQuery, kind, offset, project, sort, isTask, pageSize]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void command<ListResult>(api, 'projectTree', {})
      .then((data) => setProjects(data.items))
      .catch((errorValue) => setError(message(errorValue)));
  }, [api]);

  useEffect(() => {
    setOffset(0);
  }, [debouncedQuery, project, sort]);

  useEffect(() => {
    setChecked(new Set());
  }, [debouncedQuery, project, sort, segment, view]);

  usePolling(refresh, 4000, kind === 'task' || kind === 'tool');

  const initialSignal = useRef(createSignal);
  useEffect(() => {
    if (createSignal !== initialSignal.current) {
      initialSignal.current = createSignal;
      setCreateSeed(undefined);
      setCreateOpen(true);
    }
  }, [createSignal]);

  const open = (row: Row, mode: 'read' | 'edit') => setSelected({ row, mode });

  useEffect(() => {
    if (!openRequest || openRequest.kind !== kind) return;
    setSelected({
      row: { id: openRequest.id, revision: 0, data: {} },
      mode: openRequest.mode,
    });
    onOpenConsumed?.();
  }, [kind, openRequest, onOpenConsumed]);

  useEffect(() => {
    if (!createRequest || createRequest.kind !== kind) return;
    setCreateSeed(undefined);
    setCreateOpen(true);
    onCreateConsumed?.();
  }, [createRequest, kind, onCreateConsumed]);

  useEffect(() => {
    if (!isTask) return;
    const known = new Set(rows.map((row) => row.id));
    const missing = Array.from(
      new Set(rows.flatMap((row) => row.data.dependsOn ?? [])),
    ).filter((id) => !known.has(id) && !extraDeps[id]);
    if (missing.length === 0) return;
    let live = true;
    void Promise.all(
      missing.slice(0, 20).map((id) =>
        command<Row>(api, 'get', { id }).catch(() => null),
      ),
    ).then((values) => {
      if (!live) return;
      const found: Record<string, Row> = {};
      for (const value of values) if (value) found[value.id] = value;
      if (Object.keys(found).length > 0) {
        setExtraDeps((current) => ({ ...current, ...found }));
      }
    });
    return () => {
      live = false;
    };
  }, [api, rows, isTask, extraDeps]);

  const run = async (row: Row) => {
    setBusyKey(`run:${row.id}`);
    try {
      await api('task.run', {
        ...(kind === 'task' ? { taskId: row.id } : { toolId: row.id }),
        requestId: crypto.randomUUID(),
      });
      notify('已提交执行');
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setBusyKey('');
    }
  };

  const activate = async (row: Row) => {
    if (!row.data.pendingVersion) return;
    const version = row.data.pendingVersion;
    const ok = await confirm({
      title: '启用此版本？',
      body: `将把「${row.data.title ?? '未命名工具'}」切换到版本 ${version.slice(0, 8)}，当前启用的内容会被替换。`,
      confirmLabel: '启用',
    });
    if (!ok) return;
    setBusyKey(`activate:${row.id}`);
    try {
      await command(api, 'toolActivate', {
        id: row.id,
        revision: row.revision,
        version,
      });
      notify('已启用该版本');
      await refresh();
      onChange();
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setBusyKey('');
    }
  };

  const todayStart = Date.parse(dayBounds(timezone, 0).start);
  const todayEnd = Date.parse(dayBounds(timezone, 0).end);
  const tomorrowStart = Date.parse(dayBounds(timezone, 1).start);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || undefined,
    weekday: 'short',
  }).format(new Date());
  const weekdayNumber =
    { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday] ?? 1;
  const daysToNextMonday = (8 - (weekdayNumber === 0 ? 7 : weekdayNumber)) % 7 || 7;
  const weekEnd = Date.parse(dayBounds(timezone, daysToNextMonday).start);

  const isDone = (row: Row) => row.data.status === 'completed';
  const isInactive = (row: Row) =>
    ['completed', 'cancelled', 'failed'].includes(row.data.status ?? '');

  const inSegment = (row: Row, value: TaskSegment) => {
    if (value === 'all') return true;
    if (value === 'done') return isDone(row);
    if (isInactive(row)) return false;
    const due = row.data.dueAt ? Date.parse(row.data.dueAt) : NaN;
    if (value === 'nodue') return !Number.isFinite(due);
    if (!Number.isFinite(due)) return false;
    if (value === 'today') return due >= todayStart && due < todayEnd;
    if (value === 'week') return due >= tomorrowStart && due < weekEnd;
    return due < todayStart;
  };

  const visibleRows = isTask ? rows.filter((row) => inSegment(row, segment)) : rows;
  const segmentItems: Array<{ id: TaskSegment; label: string; count: number }> = [
    { id: 'all', label: '全部', count: rows.length },
    { id: 'today', label: '今天', count: rows.filter((row) => inSegment(row, 'today')).length },
    { id: 'week', label: '本周', count: rows.filter((row) => inSegment(row, 'week')).length },
    { id: 'overdue', label: '逾期', count: rows.filter((row) => inSegment(row, 'overdue')).length },
    { id: 'nodue', label: '无期限', count: rows.filter((row) => inSegment(row, 'nodue')).length },
    { id: 'done', label: '已完成', count: rows.filter((row) => inSegment(row, 'done')).length },
  ];
  const allChecked =
    visibleRows.length > 0 && visibleRows.every((row) => checked.has(row.id));

  const toggleChecked = (id: string) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setChecked((current) => {
      const next = new Set(current);
      if (allChecked) visibleRows.forEach((row) => next.delete(row.id));
      else visibleRows.forEach((row) => next.add(row.id));
      return next;
    });
  };

  const selectedRows = rows.filter((row) => checked.has(row.id));

  const bulkComplete = async () => {
    if (selectedRows.length === 0) return;
    setBusyKey('bulk');
    try {
      await Promise.all(
        selectedRows.map((row) =>
          command(api, 'taskEdit', {
            id: row.id,
            revision: row.revision,
            patch: { status: 'completed' },
          }),
        ),
      );
      notify(`已完成 ${selectedRows.length} 个任务`);
      setChecked(new Set());
      await refresh();
      onChange();
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setBusyKey('');
    }
  };

  const bulkReschedule = async () => {
    if (selectedRows.length === 0) return;
    setBusyKey('bulk');
    try {
      const dueAt = rescheduleValue ? fromLocal(rescheduleValue, timezone) : null;
      await Promise.all(
        selectedRows.map((row) =>
          command(api, 'taskEdit', {
            id: row.id,
            revision: row.revision,
            patch: { dueAt },
          }),
        ),
      );
      notify(dueAt ? `已改期 ${selectedRows.length} 个任务` : '已清除截止时间');
      setRescheduleOpen(false);
      setChecked(new Set());
      await refresh();
      onChange();
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setBusyKey('');
    }
  };

  const bulkDelete = async () => {
    if (selectedRows.length === 0) return;
    const ok = await confirm({
      title: `删除 ${selectedRows.length} 个任务？`,
      body: '删除后无法恢复，相关的前置依赖与关联也会被移除。',
      confirmLabel: '删除',
    });
    if (!ok) return;
    setBusyKey('bulk');
    try {
      await Promise.all(
        selectedRows.map((row) =>
          command(api, 'remove', { id: row.id, revision: row.revision }),
        ),
      );
      notify(`已删除 ${selectedRows.length} 个任务`);
      setChecked(new Set());
      await refresh();
      onChange();
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setBusyKey('');
    }
  };

  const dependency = (id: string) => rows.find((row) => row.id === id) ?? extraDeps[id];
  const quickCreate = (taskKind: 'task', projectId: string) => {
    setSelected(null);
    setCreateSeed({ id: '', revision: 0, projectId, data: {} });
    setCreateOpen(true);
  };

  if (history) {
    return (
      <>
        <div className="pa-page-heading">
          <div>
            <button type="button" className="pa-back" onClick={() => setHistory(false)}>
              ‹ 返回{kind === 'task' ? '任务' : '工具'}
            </button>
            <h2>执行记录</h2>
          </div>
        </div>
        <RunHistory api={api} kind={kind} timezone={timezone} />
      </>
    );
  }

  const list = (
    <>
      {error && <div role="alert" className="pa-error">{error}</div>}
      {loading ? (
        <SkeletonCards />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          text={
            debouncedQuery || project
              ? `没有找到匹配的${label}`
              : isTask && segment !== 'all'
                ? `没有「${segmentItems.find((item) => item.id === segment)?.label}」的任务`
                : `还没有${label}`
          }
          actionLabel={debouncedQuery || project ? '清除筛选' : `新建${label}`}
          onAction={() => {
            if (debouncedQuery || project) {
              setQuery('');
              setProject('');
              setOffset(0);
            } else {
              setCreateSeed(undefined);
              setCreateOpen(true);
            }
          }}
        />
      ) : view === 'timeline' && kind === 'memory' ? (
        <MemoryTimeline
          rows={visibleRows}
          projects={projects}
          timezone={timezone}
          onOpen={(row) => open(row, 'read')}
        />
      ) : (
        <div className={cx('pa-records', `pa-records-${kind}`)}>
          {visibleRows.map((row) => {
            const dependencies = row.data.dependsOn ?? [];
            return (
              <article
                className={cx('pa-card', isTask && checked.has(row.id) && 'pa-card-checked')}
                key={row.id}
              >
                <div className="pa-card-main">
                  {isTask && (
                    <label className="pa-check" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`选择 ${row.data.title ?? '任务'}`}
                        checked={checked.has(row.id)}
                        onChange={() => toggleChecked(row.id)}
                      />
                    </label>
                  )}
                  <div className="pa-card-head">
                    <button
                      type="button"
                      className="pa-title"
                      onClick={() => open(row, 'read')}
                    >
                      {row.data.title}
                    </button>
                    <span className="pa-tag">{statusText(kind, row.data)}</span>
                  </div>
                </div>
                {kind === 'memory' && (row.data.observations ?? []).length > 0 && (
                  <div className="pa-meta">
                    {formatDate(row.data.observations?.at(-1)?.at, timezone)}
                  </div>
                )}
                {bodyTextOf(kind, row.data) && (
                  <p className="pa-clamp">{bodyTextOf(kind, row.data)}</p>
                )}
                <div className="pa-tags">
                  {(row.data.domains ?? []).map((value) => (
                    <span className="pa-tag" key={value}>{value}</span>
                  ))}
                  {row.data.pinned && <span className="pa-tag">固定</span>}
                  {row.data.important && <span className="pa-tag">重要</span>}
                  {row.data.urgent && <span className="pa-tag pa-warm">紧急</span>}
                  {row.data.derivedDirty && <span className="pa-tag">待整理</span>}
                  {row.projectId && (
                    <span className="pa-tag">
                      {projects.find((item) => item.id === row.projectId)?.data.title ??
                        '项目'}
                    </span>
                  )}
                </div>
                {dependencies.length > 0 && (
                  <div className="pa-dep-row">
                    <span>前置：</span>
                    {dependencies.map((id) => {
                      const dep = dependency(id);
                      const done = dep?.data.status === 'completed';
                      return (
                        <span
                          key={id}
                          className={cx('pa-dep', done && 'pa-dep-done')}
                          title={dep?.data.title ?? id}
                        >
                          {dep?.data.title ?? id.slice(0, 8)}
                        </span>
                      );
                    })}
                  </div>
                )}
                {row.data.dueAt && (
                  <div className="pa-meta">{formatDate(row.data.dueAt, timezone)}</div>
                )}
                <footer>
                  <button type="button" onClick={() => open(row, 'read')}>查看</button>
                  {(kind === 'task' || kind === 'tool') && (
                    <button
                      type="button"
                      disabled={busyKey !== '' || (kind === 'tool' && !row.data.activeVersion)}
                      onClick={() => void run(row)}
                    >
                      {busyKey === `run:${row.id}` ? '处理中…' : '执行'}
                    </button>
                  )}
                  {kind === 'tool' && row.data.pendingVersion && (
                    <button
                      type="button"
                      disabled={busyKey !== ''}
                      onClick={() => void activate(row)}
                    >
                      {busyKey === `activate:${row.id}` ? '处理中…' : '启用版本'}
                    </button>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}
      {!loading && !isTask && rows.length > 0 && (
        <Pager offset={offset} total={total} onPage={setOffset} />
      )}
      {!loading && isTask && total > rows.length && (
        <p className="pa-meta">当前显示最近 {rows.length} 条，共 {total} 条。</p>
      )}
    </>
  );

  return (
    <>
      <div className="pa-page-heading">
        <div>
          <h2>
            {label}
            <span className="pa-count">{total}</span>
          </h2>
          {filterable && projectTitle && (
            <div className="pa-chip-row">
              <span className="pa-chip">
                项目：{projectTitle}
                <button
                  type="button"
                  aria-label="清除项目筛选"
                  onClick={() => setProject('')}
                >
                  ×
                </button>
              </span>
            </div>
          )}
        </div>
        <div className="pa-actions">
          {['task', 'tool'].includes(kind) && (
            <button type="button" onClick={() => setHistory(true)}>执行记录</button>
          )}
          <button
            type="button"
            className="pa-primary"
            onClick={() => {
              setCreateSeed(undefined);
              setCreateOpen(true);
            }}
          >
            新建{label}
          </button>
        </div>
      </div>
      {isTask && (
        <div className="pa-segments" role="group" aria-label="任务分组">
          {segmentItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cx(segment === item.id && 'pa-selected')}
              aria-pressed={segment === item.id}
              onClick={() => setSegment(item.id)}
            >
              {item.label}
              <span className="pa-segment-count">{item.count}</span>
            </button>
          ))}
        </div>
      )}
      <div className="pa-toolbar pa-filters">
        <div className="pa-search">
          <input
            data-pa-search
            aria-label="搜索"
            value={query}
            placeholder={`搜索${label}`}
            onChange={(event) => {
              setQuery(event.target.value);
              setOffset(0);
            }}
          />
          {query !== debouncedQuery && (
            <span className="pa-search-state">搜索中…</span>
          )}
        </div>
        {kind === 'memory' && (
          <div className="pa-segments" role="group" aria-label="记忆视图">
            <button
              type="button"
              className={cx(view === 'cards' && 'pa-selected')}
              aria-pressed={view === 'cards'}
              onClick={() => setView('cards')}
            >
              卡片
            </button>
            <button
              type="button"
              className={cx(view === 'timeline' && 'pa-selected')}
              aria-pressed={view === 'timeline'}
              onClick={() => setView('timeline')}
            >
              时间线
            </button>
          </div>
        )}
        <select
          aria-label="排序"
          value={sort}
          onChange={(event) => setSort(event.target.value as 'updated' | 'created' | 'title')}
        >
          <option value="updated">最近更新</option>
          <option value="created">最早创建</option>
          <option value="title">标题</option>
        </select>
        {filterable && (
          <select
            aria-label="项目筛选"
            value={project}
            onChange={(event) => {
              setProject(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">全部项目</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>{item.data.title}</option>
            ))}
          </select>
        )}
      </div>
      {isTask && (
        <div className="pa-bulkbar">
          <label className="pa-check">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={toggleAll}
              aria-label="全选当前任务"
            />
            全选
          </label>
          <strong>已选 {checked.size} 项</strong>
          <button
            type="button"
            disabled={checked.size === 0 || busyKey !== ''}
            onClick={() => void bulkComplete()}
          >
            批量完成
          </button>
          <button
            type="button"
            disabled={checked.size === 0 || busyKey !== ''}
            onClick={() => {
              setRescheduleValue(localInput(Date.now() + 86400000, timezone));
              setRescheduleOpen(true);
            }}
          >
            批量改期
          </button>
          <button
            type="button"
            className="pa-danger"
            disabled={checked.size === 0 || busyKey !== ''}
            onClick={() => void bulkDelete()}
          >
            批量删除
          </button>
          <button
            type="button"
            disabled={checked.size === 0}
            onClick={() => setChecked(new Set())}
          >
            清除
          </button>
        </div>
      )}
      {wide ? (
        <div className="pa-split">
          <div className="pa-split-list">{list}</div>
          {selected ? (
            <RecordDialog
              key={`${selected.row.id}:${selected.mode}`}
              inline
              api={api}
              kind={kind}
              seed={selected.row}
              initialMode={selected.mode}
              projects={projects}
              timezone={timezone}
              onClose={() => setSelected(null)}
              onChanged={() => {
                void refresh();
                onChange();
              }}
              onQuickCreate={quickCreate}
            />
          ) : (
            <div className="pa-split-empty">从左侧选择一条记录，在这里查看详情。</div>
          )}
        </div>
      ) : (
        list
      )}
      {!wide && selected && (
        <RecordDialog
          key={`${selected.row.id}:${selected.mode}`}
          api={api}
          kind={kind}
          seed={selected.row}
          initialMode={selected.mode}
          projects={projects}
          timezone={timezone}
          onClose={() => setSelected(null)}
          onChanged={() => {
            void refresh();
            onChange();
          }}
          onQuickCreate={quickCreate}
        />
      )}
      {createOpen && (
        <RecordDialog
          key={`create:${createSeed?.projectId ?? ''}`}
          api={api}
          kind={kind}
          create
          seed={createSeed}
          projects={projects}
          timezone={timezone}
          onClose={() => setCreateOpen(false)}
          onChanged={() => {
            void refresh();
            onChange();
          }}
          onQuickCreate={quickCreate}
        />
      )}
      {rescheduleOpen && (
        <Modal title="批量改期" onClose={() => setRescheduleOpen(false)}>
          <div className="pa-dialog-body">
            <Field label="新的截止时间">
              <input
                type="datetime-local"
                value={rescheduleValue}
                onChange={(event) => setRescheduleValue(event.target.value)}
              />
            </Field>
            <p className="pa-hint">
              将修改选中的 {checked.size} 个任务；留空并确认可清除截止时间。
            </p>
          </div>
          <footer className="pa-dialog-footer">
            <button type="button" onClick={() => setRescheduleOpen(false)}>取消</button>
            <button
              type="button"
              className="pa-primary"
              disabled={busyKey === 'bulk'}
              onClick={() => void bulkReschedule()}
            >
              {busyKey === 'bulk' ? '处理中…' : '确认改期'}
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}

function RunHistory({
  api,
  kind,
  timezone,
}: {
  api: Api;
  kind: Kind;
  timezone: string;
}) {
  const [rows, setRows] = useState<RunRow[]>([]);
  const [selected, setSelected] = useState<RunRow | null>(null);
  const refresh = useCallback(async () => {
    try {
      setRows(await api<RunRow[]>('runs'));
    } catch {
      // A transient polling failure leaves the previous list in place.
    }
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  usePolling(refresh, 4000);
  const visible = rows.filter((row) =>
    kind === 'task' ? Boolean(row.task_id) : !row.task_id,
  );
  return (
    <section className="pa-run-history">
      {visible.length === 0 && <EmptyState text="暂无执行记录" compact />}
      {visible.map((row) => (
        <div className="pa-toolbar" key={row.id}>
          <strong className="pa-run-title">
            {row.title ?? (kind === 'task' ? '任务执行' : '工具执行')}
          </strong>
          <span className="pa-meta">{formatDate(row.created_at, timezone)}</span>
          <span className="pa-tag">
            {{
              succeeded: '执行结束',
              unknown: '待核对',
              queued: '排队中',
              ...LABELS,
            }[row.status] ?? row.status}
          </span>
          <button type="button" onClick={() => setSelected(row)}>结果</button>
          {row.session_id && (
            <button
              type="button"
              onClick={() => api('native.open', { sessionId: row.session_id })}
            >
              在 DSH 中打开
            </button>
          )}
        </div>
      ))}
      {selected && (
        <Modal title="执行结果" onClose={() => setSelected(null)}>
          <pre className="pa-detail">{selected.result ?? '处理中'}</pre>
        </Modal>
      )}
    </section>
  );
}

function ToolVersions({
  api,
  tool,
  timezone,
  onChange,
}: {
  api: Api;
  tool: Row;
  timezone: string;
  onChange: () => Promise<void>;
}) {
  const [rows, setRows] = useState<Array<{ id: string; created_at: number }>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const notify = useToast();
  const confirm = useConfirm();
  const load = useCallback(async () => {
    try {
      setRows(await command<Array<{ id: string; created_at: number }>>(
        api,
        'toolVersions',
        { id: tool.id },
      ));
    } catch (errorValue) {
      setError(message(errorValue));
    }
  }, [api, tool.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const activate = async (version: { id: string }) => {
    const ok = await confirm({
      title: '启用此版本？',
      body: `将把「${tool.data.title ?? '未命名工具'}」切换到版本 ${version.id.slice(0, 8)}，当前启用的内容会被替换。`,
      confirmLabel: '启用',
    });
    if (!ok) return;
    setBusy(version.id);
    try {
      const current = await command<Row>(api, 'get', { id: tool.id });
      await command(api, 'toolActivate', {
        id: tool.id,
        revision: current.revision,
        version: version.id,
      });
      notify('已启用该版本');
      await load();
      await onChange();
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="pa-detail-section">
      <h3>版本</h3>
      {rows.map((row) => (
        <div className="pa-toolbar" key={row.id}>
          <span>{formatDate(row.created_at, timezone)}</span>
          <code>{row.id.slice(0, 8)}</code>
          <button
            type="button"
            disabled={busy !== '' || row.id === tool.data.activeVersion}
            onClick={() => void activate(row)}
          >
            {busy === row.id
              ? '处理中…'
              : row.id === tool.data.activeVersion
                ? '当前'
                : '启用'}
          </button>
        </div>
      ))}
      {error && <div role="alert" className="pa-error">{error}</div>}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Calendar                                                            */
/* ------------------------------------------------------------------ */

interface CalendarProps {
  api: Api;
  timezone: string;
  onChange: () => void;
  createSignal: number;
  openRequest?: { id: string; nonce: number } | null;
  onOpenConsumed?: () => void;
}

function Calendar({
  api,
  timezone,
  onChange,
  createSignal,
  openRequest = null,
  onOpenConsumed,
}: CalendarProps) {
  const [cursor, setCursor] = useState(() => new Date());
  const [rows, setRows] = useState<Row[]>([]);
  const [view, setView] = useState<'month' | 'week' | 'agenda'>('month');
  const [error, setError] = useState('');
  const [projects, setProjects] = useState<Row[]>([]);
  const [project, setProject] = useState('');
  const [domain, setDomain] = useState('');
  const [editor, setEditor] = useState<{ form: FormState; initial: FormState } | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const notify = useToast();
  const confirm = useConfirm();
  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  const refresh = useCallback(async () => {
    const from = new Date(year, month, 1);
    from.setDate(from.getDate() - 7);
    const to = new Date(year, month + 1, 8);
    try {
      setRows(await command<Row[]>(api, 'calendar', {
        from: from.toISOString(),
        to: to.toISOString(),
      }));
      setError('');
    } catch (errorValue) {
      setError(message(errorValue));
    }
  }, [api, year, month]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void command<ListResult>(api, 'projectTree', {})
      .then((data) => setProjects(data.items))
      .catch((errorValue) => setError(message(errorValue)));
  }, [api]);

  const open = (row?: Row, day?: string) => {
    const form = makeEventForm(row, day, timezone);
    setEditor({ form, initial: form });
  };

  useEffect(() => {
    if (!openRequest) return;
    let live = true;
    command<Row>(api, 'get', { id: openRequest.id })
      .then((row) => {
        if (!live) return;
        open(row);
        onOpenConsumed?.();
      })
      .catch((errorValue) => {
        if (live) setError(message(errorValue));
      });
    return () => {
      live = false;
    };
  }, [api, openRequest, onOpenConsumed]);

  const initialSignal = useRef(createSignal);
  useEffect(() => {
    if (createSignal !== initialSignal.current) {
      initialSignal.current = createSignal;
      open();
    }
  }, [createSignal]);

  const filtered = rows.filter(
    (row) =>
      (!project || row.projectId === project) &&
      (!domain || (row.data.domains ?? []).includes(domain)),
  );
  const domains = [...new Set(rows.flatMap((row) => row.data.domains ?? []))];
  const first = view === 'week'
    ? new Date(cursor)
    : new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const key = (value: Date) =>
    [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0'),
    ].join('-');
  const matches = (row: Row, day: string) => {
    const rowStart = row.occurrenceStart ?? row.data.start ?? '';
    const rowEnd = row.occurrenceEnd ?? row.data.end ?? '';
    if (!rowStart) return false;
    const from = row.data.allDay
      ? rowStart.slice(0, 10)
      : localInput(rowStart, timezone).slice(0, 10);
    const to = row.data.allDay
      ? rowEnd.slice(0, 10)
      : localInput(rowEnd, timezone).slice(0, 10);
    return from <= day && (row.data.allDay ? to > day : to >= day);
  };

  const update = (patch: Partial<FormState>) =>
    setEditor((current) =>
      current ? { ...current, form: { ...current.form, ...patch } } : current,
    );

  const saveEvent = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    const form = editor.form;
    setSaving(true);
    setError('');
    try {
      const allDayStart = form.startLocal.slice(0, 10);
      const allDayEnd = form.endLocal.slice(0, 10);
      const data = {
        title: form.title,
        projectId: form.projectId || null,
        start: form.allDay
          ? allDayStart
          : fromLocal(form.startLocal, form.timezone),
        end: form.allDay
          ? allDayEnd
          : fromLocal(form.endLocal, form.timezone),
        timezone: form.timezone,
        allDay: form.allDay,
        recurrence:
          form.repeat === 'none'
            ? ''
            : form.repeat === 'custom'
              ? form.recurrence
              : `FREQ=${form.repeat.toUpperCase()}`,
        location: form.location,
        description: form.description,
        domains: splitList(form.domainsText),
        importance: form.importance,
      };
      if (form.scope === 'occurrence' && form.occurrenceKey && form.id) {
        await command(api, 'eventOverride', {
          id: form.id,
          revision: form.revision,
          occurrence: form.occurrenceKey,
          patch: { ...data, recurrence: '' },
        });
      } else if (form.id) {
        await command(api, 'eventEdit', {
          id: form.id,
          revision: form.revision,
          patch: data,
        });
      } else {
        await command(api, 'eventCreate', data);
      }
      await refresh();
      onChange();
      notify(form.id ? '日程已更新' : '日程已创建');
      setEditor(null);
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const removeEvent = async () => {
    if (!editor?.form.id) return;
    const form = editor.form;
    const ok = await confirm({
      title: '删除日程？',
      body: `将删除「${form.title}」${form.scope === 'occurrence' ? '的本次安排' : '及其整个系列'}，此操作不可撤销。`,
      confirmLabel: '删除',
    });
    if (!ok) return;
    setSaving(true);
    setError('');
    try {
      if (form.scope === 'occurrence' && form.occurrenceKey) {
        await command(api, 'eventOverride', {
          id: form.id,
          revision: form.revision,
          occurrence: form.occurrenceKey,
          cancelled: true,
        });
      } else {
        await command(api, 'remove', {
          id: form.id,
          revision: form.revision,
        });
      }
      await refresh();
      onChange();
      notify('日程已删除');
      setEditor(null);
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const importFile = async (file: File) => {
    const ok = await confirm({
      title: '导入 ICS？',
      body: `将把「${file.name}」中的日程导入当前日历，重复日程会新增实例。`,
      confirmLabel: '导入',
    });
    if (!ok) return;
    setImporting(true);
    try {
      await command(api, 'icsImport', {
        content: await file.text(),
        timezone,
      });
      await refresh();
      onChange();
      notify('ICS 已导入');
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <>
      <div className="pa-toolbar">
        <button
          type="button"
          aria-label="上一期"
          onClick={() =>
            setCursor(
              view === 'week'
                ? new Date(year, month, cursor.getDate() - 7)
                : new Date(year, month - 1, 1),
            )
          }
        >
          ‹
        </button>
        <h2>{year} 年 {month + 1} 月</h2>
        <button
          type="button"
          aria-label="下一期"
          onClick={() =>
            setCursor(
              view === 'week'
                ? new Date(year, month, cursor.getDate() + 7)
                : new Date(year, month + 1, 1),
            )
          }
        >
          ›
        </button>
        <button type="button" onClick={() => setCursor(new Date())}>今天</button>
        <select
          aria-label="日历视图"
          value={view}
          onChange={(event) => setView(event.target.value as 'month' | 'week' | 'agenda')}
        >
          <option value="month">月</option>
          <option value="week">周</option>
          <option value="agenda">日程列表</option>
        </select>
        <button type="button" className="pa-primary" onClick={() => open()}>
          新建日程
        </button>
        <button type="button" disabled={importing} onClick={() => fileInput.current?.click()}>
          {importing ? '导入中…' : '导入 ICS'}
        </button>
        <Download
          name="assistant.ics"
          label="导出 ICS"
          content={async () =>
            (await command<{ content: string }>(api, 'icsExport')).content
          }
        />
        <input
          ref={fileInput}
          type="file"
          accept=".ics,text/calendar"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
          }}
        />
      </div>
      <div className="pa-calendar-filters">
        <select
          aria-label="日历项目"
          value={project}
          onChange={(event) => setProject(event.target.value)}
        >
          <option value="">全部项目</option>
          {projects.map((item) => (
            <option key={item.id} value={item.id}>{item.data.title}</option>
          ))}
        </select>
        <select
          aria-label="日历领域"
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
        >
          <option value="">全部领域</option>
          {domains.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
      </div>
      {error && <div role="alert" className="pa-error">{error}</div>}
      {view !== 'agenda' ? (
        <div className="pa-calendar">
          {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
            <div className="pa-weekday" key={day}>{day}</div>
          ))}
          {Array.from({ length: view === 'week' ? 7 : 42 }, (_, index) => {
            const day = new Date(start);
            day.setDate(start.getDate() + index);
            const value = key(day);
            const dayRows = filtered.filter((row) => matches(row, value));
            return (
              <section
                key={value}
                className={cx(
                  'pa-day',
                  day.getMonth() !== month && 'pa-muted',
                  value === key(new Date()) && 'pa-day-today',
                )}
              >
                <button
                  type="button"
                  className="pa-day-number"
                  aria-label={`新建 ${value} 日程`}
                  onClick={() => open(undefined, value)}
                >
                  {day.getDate()}
                </button>
                {dayRows.slice(0, 2).map((row) => (
                  <button
                    type="button"
                    className="pa-event"
                    style={{ borderLeftColor: projectColor(row.projectId) }}
                    key={`${row.id}:${row.occurrenceStart ?? ''}`}
                    onClick={() => open(row)}
                  >
                    {row.data.allDay
                      ? ''
                      : `${formatTime(row.occurrenceStart ?? row.data.start, timezone)} `}
                    {row.data.title}
                  </button>
                ))}
                {dayRows.length > 2 && (
                  <span className="pa-event-more">+{dayRows.length - 2}</span>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="pa-records">
          {filtered.length === 0 && <EmptyState text="暂无日程" />}
          {filtered.map((row) => (
            <article
              className="pa-card"
              key={`${row.id}:${row.occurrenceStart ?? ''}`}
              style={{ borderLeftColor: projectColor(row.projectId) }}
            >
              <button type="button" className="pa-title" onClick={() => open(row)}>
                {row.data.title}
              </button>
              <div>
                {row.data.allDay
                  ? row.occurrenceStart
                  : formatDate(row.occurrenceStart ?? row.data.start, timezone)}
              </div>
              <div className="pa-meta">{row.data.location}</div>
            </article>
          ))}
        </div>
      )}
      {editor && (
        <Modal
          title={editor.form.id ? '编辑日程' : '新建日程'}
          onClose={() => setEditor(null)}
          dirty={JSON.stringify(editor.form) !== JSON.stringify(editor.initial)}
          wide
        >
          <form onSubmit={(event) => void saveEvent(event)}>
            <div className="pa-dialog-body">
              <EditorFields
                kind="event"
                form={editor.form}
                update={update}
                projects={projects}
                timezone={timezone}
              />
              {error && <div role="alert" className="pa-error">{error}</div>}
            </div>
            <footer className="pa-dialog-footer">
              {editor.form.id && (
                <button
                  type="button"
                  className="pa-danger"
                  disabled={saving}
                  onClick={() => void removeEvent()}
                >
                  删除日程
                </button>
              )}
              <button type="button" disabled={saving} onClick={() => setEditor(null)}>
                取消
              </button>
              <button className="pa-primary" type="submit" disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 日报                                                                */
/* ------------------------------------------------------------------ */

const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  draft: '未读',
  confirmed: '已读',
  'auto-confirmed': '已读',
  superseded: '已归档',
};

const REPORT_KIND_LABEL: Record<string, string> = {
  memory: '记忆',
  project: '项目',
  task: '任务',
  event: '日程',
  calendar: '日程',
  tool: '工具',
  entity: '实体',
  notification: '通知',
  relation: '关联',
  capability: '能力缺口',
  maintenance: '整理',
  run: '执行',
  wechat: '微信',
};

function reportKindLabel(kind: string): string {
  return REPORT_KIND_LABEL[kind] ?? (kind || '其他');
}

function reportDay(value: number, timezone: string): string {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(ms));
}

function reportBreakdown(row: ReportRow): {
  memory: number;
  project: number;
  task: number;
  event: number;
  other: number;
} {
  const summary = (row.summary ?? {}) as Record<string, unknown>;
  const nested = summary.byKind ?? summary.counts ?? summary.items;
  const source =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : summary;
  const read = (...keys: string[]): number => {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return 0;
  };
  const memory = read('memory', 'memories');
  const project = read('project', 'projects');
  const task = read('task', 'tasks');
  const event = read('event', 'events', 'calendar');
  const known = memory + project + task + event;
  const reported = Number.isFinite(row.counts) ? row.counts : 0;
  const total = reported > 0 ? reported : known;
  const explicitOther = read('other', 'others', 'remaining');
  const other = explicitOther || Math.max(0, total - known);
  return { memory, project, task, event, other };
}

function reportCountsText(row: ReportRow): string {
  const counts = reportBreakdown(row);
  const total = Number.isFinite(row.counts) ? row.counts : 0;
  if (total <= 0) return '暂无明细';
  const known = counts.memory + counts.project + counts.task + counts.event + counts.other;
  if (known <= 0) return `共 ${total} 项`;
  return `共 ${total} 项：记忆 ${counts.memory} · 项目 ${counts.project} · 任务 ${counts.task} · 日程 ${counts.event} · 其余 ${counts.other}`;
}

function ReportBody({ body }: { body: string }) {
  const lines = (body ?? '').split(/\r?\n/);
  return (
    <div className="pa-report-body">
      {lines.map((line, index) => {
        const text = line.trim();
        if (!text) return null;
        const heading = /^(#{1,4})\s+(.*)$/.exec(text);
        if (heading) {
          return heading[1].length <= 2 ? (
            <h3 key={index}>{heading[2]}</h3>
          ) : (
            <h4 key={index}>{heading[2]}</h4>
          );
        }
        if (text.startsWith('- ') || text.startsWith('• ')) {
          return (
            <div className="pa-report-li" key={index}>
              {text.slice(2)}
            </div>
          );
        }
        return <p key={index}>{text}</p>;
      })}
    </div>
  );
}

function ReportItemsTable({ items }: { items: ReportItem[] }) {
  return (
    <div className="pa-report-table-wrap">
      <table className="pa-report-table">
        <thead>
          <tr>
            <th scope="col">类型</th>
            <th scope="col">标题</th>
            <th scope="col">详情</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <span className="pa-tag">{reportKindLabel(item.kind)}</span>
              </td>
              <td>
                {item.title || '未命名'}
                {item.action && <span className="pa-meta"> · {changeActionLabel(item.action)}</span>}
              </td>
              <td className="pa-meta">{item.metadata?.treeDiff ? <TreeDiffView changes={[item.metadata.treeDiff]} /> : <>
                {item.detail || '—'}
                {Array.isArray(item.metadata?.gap?.proposals) && (item.metadata.gap.proposals as Array<{id:string;title:string;plan:string}>).map(proposal=><details key={proposal.id}><summary>{proposal.title}</summary><p>{proposal.plan}</p></details>)}
              </>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ReportPageProps {
  api: Api;
  timezone: string;
  wide: boolean;
}

function ReportPage({ api, timezone, wide }: ReportPageProps) {
  const notify = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [version, setVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [generating, setGenerating] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const fetchedRevision = useRef<number | null>(null);
  const requestedDetail = useRef<string | null>(null);

  const loadList = useCallback(
    async (nextOffset = offset) => {
      try {
        const result = await command<{ items: ReportRow[]; total: number }>(api, 'reportList', {
          offset: nextOffset,
          limit: 30,
        });
        setRows(result.items ?? []);
        setTotal(result.total ?? (result.items ?? []).length);
        setError('');
      } catch (err) {
        setError(message(err));
      } finally {
        setLoading(false);
      }
    },
    [api, offset],
  );

  const loadDetail = useCallback(
    async (id: string) => {
      requestedDetail.current = id;
      setDetailLoading(true);
      setDetailError('');
      try {
        const next = await command<ReportDetail>(api, 'reportGet', { id });
        if (requestedDetail.current !== id) return;
        setDetail(next);
        setVersion(next.revision);
      } catch (err) {
        if (requestedDetail.current !== id) return;
        setDetailError(message(err));
      } finally {
        if (requestedDetail.current === id) setDetailLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  usePolling(
    async () => {
      await loadList();
    },
    15000,
    !generating,
  );

  useEffect(() => {
    if (!generating) return;
    const started = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [generating]);

  useEffect(() => {
    if (!selectedId) {
      requestedDetail.current = null;
      setDetail(null);
      setVersion(null);
      return;
    }
    setDetail(null);
    setVersion(null);
    fetchedRevision.current = null;
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const selectedRow = rows.find((row) => row.id === selectedId) ?? null;
  const selectedRevision = selectedRow?.revision ?? null;
  useEffect(() => {
    if (!selectedId || !detail || detail.id !== selectedId) return;
    if (selectedRevision === null || selectedRevision <= detail.revision) return;
    if (fetchedRevision.current === selectedRevision) return;
    fetchedRevision.current = selectedRevision;
    void loadDetail(selectedId);
  }, [selectedId, selectedRevision, detail, loadDetail]);

  const openReport = (row: ReportRow) => {
    if (row.sessionId) {
      void api('native.open', { sessionId: row.sessionId });
      return;
    }
    notify('这份日报还没有关联会话。', { tone: 'error' });
  };

  const confirmReport = async (row: ReportRow) => {
    setBusy(`confirm:${row.id}`);
    try {
      const next = await command<ReportRow>(api, 'reportConfirm', { id: row.id });
      setRows((current) =>
        current.map((item) =>
          item.id === row.id
            ? { ...item, ...next, summary: next.summary ?? item.summary }
            : item,
        ),
      );
      notify('已标记已读');
      await loadList();
      if (selectedId === row.id) await loadDetail(row.id);
    } catch (err) {
      notify(message(err), { tone: 'error' });
    } finally {
      setBusy('');
    }
  };

  const generate = async () => {
    setGenerating(true);
    setError('');
    try {
      const created = await api<{ id?: string; revision?: number; error?: { message?: string } }>(
        'report.generate',
        { force: true },
      );
      if (!created?.id) {
        throw new Error(created?.error?.message ?? '生成失败，请稍后再试。');
      }
      setOffset(0);
      await loadList(0);
      setSelectedId(created.id);
      let next: ReportDetail | null = null;
      try {
        next = await command<ReportDetail>(api, 'reportGet', { id: created.id });
      } catch {
        // The detail effect retries; generation itself succeeded.
      }
      if (next) {
        setDetail(next);
        setVersion(next.revision);
      }
      if (next?.sessionId) {
        const sessionId = next.sessionId;
        void api('native.open', { sessionId });
        notify('已生成，正在打开', {
          action: { label: '打开会话', run: () => void api('native.open', { sessionId }) },
        });
      } else {
        notify('已生成');
      }
    } catch (err) {
      const mapped = message(err);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setGenerating(false);
    }
  };

  const renderDetail = (row: ReportRow) => {
    const active = detail && detail.id === row.id ? detail : null;
    const versions = active?.revisions ?? [];
    const currentVersion = versions.find((item) => item.revision === version);
    const body = currentVersion?.body ?? active?.body ?? row.body;
    const items = active?.items ?? [];
    const changes = items.filter(item => item.metadata?.treeDiff);
    const gaps = items.filter(item => item.kind === 'capability');
    const otherItems = items.filter(item => !item.metadata?.treeDiff && item.kind !== 'capability');
    return (
      <div className="pa-report-detail-content">
        <div className="pa-report-detail-meta">
          <span className={cx('pa-tag', `pa-report-tag-${row.status}`)}>
            {REPORT_STATUS_LABEL[row.status] ?? row.status}
          </span>
          <span className="pa-meta">修订 #{row.revision}</span>
          <span className="pa-meta">生成于 {formatDate(row.createdAt, timezone)}</span>
          {row.confirmedAt && (
            <span className="pa-meta">已读于 {formatDate(row.confirmedAt, timezone)}</span>
          )}
        </div>
        {versions.length > 1 && (
          <label className="pa-report-version">
            <span>版本</span>
            <select
              value={version ?? row.revision}
              onChange={(event) => setVersion(Number(event.target.value))}
            >
              {[...versions]
                .sort((a, b) => b.revision - a.revision)
                .map((item) => (
                  <option key={item.revision} value={item.revision}>
                    修订 #{item.revision} · {formatDate(item.createdAt, timezone)}
                  </option>
                ))}
            </select>
          </label>
        )}
        {detailLoading && !active && <p className="pa-meta">正在读取日报…</p>}
        {detailError && (
          <div role="alert" className="pa-error">
            {detailError}
          </div>
        )}
        {body ? <ReportBody body={body} /> : <p className="pa-detail-note">暂无正文</p>}
        {changes.length > 0 && <section className="pa-report-items"><h3>项目变化 <span className="pa-count">{changes.length}</span></h3><TreeDiffView changes={changes.map(item=>item.metadata!.treeDiff!)}/></section>}
        <section className="pa-report-items"><h3>能力缺口 <span className="pa-count">{gaps.length}</span></h3>{gaps.length ? <ReportItemsTable items={gaps}/> : <span className="pa-meta">无</span>}</section>
        {otherItems.length > 0 && <section className="pa-report-items"><h3>其他明细 <span className="pa-count">{otherItems.length}</span></h3><ReportItemsTable items={otherItems}/></section>}
        <div className="pa-report-detail-actions">
          <button type="button" className="pa-text-button" onClick={() => openReport(row)}>
            打开会话
          </button>
          {row.status === 'draft' && (
            <button
              type="button"
              className="pa-primary"
              disabled={busy !== ''}
              onClick={() => void confirmReport(row)}
            >
              {busy === `confirm:${row.id}` ? '处理中…' : '标记已读'}
            </button>
          )}
        </div>
      </div>
    );
  };

  const cards = rows.map((row) => (
    <article
      className={cx('pa-card pa-report-card', selectedId === row.id && 'pa-card-checked')}
      key={row.id}
    >
      <div className="pa-card-head">
        <h3 className="pa-title">
          {reportDay(row.windowFrom, timezone)} – {reportDay(row.windowTo, timezone)}
        </h3>
        <span className={cx('pa-tag', `pa-report-tag-${row.status}`)}>
          {REPORT_STATUS_LABEL[row.status] ?? row.status}
        </span>
      </div>
      <p className="pa-meta">修订 #{row.revision} · 生成于 {formatDate(row.createdAt, timezone)}</p>
      <p className="pa-report-counts">{reportCountsText(row)}</p>
      <footer>
        <button type="button" className="pa-text-button" onClick={() => setSelectedId(row.id)}>
          查看
        </button>
        <button type="button" className="pa-text-button" onClick={() => openReport(row)}>
          打开会话
        </button>
        {row.status === 'draft' && (
          <button
            type="button"
            className="pa-text-button"
            disabled={busy !== ''}
            onClick={() => void confirmReport(row)}
          >
            {busy === `confirm:${row.id}` ? '处理中…' : '标记已读'}
          </button>
        )}
      </footer>
    </article>
  ));

  const selected = detail && detail.id === selectedId ? detail : selectedRow;

  return (
    <div className={cx('pa-report-page', wide && 'pa-page-wide')}>
      <div className="pa-page-heading">
        <div>
          <h2>日报</h2>
        </div>
        <div className="pa-actions">
          {generating && (
            <span className="pa-meta pa-report-progress" role="status">
              生成中…（可能需要 1–2 分钟）· {elapsed}s
            </span>
          )}
          <button type="button" className="pa-primary" disabled={generating} onClick={() => void generate()}>
            {generating ? '生成中…' : '现在生成'}
          </button>
        </div>
      </div>
      {error && <p className="pa-error-inline" role="alert">{error}</p>}
      {loading ? (
        <SkeletonCards />
      ) : rows.length === 0 ? (
        <EmptyState
          text="暂无日报"
          actionLabel="现在生成"
          onAction={() => void generate()}
        />
      ) : wide ? (
        <div className="pa-split">
          <div className="pa-split-list">
            {cards}
            <Pager offset={offset} total={total} onPage={(next) => setOffset(next)} />
          </div>
          {selected ? (
            <section className="pa-split-detail pa-report-detail" aria-label="日报详情">
              <header className="pa-split-head">
                <div>
                  <h2>
                    {reportDay(selected.windowFrom, timezone)} – {reportDay(selected.windowTo, timezone)}
                  </h2>
                  <p className="pa-meta">{reportCountsText(selected)}</p>
                </div>
                <button type="button" aria-label="关闭详情" onClick={() => setSelectedId(null)}>
                  ×
                </button>
              </header>
              {renderDetail(selected)}
            </section>
          ) : (
            <div className="pa-split-empty">选择日报</div>
          )}
        </div>
      ) : (
        <>
          <div className="pa-records pa-records-report">{cards}</div>
          <Pager offset={offset} total={total} onPage={(next) => setOffset(next)} />
          {selected && (
            <Modal title="日报详情" onClose={() => setSelectedId(null)} wide>
              {renderDetail(selected)}
            </Modal>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Today                                                               */
/* ------------------------------------------------------------------ */

function activityText(change: ChangeRecord): string {
  const count = change.summary?.changedObjects;
  const label = change.summary?.type === 'change' ? '变更' : '整理';
  const base = typeof count === 'number' && count > 0 ? `${label}了 ${count} 项` : `${label}已完成`;
  return base;
}

interface TodayProps {
  api: Api;
  timezone: string;
  onChanged: () => void;
  onNavigate: (tab: TabId) => void;
  createSignal: number;
}

function Today({ api, timezone, onChanged, onNavigate, createSignal }: TodayProps) {
  const [quick, setQuick] = useState('');
  const [quickBusy, setQuickBusy] = useState(false);
  const [tasks, setTasks] = useState<Row[]>([]);
  const [events, setEvents] = useState<Row[]>([]);
  const [activity, setActivity] = useState<ChangeRecord[]>([]);
  const [memories, setMemories] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const quickInput = useRef<HTMLInputElement | null>(null);
  const notify = useToast();

  const load = useCallback(async () => {
    try {
      const bounds = dayBounds(timezone);
      const [taskList, eventList, changes, memoryList] = await Promise.all([
        command<ListResult>(api, 'list', { kind: 'task', limit: 100 }),
        command<Row[]>(api, 'calendar', { from: bounds.start, to: bounds.end }),
        command<ChangeRecord[]>(api, 'changes', { offset: 0 }),
        command<ListResult>(api, 'list', { kind: 'memory', limit: 5, sort: 'updated' }),
      ]);
      const today = dayKeyOf(Date.now(), timezone);
      setTasks(taskList.items);
      setEvents(eventList);
      setActivity(
        (changes ?? [])
          .filter((change) => dayKeyOf(change.createdAt, timezone) === today)
          .slice(0, 5),
      );
      setMemories(
        [...memoryList.items].sort((left, right) => updatedTime(right) - updatedTime(left)),
      );
      setError('');
    } catch (errorValue) {
      setError(message(errorValue));
    } finally {
      setLoading(false);
    }
  }, [api, timezone]);

  useEffect(() => {
    void load();
  }, [load]);

  const initialSignal = useRef(createSignal);
  useEffect(() => {
    if (createSignal !== initialSignal.current) {
      initialSignal.current = createSignal;
      quickInput.current?.focus();
    }
  }, [createSignal]);

  const bounds = dayBounds(timezone);
  const openTasks = tasks.filter((row) => {
    const data = row.data;
    if (data.status === 'completed' || data.status === 'cancelled') return false;
    const due = data.dueAt;
    if (!due) return true;
    const ms = Date.parse(due);
    return Number.isFinite(ms) && ms < Date.parse(bounds.end);
  });
  const saveQuick = async (event: FormEvent) => {
    event.preventDefault();
    const body = quick.trim();
    if (!body) return;
    setQuickBusy(true);
    setError('');
    try {
      await api('memory.manual', {
        title: body.slice(0, 24),
        body,
        type: 'fact',
        notes: '',
        domains: [],
        importance: 3,
        pinned: false,
        occurredAt: new Date().toISOString(),
        timePrecision: 'instant',
        requestId: crypto.randomUUID(),
      });
      setQuick('');
      notify('已记录');
      await load();
      onChanged();
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setQuickBusy(false);
    }
  };

  const complete = async (row: Row) => {
    setBusyKey(`task:${row.id}`);
    setError('');
    try {
      await command(api, 'taskEdit', {
        id: row.id,
        revision: row.revision,
        patch: { status: 'completed' },
      });
      notify('任务已完成');
      await load();
      onChanged();
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setBusyKey('');
    }
  };

  return (
    <div className="pa-today">
      <div className="pa-page-heading">
        <div>
          <h2>今天</h2>
          <div className="pa-meta">{formatDate(new Date().toISOString(), timezone)}</div>
        </div>
      </div>
      {error && <div role="alert" className="pa-error">{error}</div>}
      <section className="pa-today-activity" aria-label="动态">
        <header>
          <h3>动态</h3>
          <span className="pa-meta">最近 5 条</span>
        </header>
        {loading ? (
          <div className="pa-skeleton-line" />
        ) : activity.length === 0 ? (
          <p className="pa-meta">今天暂无动态</p>
        ) : (
          activity.map((row) => (
            <div className="pa-activity-row" key={row.id}>
              <span className="pa-meta">{formatTime(row.createdAt, timezone)}</span>
              <span>{activityText(row)}</span>
            </div>
          ))
        )}
      </section>
      <section className="pa-today-quick">
        <h3>快速记录</h3>
        <form className="pa-quick" onSubmit={(event) => void saveQuick(event)}>
          <input
            ref={quickInput}
            aria-label="快速记录"
            value={quick}
            placeholder="记下一句话…"
            onChange={(event) => setQuick(event.target.value)}
          />
          <button className="pa-primary" type="submit" disabled={quickBusy || !quick.trim()}>
            {quickBusy ? '保存中…' : '保存'}
          </button>
        </form>
      </section>
      <div className="pa-today-grid">
        <section className="pa-today-section pa-today-wide">
          <header>
            <h3>待办<span className="pa-count">{openTasks.length}</span></h3>
            <button type="button" className="pa-text-button" onClick={() => onNavigate('task')}>
              全部任务
            </button>
          </header>
          {loading ? (
            <div className="pa-skeleton-line" />
          ) : openTasks.length === 0 ? (
            <EmptyState
              text="今天没有待办"
              actionLabel="查看全部任务"
              onAction={() => onNavigate('task')}
              compact
            />
          ) : (
            openTasks.map((row) => {
              const due = row.data.dueAt;
              const overdue = Boolean(due && Date.parse(due) < Date.now());
              return (
                <div className="pa-row" key={row.id}>
                  <div className="pa-row-main">
                    <span>{row.data.title}</span>
                    <div className="pa-tags">
                      {overdue && <span className="pa-tag pa-overdue">逾期</span>}
                      {due && (
                        <span className="pa-meta">{formatDate(due, timezone)}</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busyKey !== ''}
                    onClick={() => void complete(row)}
                  >
                    {busyKey === `task:${row.id}` ? '处理中…' : '完成'}
                  </button>
                </div>
              );
            })
          )}
        </section>
        <section className="pa-today-section">
          <header>
            <h3>今日日程</h3>
            <button type="button" className="pa-text-button" onClick={() => onNavigate('calendar')}>
              打开日历
            </button>
          </header>
          {loading ? (
            <div className="pa-skeleton-line" />
          ) : events.length === 0 ? (
            <EmptyState
              text="今天没有日程"
              actionLabel="打开日历"
              onAction={() => onNavigate('calendar')}
              compact
            />
          ) : (
            events.map((row) => (
              <div className="pa-row" key={`${row.id}:${row.occurrenceStart ?? ''}`}>
                <div className="pa-row-main">
                  <span>{row.data.title}</span>
                  <div className="pa-meta">
                    {row.data.allDay
                      ? '全天'
                      : formatTime(row.occurrenceStart ?? row.data.start, timezone)}
                    {row.data.location ? ` · ${row.data.location}` : ''}
                  </div>
                </div>
              </div>
            ))
          )}
        </section>
        <section className="pa-today-section">
          <header>
            <h3>最近记忆</h3>
            <button type="button" className="pa-text-button" onClick={() => onNavigate('memory')}>
              全部记忆
            </button>
          </header>
          {loading ? (
            <div className="pa-skeleton-line" />
          ) : memories.length === 0 ? (
            <EmptyState
              text="还没有记忆"
              actionLabel="去记录"
              onAction={() => onNavigate('memory')}
              compact
            />
          ) : (
            memories.map((row) => (
              <div className="pa-row" key={row.id}>
                <div className="pa-row-main">
                  <button
                    type="button"
                    className="pa-title"
                    onClick={() => onNavigate('memory')}
                  >
                    {row.data.title}
                  </button>
                  <div className="pa-meta">{relativeDay(updatedTime(row), timezone)}</div>
                </div>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const SETTINGS_SECTIONS: Array<{ id: string; label: string }> = [
  { id: 'workspace', label: '助手工作区' },
  { id: 'report', label: '报告' },
  { id: 'data', label: '数据与迁移' },
  { id: 'appearance', label: '外观与引导' },
  { id: 'weixin', label: '微信' },
];

function Settings({
  api,
  onChange,
  onBack,
  density,
  onDensityChange,
  onShowHelp,
}: {
  api: Api;
  onChange: () => void;
  onBack: () => void;
  density: Density;
  onDensityChange: (value: Density) => void;
  onShowHelp: () => void;
}) {
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [options, setOptions] = useState<SettingsOptions | null>(null);
  const [section, setSection] = useState('workspace');
  const [root, setRoot] = useState('');
  const [destination, setDestination] = useState('');
  const [password, setPassword] = useState('');
  const [vault, setVault] = useState<{ configured?: boolean }>({});
  const [wechat, setWechat] = useState<WeixinState>({ status: 'disconnected' });
  const [verifyCode, setVerifyCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const notify = useToast();
  const confirm = useConfirm();

  const refresh = useCallback(async () => {
    const [nextSettings, nextVault, nextOptions, nextWechat] = await Promise.all([
      command<Overview>(api, 'overview').then((overview) => {
        setRoot(overview.dataRoot);
        return overview.settings;
      }),
      api<{ configured?: boolean }>('vault.state'),
      api<SettingsOptions>('settings.options'),
      api<WeixinState>('weixin.status'),
    ]);
    setSettings({
      ...nextSettings,
      reportEnabled: nextSettings.reportEnabled ?? REPORT_SETTING_DEFAULTS.reportEnabled,
      reportHour: nextSettings.reportHour ?? REPORT_SETTING_DEFAULTS.reportHour,
      snapshotDays: nextSettings.snapshotDays ?? REPORT_SETTING_DEFAULTS.snapshotDays,
      changeSummaryDays:
        nextSettings.changeSummaryDays ?? REPORT_SETTING_DEFAULTS.changeSummaryDays,
    });
    setVault(nextVault);
    setOptions(nextOptions);
    setDestination(nextOptions.defaults.exportDirectory);
    setWechat(nextWechat);
  }, [api]);

  useEffect(() => {
    refresh().catch((errorValue) => setError(message(errorValue)));
  }, [refresh]);

  usePolling(async () => {
    try {
      setWechat(
        await api<WeixinState>('weixin.poll', { attemptId: wechat.attemptId }),
      );
    } catch (errorValue) {
      setError(message(errorValue));
    }
  }, 3000, Boolean(wechat.attemptId) && ['waiting', 'scaned'].includes(wechat.status));

  usePolling(async () => {
    try {
      setWechat(await api<WeixinState>('weixin.status'));
    } catch {
      // Status polling failures are non-fatal.
    }
  }, 4000, section === 'weixin');

  const act = async (key: string, job: () => Promise<void>, success: string) => {
    setBusy(key);
    setError('');
    try {
      await job();
      notify(success);
      onChange();
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setBusy('');
    }
  };

  const choose = async (target: 'workspace' | 'root' | 'export') => {
    setBusy(`choose:${target}`);
    setError('');
    try {
      const path = await api<string | null>('native.pickDirectory');
      if (!path) return;
      if (target === 'workspace') {
        setSettings((current) => (current ? { ...current, workspace: path } : current));
      }
      if (target === 'root') setRoot(path);
      if (target === 'export') {
        setDestination(await api<string>('data.exportDestination', { parent: path }));
      }
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setBusy('');
    }
  };

  if (!settings || !options) {
    return <EmptyState text={error || '加载中…'} />;
  }

  const reportNumberField = (
    key: 'snapshotDays' | 'changeSummaryDays',
    label: string,
    min: number,
    max: number,
  ) => (
    <Field label={label}>
      <input
        type="number"
        min={min}
        max={max}
        value={settings[key]}
        onChange={(event) => {
          const raw = Number(event.target.value);
          const next = Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.trunc(raw))) : min;
          setSettings({ ...settings, [key]: next });
        }}
      />
    </Field>
  );
  const directory = (label: string, value: string, target: 'workspace' | 'root' | 'export') => (
    <Field label={label}>
      <div className="pa-directory">
        <input value={value} readOnly title={value} />
        <button
          type="button"
          disabled={busy !== ''}
          onClick={() => void choose(target)}
        >
          {busy === `choose:${target}` ? '选择中…' : '浏览…'}
        </button>
      </div>
    </Field>
  );
  const saveButton = (
    <div className="pa-settings-footer">
      <button
        type="button"
        className="pa-primary"
        disabled={busy !== ''}
        onClick={() =>
          void act(
            'save',
            async () => {
              await command(api, 'settingsSave', { ...settings });
            },
            '设置已保存',
          )
        }
      >
        {busy === 'save' ? '保存中…' : '保存设置'}
      </button>
    </div>
  );

  const modelRows: Array<{ id: string; name: string; disabled?: boolean }> = [
    { id: '', name: `跟随 DSH · ${options.defaults.modelName || '未配置模型'}` },
    ...options.models,
  ];
  if (settings.model && !modelRows.some((row) => row.id === settings.model)) {
    modelRows.push({ id: settings.model, name: `${settings.model}（不可用）`, disabled: true });
  }
  const presetRows: Array<{ id: string; name: string; disabled?: boolean }> = [
    { id: 'default', name: `跟随 DSH · ${options.defaults.presetName}` },
    ...options.presets.map((preset) => ({
      id: preset.id,
      name: preset.name ?? preset.id,
      disabled: Boolean(preset.broken),
    })),
  ];
  if (!presetRows.some((row) => row.id === settings.basePreset)) {
    presetRows.push({
      id: settings.basePreset,
      name: `${settings.basePreset}（不可用）`,
      disabled: true,
    });
  }

  const wechatStatus =
    (
      {
        connected: '已连接',
        waiting: '待扫码',
        need_verifycode: '待验证',
        expired: '已过期',
        error: '连接失败',
      } as Record<string, string>
    )[wechat.status] ?? '未连接';

  return (
    <div className="pa-settings-layout">
      <nav className="pa-settings-nav" aria-label="设置分类">
        {SETTINGS_SECTIONS.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-current={section === item.id ? 'page' : undefined}
            className={section === item.id ? 'pa-selected' : ''}
            onClick={() => {
              setSection(item.id);
              setError('');
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="pa-settings-body">
        <div className="pa-page-heading">
          <h2>设置</h2>
          <button type="button" className="pa-text-button" onClick={onBack}>
            返回今天
          </button>
        </div>
        {section === 'workspace' && (
          <section className="pa-settings-card">
            <header><h3>助手工作区</h3></header>
            <div className="pa-settings-fields">
              <Field label="模型">
                <select
                  value={settings.model}
                  onChange={(event) => setSettings({ ...settings, model: event.target.value })}
                >
                  {modelRows.map((row) => (
                    <option key={row.id} value={row.id} disabled={row.disabled}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="基础助手">
                <select
                  value={settings.basePreset}
                  onChange={(event) =>
                    setSettings({ ...settings, basePreset: event.target.value })
                  }
                >
                  {presetRows.map((row) => (
                    <option key={row.id} value={row.id} disabled={row.disabled}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </Field>
              {directory('工作目录', settings.workspace || options.defaults.workspace || '', 'workspace')}
              {settings.workspace && (
                <button
                  type="button"
                  className="pa-text-button"
                  onClick={() => setSettings({ ...settings, workspace: '' })}
                >
                  恢复默认目录
                </button>
              )}
            </div>
            {saveButton}
          </section>
        )}
        {section === 'report' && (
          <section className="pa-settings-card">
            <header>
              <h3>报告</h3>
              <label className="pa-switch">
                <input
                  aria-label="每日报告"
                  type="checkbox"
                  checked={settings.reportEnabled}
                  onChange={(event) =>
                    setSettings({ ...settings, reportEnabled: event.target.checked })
                  }
                />
                <span>每日报告</span>
              </label>
            </header>
            <div className="pa-settings-fields">
              <div className="pa-grid2">
                <Field label="时区">
                  <select
                    value={settings.timezone}
                    onChange={(event) => setSettings({ ...settings, timezone: event.target.value })}
                  >
                    {Array.from(new Set([settings.timezone, ...TIMEZONES])).map((zone) => (
                      <option key={zone} value={zone}>{zone}</option>
                    ))}
                  </select>
                </Field>
                <Field label="生成时间">
                  <select
                    value={settings.reportHour ?? 7}
                    onChange={(event) =>
                      setSettings({ ...settings, reportHour: Number(event.target.value) })
                    }
                  >
                    {Array.from({ length: 24 }, (_, hour) => (
                      <option key={hour} value={hour}>
                        {String(hour).padStart(2, '0')}:00
                      </option>
                    ))}
                  </select>
                </Field>
                {reportNumberField('snapshotDays', '快照保留天数', 1, 90)}
                {reportNumberField('changeSummaryDays', '变更摘要保留天数', 1, 365)}
              </div>
            </div>
            {saveButton}
          </section>
        )}
        {section === 'data' && (
          <>
            <section className="pa-settings-card">
              <header><h3>数据目录</h3></header>
              <div className="pa-settings-fields">
                {directory('当前目录', root, 'root')}
              </div>
              <div className="pa-settings-footer">
                <button
                  type="button"
                  disabled={busy !== ''}
                  onClick={async () => {
                    const ok = await confirm({
                      title: '切换数据目录？',
                      body: `助手将改用「${root}」作为数据目录，当前目录的数据不会自动迁移。`,
                      confirmLabel: '切换',
                    });
                    if (!ok) return;
                    await act(
                      'root',
                      async () => {
                        await api('data.select', { root, requestId: crypto.randomUUID() });
                        await refresh();
                      },
                      '已切换数据目录',
                    );
                  }}
                >
                  {busy === 'root' ? '切换中…' : '使用此目录'}
                </button>
              </div>
            </section>
            <DataHealth api={api} root={root} />
            <section className="pa-settings-card">
              <header><h3>导出备份</h3></header>
              <div className="pa-settings-fields">
                {directory('导出目录', destination, 'export')}
              </div>
              <div className="pa-settings-footer">
                <button
                  type="button"
                  className="pa-primary"
                  disabled={busy !== ''}
                  onClick={() =>
                    void act(
                      'export',
                      async () => {
                        await api('data.export', { destination, requestId: crypto.randomUUID() });
                      },
                      '已导出备份',
                    )
                  }
                >
                  {busy === 'export' ? '导出中…' : '导出'}
                </button>
              </div>
            </section>
          </>
        )}
        {section === 'appearance' && (
          <section className="pa-settings-card">
            <header><h3>外观与引导</h3></header>
            <div className="pa-settings-fields">
              <Field label="界面密度">
                <div className="pa-segments" role="group" aria-label="界面密度">
                  <button
                    type="button"
                    className={cx(density === 'standard' && 'pa-selected')}
                    aria-pressed={density === 'standard'}
                    onClick={() => onDensityChange('standard')}
                  >
                    标准
                  </button>
                  <button
                    type="button"
                    className={cx(density === 'compact' && 'pa-selected')}
                    aria-pressed={density === 'compact'}
                    onClick={() => onDensityChange('compact')}
                  >
                    紧凑
                  </button>
                </div>
              </Field>
              <div className="pa-actions">
                <button type="button" onClick={onShowHelp}>快捷键帮助</button>
              </div>
            </div>
          </section>
        )}
        {section === 'weixin' && (
          <section className="pa-settings-card">
            <header>
              <h3>微信</h3>
              <span
                className={cx(
                  'pa-status',
                  wechat.status === 'connected' && 'pa-status-active',
                )}
              >
                {wechatStatus}
              </span>
            </header>
            <div className="pa-settings-fields pa-weixin-connect">
              <div className="pa-connection-symbol">
                <svg viewBox="0 0 32 32" width="36" height="36" fill="none" aria-hidden="true">
                  <path
                    d="M26 15c0 6-5 10-11 10l-6 3 1-5C6 21 4 18 4 14 4 8 9 4 15 4s11 5 11 11Z"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <circle cx="11" cy="13" r="1.6" fill="currentColor" />
                  <circle cx="19" cy="13" r="1.6" fill="currentColor" />
                </svg>
              </div>
              {wechat.qrImage && wechat.status !== 'connected' && (
                <img className="pa-qr" src={wechat.qrImage} alt="微信登录二维码" />
              )}
              <div className="pa-actions">
                <button
                  type="button"
                  className="pa-primary"
                  disabled={busy !== ''}
                  onClick={() =>
                    void act(
                      'weixin',
                      async () => {
                        setWechat(
                          await api<WeixinState>('weixin.begin', {
                            requestId: crypto.randomUUID(),
                          }),
                        );
                      },
                      '二维码已生成',
                    )
                  }
                >
                  {busy === 'weixin'
                    ? '处理中…'
                    : wechat.status === 'connected'
                      ? '重新连接'
                      : wechat.qrImage
                        ? '刷新二维码'
                        : '连接微信'}
                </button>
                {wechat.status === 'connected' && (
                  <button
                    type="button"
                    className="pa-danger"
                    disabled={busy !== ''}
                    onClick={async () => {
                      const ok = await confirm({
                        title: '断开微信连接？',
                        body: '将清除本机保存的微信连接，之后需要重新扫码。',
                        confirmLabel: '断开连接',
                      });
                      if (!ok) return;
                      await act(
                        'disconnect',
                        async () => {
                          await api('weixin.disconnect', { requestId: crypto.randomUUID() });
                          setWechat(await api<WeixinState>('weixin.status'));
                        },
                        '已断开微信连接',
                      );
                    }}
                  >
                    {busy === 'disconnect' ? '处理中…' : '断开连接'}
                  </button>
                )}
              </div>
              {wechat.status === 'need_verifycode' && (
                <Field label="验证码">
                  <input
                    inputMode="numeric"
                    value={verifyCode}
                    onChange={(event) => setVerifyCode(event.target.value)}
                  />
                </Field>
              )}
              {wechat.attemptId && (
                <button
                  type="button"
                  className="pa-text-button"
                  disabled={busy !== ''}
                  onClick={() =>
                    void act(
                      'poll',
                      async () => {
                        setWechat(
                          await api<WeixinState>('weixin.poll', {
                            attemptId: wechat.attemptId,
                            verifyCode: verifyCode || undefined,
                            requestId: crypto.randomUUID(),
                          }),
                        );
                      },
                      '已刷新连接状态',
                    )
                  }
                >
                  {busy === 'poll' ? '处理中…' : '刷新连接状态'}
                </button>
              )}
              {wechat.error && (
                <div role="alert" className="pa-error">
                  {ERROR_LABELS[wechat.error] ?? wechat.error}
                </div>
              )}
            </div>
            {vault.configured && wechat.status !== 'connected' && (
              <details className="pa-advanced pa-legacy">
                <summary>恢复旧版连接</summary>
                <Field label="旧版迁移口令">
                  <input
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
                <button
                  type="button"
                  disabled={busy !== '' || !password}
                  onClick={() =>
                    void act(
                      'vault',
                      async () => {
                        await api('vault.unlock', {
                          passphrase: password,
                          requestId: crypto.randomUUID(),
                        });
                        setPassword('');
                        setWechat(await api<WeixinState>('weixin.status'));
                      },
                      '已恢复连接',
                    )
                  }
                >
                  {busy === 'vault' ? '处理中…' : '恢复连接'}
                </button>
              </details>
            )}
          </section>
        )}
        {error && <div role="alert" className="pa-error">{error}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App shell                                                           */
/* ------------------------------------------------------------------ */

const BOTTOM_TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'today', label: '今天', icon: '☀' },
  { id: 'memory', label: '记忆', icon: '◈' },
  { id: 'task', label: '任务', icon: '✓' },
  { id: 'calendar', label: '日历', icon: '▦' },
];

const MORE_TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'project', label: '项目', icon: '▤' },
  { id: 'tool', label: '工具', icon: '⚒' },
  { id: 'report', label: '日报', icon: '≡' },
  { id: 'settings', label: '设置', icon: '⚙' },
];

function App({ api, initialTab = 'today' }: { api: Api; initialTab?: string }) {
  const [tab, setTab] = useState<TabId>(() =>
    [...NAV_TABS.map((item) => item.id), 'settings'].includes(initialTab as TabId)
      ? (initialTab as TabId)
      : 'today',
  );
  const [overview, setOverview] = useState<Overview>({
    counts: {},
    unread: 0,
    dataRoot: '',
    settings: {
      timezone: 'Asia/Shanghai',
      retentionHours: 0,
      rawDays: 0,
      maintenanceHour: 0,
      maintenanceEnabled: false,
      maintenanceMaxItems: 0,
      maintenanceMaxSeconds: 0,
      contextCharacters: 0,
      rollbackMegabytes: 0,
      model: '',
      basePreset: '',
      workspace: '',
      reportEnabled: REPORT_SETTING_DEFAULTS.reportEnabled,
      reportHour: REPORT_SETTING_DEFAULTS.reportHour,
      snapshotDays: REPORT_SETTING_DEFAULTS.snapshotDays,
      changeSummaryDays: REPORT_SETTING_DEFAULTS.changeSummaryDays,
    },
  });
  const [error, setError] = useState('');
  const [createSignal, setCreateSignal] = useState(0);
  const [createRequest, setCreateRequest] = useState<{ kind: Kind; nonce: number } | null>(null);
  const [focusRequest, setFocusRequest] = useState<
    { kind: Kind; id: string; mode: 'read' | 'edit'; nonce: number } | null
  >(null);
  const [eventRequest, setEventRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [entityId, setEntityId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [density, setDensity] = useState<Density>(() => readDensity());
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1200px)').matches,
  );
  const notify = useToast();
  const root = useRef<HTMLElement | null>(null);
  const refresh = useCallback(() => {
    void command<Overview>(api, 'overview')
      .then(setOverview)
      .catch((errorValue) => setError(message(errorValue)));
  }, [api]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  usePolling(refresh, 10000);

  useEffect(() => {
    document.documentElement.dataset.paDensity = density;
    try {
      localStorage.setItem('pa.density', density);
    } catch {
      // Local storage can be unavailable in private contexts.
    }
  }, [density]);

  useEffect(() => {
    const query = window.matchMedia('(min-width: 1200px)');
    const onChange = () => setWide(query.matches);
    onChange();
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

  const openSearchItem = (item: SearchItem) => {
    if (item.kind === 'entity') {
      setEntityId(item.id);
      return;
    }
    if (item.kind === 'event') {
      setTab('calendar');
      setEventRequest({ id: item.id, nonce: Date.now() });
      return;
    }
    setTab(item.kind as TabId);
    setFocusRequest({
      kind: item.kind,
      id: item.id,
      mode: item.kind === 'task' ? 'edit' : 'read',
      nonce: Date.now(),
    });
  };

  const requestCreate = (kind: Kind) => {
    if (kind === 'memory' || kind === 'project' || kind === 'task' || kind === 'tool') {
      setCreateRequest({ kind, nonce: Date.now() });
    }
  };

  const createForCurrentTab = () => {
    if (tab === 'memory' || tab === 'project' || tab === 'task' || tab === 'tool') {
      requestCreate(tab);
    } else if (tab === 'calendar' || tab === 'today') {
      setCreateSignal((value) => value + 1);
    } else {
      setTab('memory');
      setCreateRequest({ kind: 'memory', nonce: Date.now() });
    }
  };

  const maintain = async () => {
    try {
      await api('maintenance.run', { requestId: crypto.randomUUID() });
      notify('已开始整理，完成后可在动态里查看');
      refresh();
    } catch (errorValue) {
      notify(message(errorValue), { tone: 'error' });
    }
  };

  const exportData = async () => {
    try {
      const info = await exportBackup(api);
      if (!info) return;
      try {
        localStorage.setItem('pa.lastExport', JSON.stringify(info));
      } catch {
        // Ignore unavailable storage.
      }
      notify(`已导出：${info.name}`);
    } catch (errorValue) {
      notify(message(errorValue), { tone: 'error' });
    }
  };

  const newMemory = () => {
    setTab('memory');
    setCreateRequest({ kind: 'memory', nonce: Date.now() });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (document.querySelector('.pa-modal')) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === '/') {
        event.preventDefault();
        root.current
          ?.querySelector<HTMLInputElement>('[data-pa-search]')
          ?.focus();
      } else if (event.key === 'n') {
        event.preventDefault();
        createForCurrentTab();
      } else if (event.key === '?') {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  const timezone = overview.settings.timezone || 'Asia/Shanghai';
  const recordProps = {
    api,
    timezone,
    onChange: refresh,
    createSignal,
    wide,
    openRequest: focusRequest,
    onOpenConsumed: () => setFocusRequest(null),
    createRequest,
    onCreateConsumed: () => setCreateRequest(null),
  };
  return (
    <main
      className={cx('pa-app', Boolean(window.__DSH_DIRECTORY_PICKER__) && 'pa-desktop')}
      ref={root}
    >
      <header className="pa-header">
        <div className="pa-brand">
          <div className="pa-mark" aria-hidden="true">✦</div>
          <h1>个人助手</h1>
        </div>
        <div className="pa-header-actions">
          <button
            type="button"
            className="pa-search-button"
            aria-label="搜索与命令"
            title="搜索与命令（⌘K）"
            onClick={() => setPaletteOpen(true)}
          >
            <span aria-hidden="true">⌕</span>
            <span className="pa-search-button-label">搜索</span>
            <span className="pa-kbd">⌘K</span>
          </button>
          <span className="pa-meta">{timezone}</span>
          <button
            type="button"
            className={cx('pa-icon-button', tab === 'settings' && 'pa-selected')}
            aria-label="设置"
            title="设置"
            aria-pressed={tab === 'settings'}
            onClick={() => setTab(tab === 'settings' ? 'today' : 'settings')}
          >
            ⚙
          </button>
        </div>
      </header>
      <nav className="pa-nav" role="tablist" aria-label="助手导航">
        {NAV_TABS.map((item) => (
          <button
            key={item.id}
            id={`pa-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`pa-panel-${item.id}`}
            className={tab === item.id ? 'pa-selected' : ''}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="pa-content">
        <div
          className={cx('pa-page', wide && 'pa-page-wide')}
          id={`pa-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`pa-tab-${tab}`}
        >
          {error && <div role="alert" className="pa-error">{error}</div>}
          {tab === 'today' && (
            <Today
              api={api}
              timezone={timezone}
              onChanged={refresh}
              onNavigate={setTab}
              createSignal={createSignal}
            />
          )}
          {tab === 'memory' && <Records key="memory" kind="memory" {...recordProps} />}
          {tab === 'project' && <ProjectPage api={api} onCreateConsumed={()=>setCreateRequest(null)} onChange={refresh} focusId={focusRequest?.kind === 'project' ? focusRequest.id : undefined} createNonce={createRequest?.kind === 'project' ? createRequest.nonce : undefined} onOpen={(kind,id)=>openSearchItem({kind:kind as SearchKind,id,title:''})} />}
          {tab === 'task' && <Records key="task" kind="task" {...recordProps} />}
          {tab === 'tool' && <Records key="tool" kind="tool" {...recordProps} />}
          {tab === 'calendar' && (
            <Calendar
              api={api}
              timezone={timezone}
              onChange={refresh}
              createSignal={createSignal}
              openRequest={eventRequest}
              onOpenConsumed={() => setEventRequest(null)}
            />
          )}
          {tab === 'report' && (
            <ReportPage api={api} timezone={timezone} wide={wide} />
          )}
          {tab === 'settings' && (
            <Settings
              api={api}
              onChange={refresh}
              onBack={() => setTab('today')}
              density={density}
              onDensityChange={setDensity}
              onShowHelp={() => setHelpOpen(true)}
            />
          )}
        </div>
      </div>
      <nav className="pa-bottom-nav" aria-label="移动端导航">
        {BOTTOM_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? 'pa-selected' : ''}
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => {
              setTab(item.id);
              setMoreOpen(false);
            }}
          >
            <span aria-hidden="true">{item.icon}</span>
            {item.label}
          </button>
        ))}
        <button
          type="button"
          className={cx(['project', 'tool', 'report', 'settings'].includes(tab) && 'pa-selected')}
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((value) => !value)}
        >
          <span aria-hidden="true">⋯</span>
          更多
        </button>
      </nav>
      {moreOpen && (
        <div
          className="pa-sheet-backdrop"
          role="presentation"
          onClick={() => setMoreOpen(false)}
        >
          <div
            className="pa-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="更多"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="pa-sheet-handle" aria-hidden="true" />
            <h3>更多</h3>
            <nav>
              {MORE_TABS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={tab === item.id ? 'pa-selected' : ''}
                  onClick={() => {
                    setTab(item.id);
                    setMoreOpen(false);
                  }}
                >
                  <span aria-hidden="true">{item.icon}</span> {item.label}
                </button>
              ))}
            </nav>
            <button type="button" onClick={() => setMoreOpen(false)}>关闭</button>
          </div>
        </div>
      )}
      {paletteOpen && (
        <CommandPalette
          api={api}
          density={density}
          onClose={() => setPaletteOpen(false)}
          onNavigate={(next) => setTab(next)}
          onOpenItem={openSearchItem}
          onCreateMemory={newMemory}
          onMaintain={() => void maintain()}
          onExport={() => void exportData()}
          onToggleDensity={() =>
            setDensity((value) => (value === 'compact' ? 'standard' : 'compact'))
          }
          onHelp={() => setHelpOpen(true)}
        />
      )}
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
      {entityId && (
        <EntityPeek api={api} id={entityId} onClose={() => setEntityId(null)} />
      )}
    </main>
  );
}

function AssistantApp(props: { api: Api; initialTab?: string }) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <App {...props} />
      </ConfirmProvider>
    </ToastProvider>
  );
}

/* ------------------------------------------------------------------ */
/* Plugin registration                                                 */
/* ------------------------------------------------------------------ */

interface PluginCtx {
  effect(effect: () => void | (() => void)): void;
  connection: {
    rpc: {
      call(path: string, endpoint: string, payload: unknown): Promise<RpcResponse>;
    };
  };
  uiWorkspace: {
    pickDirectory(): Promise<string | null>;
    openSession(sessionId: string): void;
  };
  slots: {
    inject(name: string, register: () => void): void;
    register<P>(meta: Record<string, unknown>, component: ComponentType<P>): void;
  };
  layout: { selectPanel(id: string): void };
}

export function apply(ctx: PluginCtx) {
  const api: Api = async <T,>(method: string, payload: Payload = {}) => {
    if (method === 'native.pickDirectory') {
      const desktop = window.__DSH_DIRECTORY_PICKER__;
      return (desktop ? desktop.pick() : ctx.uiWorkspace.pickDirectory()) as T;
    }
    if (method === 'native.open') {
      const sessionId = (payload as { sessionId?: string }).sessionId ?? '';
      ctx.uiWorkspace.openSession(sessionId);
      return undefined as T;
    }
    const result = await ctx.connection.rpc.call('/api', 'personal-assistant', {
      method,
      payload,
    });
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message ?? '无法连接助手。'), result?.error);
    return result.value as T;
  };
  ctx.effect(() => {
    const element = document.createElement('style');
    element.dataset.personalAssistant = 'true';
    element.textContent = styles;
    document.head.append(element);
    return () => element.remove();
  });
  function Page() {
    return <AssistantApp api={api} />;
  }
  function Icon({ size = 20 }: { size?: number }) {
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <rect x="3" y="3" width="14" height="14" rx="4" stroke="currentColor" />
        <path d="M7 7h6M7 10h6M7 13h3" stroke="currentColor" />
      </svg>
    );
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'personal-assistant' }, Page));
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: 'personal-assistant', order: 9, label: () => '助手管理' },
      Icon,
    ),
  );
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'personal-assistant', order: 22, label: () => '个人助手' },
      () => <AssistantApp api={api} initialTab="settings" />,
    ),
  );
  ctx.slots.inject('plugins.detail.actions', () =>
    ctx.slots.register(
      { name: 'plugins.detail.actions', id: 'personal-assistant-open', order: 10 },
      ({ subject }: { subject?: { pkg?: { name?: string } } }) =>
        subject?.pkg?.name === 'dsh-personal-assistant' ? (
          <button type="button" onClick={() => ctx.layout.selectPanel('personal-assistant')}>
            打开助手管理
          </button>
        ) : null,
    ),
  );
}
