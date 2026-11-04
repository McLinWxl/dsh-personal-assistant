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
  error?: { message?: string };
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
  applied: '可撤回',
  expired: '已到期',
  undone: '已撤回',
  'undone-with-preserved-edits': '已撤回并保留修改',
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
  UNDO_EXPIRED: '撤回期限已到。',
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
  goal?: string;
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
  projectId?: string | null;
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
  originalClaims?: Array<{ at: string; body: string }>;
  result?: string;
  selected?: boolean;
  createdAt?: string | number;
  updatedAt?: string | number;
}

interface Row {
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

interface Notification {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: number;
  read_at?: number | null;
  changeStatus?: string | null;
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

interface ChangeNode {
  id?: string;
  revision?: number;
  data?: RowData;
}

interface FieldDelta {
  name: string;
  before: unknown;
  after: unknown;
}

interface ChangeDelta {
  tableName: string;
  objectId: string;
  before?: ChangeNode | null;
  after?: ChangeNode | null;
  fields?: FieldDelta[];
}

interface ChangeItem {
  id: string;
  before?: ChangeNode | null;
  after?: ChangeNode | null;
  fields?: FieldDelta[];
}

interface ChangeDetail extends ChangeRecord {
  items: ChangeItem[];
  deltas?: ChangeDelta[];
  expiresDisplay?: string;
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
}

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
  goal: string;
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
    goal: data.goal ?? '',
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
    projectId: data.projectId ?? '',
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
    projectId: data.projectId ?? '',
  };
}

function recordPayload(kind: Kind, form: FormState, timezone: string): Payload {
  const domains = splitList(form.domainsText);
  if (kind === 'project') {
    return {
      title: form.title,
      goal: form.goal,
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
      ? { id: form.id, revision: form.revision, definition }
      : { definition });
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
  | 'inbox'
  | 'settings';

type Kind = 'memory' | 'project' | 'task' | 'tool' | 'event';

const NAV_TABS: Array<{ id: TabId; label: string }> = [
  { id: 'today', label: '今天' },
  { id: 'memory', label: '记忆' },
  { id: 'project', label: '项目' },
  { id: 'calendar', label: '日历' },
  { id: 'task', label: '任务' },
  { id: 'tool', label: '工具' },
  { id: 'inbox', label: '收件箱' },
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
  if (kind === 'project') return data.goal ?? '';
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
            value={form.goal}
            onChange={(value) => update({ goal: value })}
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
        const memories = await command<RelatedMemory[]>(api, 'related', {
          projectId: id,
        });
        setRelated(memories);
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
  if (data.dueAt) meta.push({ label: '截止', value: formatDate(data.dueAt, timezone) });
  if (data.projectId) {
    const project = projects.find((item) => item.id === data.projectId);
    if (project) meta.push({ label: '项目', value: project.data.title ?? '' });
  }
  if (kind === 'event' && data.start) {
    meta.push({ label: '开始', value: formatDate(data.start, timezone) });
  }
  if (data.location) meta.push({ label: '地点', value: data.location });

  return (
    <Modal
      title={title}
      onClose={onClose}
      dirty={dirty}
      wide={mode === 'edit' && kind === 'event'}
    >
      {loading ? (
        <div className="pa-dialog-body">
          <div className="pa-skeleton-line" />
          <div className="pa-skeleton-line pa-skeleton-short" />
        </div>
      ) : mode === 'read' ? (
        <>
          <div className="pa-detail">
            {meta.length > 0 && (
              <div className="pa-detail-meta">
                {meta.map((item) => (
                  <span className="pa-tag" key={item.label}>
                    {item.label}：{item.value}
                  </span>
                ))}
              </div>
            )}
            {body && <p className="pa-detail-body">{body}</p>}
            {data.notes && <p className="pa-detail-note">{data.notes}</p>}
            {data.result && <pre>{data.result}</pre>}
            {(data.observations ?? []).length > 0 && (
              <section className="pa-detail-section">
                <h3>观察记录</h3>
                {(data.observations ?? []).map((item, index) => (
                  <div className="pa-meta" key={`${item.at}-${index}`}>
                    {formatDate(item.at, timezone)} {item.body ?? ''}
                  </div>
                ))}
              </section>
            )}
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
                    <span className="pa-tag">
                      {{
                        belongs_to: '所属',
                        reuses_method: '复用',
                        about: '主题',
                        related_to: '相关',
                      }[relation.kind] ?? relation.kind}
                    </span>
                    <h3>{relation.object.data.title}</h3>
                  </article>
                ))}
              </section>
            )}
            {kind === 'project' && related.length > 0 && (
              <section className="pa-detail-section">
                <h3>相关经验</h3>
                {related.map((memory) => (
                  <article key={memory.id}>
                    <h3>{memory.title}</h3>
                    <p>{memory.body}</p>
                    <button
                      type="button"
                      disabled={busyKey !== ''}
                      onClick={() => void associate(memory)}
                    >
                      {busyKey === `associate:${memory.id}` ? '处理中…' : '关联'}
                    </button>
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
      )}
    </Modal>
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
}

function Records({ api, kind, timezone, onChange, createSignal }: RecordsProps) {
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
  const [busyKey, setBusyKey] = useState('');
  const [history, setHistory] = useState(false);
  const notify = useToast();
  const confirm = useConfirm();
  const sequence = useRef(0);
  const label = kindLabel(kind);
  const filterable = kind !== 'project' && kind !== 'tool';
  const projectTitle = projects.find((item) => item.id === project)?.data.title;

  const refresh = useCallback(async () => {
    const current = sequence.current + 1;
    sequence.current = current;
    try {
      const data = await command<ListResult>(api, 'list', {
        kind,
        query: debouncedQuery,
        projectId: project || undefined,
        offset,
        limit: 30,
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
  }, [api, debouncedQuery, kind, offset, project, sort]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void command<ListResult>(api, 'list', { kind: 'project', limit: 100 })
      .then((data) => setProjects(data.items))
      .catch((errorValue) => setError(message(errorValue)));
  }, [api]);

  useEffect(() => {
    setOffset(0);
  }, [debouncedQuery, project, sort]);

  usePolling(refresh, 4000, kind === 'task' || kind === 'tool');

  const initialSignal = useRef(createSignal);
  useEffect(() => {
    if (createSignal !== initialSignal.current) {
      initialSignal.current = createSignal;
      setCreateOpen(true);
    }
  }, [createSignal]);

  const open = (row: Row, mode: 'read' | 'edit') => setSelected({ row, mode });

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
            onClick={() => setCreateOpen(true)}
          >
            新建{label}
          </button>
        </div>
      </div>
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
      {error && <div role="alert" className="pa-error">{error}</div>}
      {loading ? (
        <SkeletonCards />
      ) : rows.length === 0 ? (
        <EmptyState
          text={debouncedQuery || project ? `没有找到匹配的${label}` : `还没有${label}`}
          actionLabel={debouncedQuery || project ? '清除筛选' : `新建${label}`}
          onAction={() => {
            if (debouncedQuery || project) {
              setQuery('');
              setProject('');
              setOffset(0);
            } else {
              setCreateOpen(true);
            }
          }}
        />
      ) : (
        <div className={cx('pa-records', `pa-records-${kind}`)}>
          {rows.map((row) => (
            <article className="pa-card" key={row.id}>
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
              </div>
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
          ))}
        </div>
      )}
      {!loading && rows.length > 0 && (
        <Pager offset={offset} total={total} onPage={setOffset} />
      )}
      {selected && (
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
        />
      )}
      {createOpen && (
        <RecordDialog
          key="create"
          api={api}
          kind={kind}
          create
          projects={projects}
          timezone={timezone}
          onClose={() => setCreateOpen(false)}
          onChanged={() => {
            void refresh();
            onChange();
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Run history and tool versions                                       */
/* ------------------------------------------------------------------ */

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
}

function Calendar({ api, timezone, onChange, createSignal }: CalendarProps) {
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
    void command<ListResult>(api, 'list', { kind: 'project', limit: 100 })
      .then((data) => setProjects(data.items))
      .catch((errorValue) => setError(message(errorValue)));
  }, [api]);

  const open = (row?: Row, day?: string) => {
    const form = makeEventForm(row, day, timezone);
    setEditor({ form, initial: form });
  };

  const initialSignal = useRef(createSignal);
  useEffect(() => {
    if (createSignal !== initialSignal.current) {
      initialSignal.current = createSignal;
      open();
    }
  }, [createSignal]);

  const filtered = rows.filter(
    (row) =>
      (!project || row.data.projectId === project) &&
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
                    style={{ borderLeftColor: projectColor(row.data.projectId) }}
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
              style={{ borderLeftColor: projectColor(row.data.projectId) }}
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
/* Change dialog                                                       */
/* ------------------------------------------------------------------ */

const FIELD_LABELS: Record<string, string> = {
  title: '名称',
  body: '正文',
  goal: '目标',
  description: '描述',
  notes: '备注',
  domains: '领域',
  topics: '主题',
  pinned: '固定',
  importance: '重要性',
  status: '状态',
  type: '类别',
  facts: '事实',
  canonicalFacts: '事实提炼',
  derivedDirty: '整理状态',
  reusable: '可复用',
  dueAt: '截止时间',
  projectId: '项目',
  location: '地点',
};

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '无';
  if (typeof value === 'string') return value || '空';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(displayValue).join('、');
  return JSON.stringify(value, null, 2);
}

function nodeTitle(node: ChangeNode | null | undefined): string {
  return node?.data?.title ?? '关联项';
}

function fallbackNodeText(node: ChangeNode | null | undefined): string {
  if (!node) return '无';
  const data = node.data ?? {};
  return (
    data.body ??
    data.goal ??
    data.description ??
    (data.title ? data.title : '关联已存在')
  );
}

function DiffTable({ fields }: { fields: FieldDelta[] }) {
  return (
    <div className="pa-diff">
      <div className="pa-diff-head">
        <span>字段</span>
        <span>修改前</span>
        <span>修改后</span>
      </div>
      {fields.map((field) => (
        <div className="pa-diff-row" key={field.name}>
          <span className="pa-diff-name">
            {FIELD_LABELS[field.name] ?? field.name}
          </span>
          <span>{displayValue(field.before)}</span>
          <span>{displayValue(field.after)}</span>
        </div>
      ))}
    </div>
  );
}

function FallbackDiff({
  before,
  after,
}: {
  before: ChangeNode | null | undefined;
  after: ChangeNode | null | undefined;
}) {
  return (
    <div className="pa-grid2">
      <div>
        <div className="pa-meta">修改前</div>
        <p>{fallbackNodeText(before)}</p>
      </div>
      <div>
        <div className="pa-meta">修改后</div>
        <p>{fallbackNodeText(after)}</p>
      </div>
    </div>
  );
}

function ChangeDetailsDialog({
  api,
  changeId,
  onClose,
}: {
  api: Api;
  changeId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ChangeDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void command<ChangeDetail>(api, 'change', { id: changeId })
      .then((value) => {
        if (live) setDetail(value);
      })
      .catch((errorValue) => {
        if (live) setError(message(errorValue));
      });
    return () => {
      live = false;
    };
  }, [api, changeId]);
  const deltas = detail?.deltas ?? [];
  const items = detail?.items ?? [];
  const fieldsById = new Map<string, FieldDelta[]>();
  for (const item of items) {
    if (item.fields && item.fields.length > 0) {
      fieldsById.set(item.id, item.fields);
    }
  }
  return (
    <Modal title="变更详情" onClose={onClose} wide>
      <div className="pa-detail">
        {!detail && !error && <p className="pa-meta">加载中…</p>}
        {detail && detail.expiresDisplay && (
          <p className="pa-meta">撤回截止 {detail.expiresDisplay}</p>
        )}
        {error && <div role="alert" className="pa-error">{error}</div>}
        {deltas.map((delta) => {
          const fields = delta.fields?.length
            ? delta.fields
            : fieldsById.get(delta.objectId);
          return (
            <article key={`${delta.tableName}:${delta.objectId}`}>
              <div className="pa-card-head">
                <h3>{nodeTitle(delta.after ?? delta.before)}</h3>
                <span className="pa-tag">{delta.tableName}</span>
              </div>
              {fields && fields.length > 0 ? (
                <DiffTable fields={fields} />
              ) : (
                <FallbackDiff before={delta.before} after={delta.after} />
              )}
            </article>
          );
        })}
        {deltas.length === 0 &&
          items.map((item) => (
            <article key={item.id}>
              <h3>{nodeTitle(item.after ?? item.before)}</h3>
              {item.fields && item.fields.length > 0 ? (
                <DiffTable fields={item.fields} />
              ) : (
                <FallbackDiff before={item.before} after={item.after} />
              )}
            </article>
          ))}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Inbox                                                               */
/* ------------------------------------------------------------------ */

interface InboxProps {
  api: Api;
  timezone: string;
  onChange: () => void;
}

function Inbox({ api, timezone, onChange }: InboxProps) {
  const [rows, setRows] = useState<Notification[]>([]);
  const [changes, setChanges] = useState<ChangeRecord[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [view, setView] = useState<'notifications' | 'changes'>('notifications');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const notify = useToast();
  const confirm = useConfirm();

  const refresh = useCallback(async () => {
    const [nextJobs, nextRows, nextChanges] = await Promise.all([
      api<Job[]>('jobs'),
      command<Notification[]>(api, 'inbox'),
      command<ChangeRecord[]>(api, 'changes'),
    ]);
    setJobs(nextJobs);
    setRows(nextRows);
    setChanges(nextChanges);
  }, [api]);

  useEffect(() => {
    refresh().catch((errorValue) => setError(message(errorValue)));
  }, [refresh]);
  usePolling(async () => {
    try {
      await refresh();
    } catch {
      // Polling failures stay quiet; the inline error is shown on explicit actions.
    }
  }, 3000);

  const maintenanceRunning = jobs.some(
    (job) => job.kind === 'memory' && job.status === 'running',
  );

  const runMaintenance = async () => {
    setBusyKey('maintain');
    setError('');
    try {
      await api('maintenance.run', { requestId: crypto.randomUUID() });
      notify('已加入整理队列');
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

  const readOne = async (notification: Notification) => {
    setBusyKey(`read:${notification.id}`);
    try {
      await command(api, 'inboxRead', { id: notification.id });
      notify('已标为已读');
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

  const readAll = async () => {
    const unread = rows.filter((row) => !row.read_at);
    if (unread.length === 0) return;
    setBusyKey('read-all');
    setError('');
    try {
      for (const row of unread) {
        await command(api, 'inboxRead', { id: row.id });
      }
      notify('已全部已读');
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

  const undo = async (change: ChangeRecord, after?: () => void) => {
    const ok = await confirm({
      title: '撤回这次整理？',
      body: `将撤回整理记录「${change.id.slice(0, 8)}」中的 ${change.summary.changedObjects ?? 0} 项变更，相关记忆会恢复到整理前；之后的人工修改会保留。`,
      confirmLabel: '撤回',
    });
    if (!ok) return;
    setBusyKey(`undo:${change.id}`);
    setError('');
    try {
      await command(api, 'undo', { id: change.id });
      await refresh();
      onChange();
      after?.();
      notify('已撤回整理', {
        action: {
          label: '撤销撤回',
          run: async () => {
            await command(api, 'redo', { id: change.id });
            await refresh();
            onChange();
            notify('已恢复整理');
          },
        },
      });
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setBusyKey('');
    }
  };

  const redo = async (change: ChangeRecord) => {
    setBusyKey(`redo:${change.id}`);
    setError('');
    try {
      await command(api, 'redo', { id: change.id });
      await refresh();
      onChange();
      notify('已重做整理');
    } catch (errorValue) {
      const mapped = message(errorValue);
      setError(mapped);
      notify(mapped, { tone: 'error' });
    } finally {
      setBusyKey('');
    }
  };

  const allowMerge = async (change: ChangeRecord) => {
    setBusyKey(`merge:${change.id}`);
    try {
      await command(api, 'allowMerge', { id: change.id });
      notify('已允许再次归并');
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

  const notificationLabel = (type: string): string => {
    if (type === 'project.created') return '项目已创建';
    if (type === 'project.recognized') return '已关联项目';
    if (type === 'project.review-needed') return '项目待确认';
    if (type.includes('failed')) return '处理失败';
    if (type.startsWith('reminder')) return '到期提醒';
    if (type === 'maintenance.completed') return '整理完成';
    if (type.startsWith('task')) return '任务更新';
    if (type.startsWith('tool')) return '工具更新';
    return '内容已更新';
  };

  const groups = useMemo(() => {
    const result: Array<{ title: string; items: Notification[] }> = [];
    const today = dayString(timezone, 0);
    const yesterday = dayString(timezone, -1);
    for (const notification of rows) {
      const key = dayKeyOf(notification.created_at, timezone);
      const title = key === today ? '今天' : key === yesterday ? '昨天' : '更早';
      const group = result.find((item) => item.title === title);
      if (group) group.items.push(notification);
      else result.push({ title, items: [notification] });
    }
    return result;
  }, [rows, timezone]);

  const unreadCount = rows.filter((row) => !row.read_at).length;

  return (
    <>
      <div className="pa-toolbar">
        <h2>收件箱</h2>
        <button
          type="button"
          disabled={busyKey !== '' || unreadCount === 0}
          onClick={() => void readAll()}
        >
          {busyKey === 'read-all' ? '处理中…' : '全部已读'}
        </button>
        <button
          type="button"
          disabled={busyKey !== '' || maintenanceRunning}
          onClick={() => void runMaintenance()}
        >
          {maintenanceRunning || busyKey === 'maintain' ? '整理中…' : '立即整理'}
        </button>
      </div>
      <div className="pa-segments">
        <button
          type="button"
          className={view === 'notifications' ? 'pa-selected' : ''}
          onClick={() => setView('notifications')}
        >
          通知
        </button>
        <button
          type="button"
          className={view === 'changes' ? 'pa-selected' : ''}
          onClick={() => setView('changes')}
        >
          整理记录
        </button>
      </div>
      {error && <div className="pa-error" role="alert">{error}</div>}
      {view === 'changes' && (
        <div className="pa-records">
          {changes.length === 0 && (
            <EmptyState text="暂无整理记录" actionLabel="立即整理" onAction={() => void runMaintenance()} />
          )}
          {changes.map((change) => (
            <article className="pa-card" key={change.id}>
              <div className="pa-card-head">
                <strong>{change.summary.type ? '内容变更' : '记忆整理'}</strong>
                <span className="pa-tag">{LABELS[change.status] ?? change.status}</span>
              </div>
              <div className="pa-meta">
                {formatDate(change.createdAt, timezone)} · {change.summary.changedObjects ?? 0} 项
              </div>
              {change.status === 'applied' && (
                <div className="pa-meta">撤回截止 {formatDate(change.expiresAt, timezone)}</div>
              )}
              <footer>
                <button
                  type="button"
                  disabled={busyKey !== ''}
                  onClick={() => setDetailId(change.id)}
                >
                  查看
                </button>
                <button
                  type="button"
                  disabled={
                    busyKey !== '' ||
                    change.status !== 'applied' ||
                    Date.now() >= change.expiresAt
                  }
                  onClick={() => void undo(change)}
                >
                  {busyKey === `undo:${change.id}` ? '处理中…' : '撤回'}
                </button>
                {change.status.startsWith('undone') && (
                  <button
                    type="button"
                    disabled={busyKey !== ''}
                    onClick={() => void redo(change)}
                  >
                    {busyKey === `redo:${change.id}` ? '处理中…' : '重做'}
                  </button>
                )}
                {change.status.startsWith('undone') &&
                  (change.summary.pairs ?? []).length > 0 && (
                    <button
                      type="button"
                      disabled={busyKey !== ''}
                      onClick={() => void allowMerge(change)}
                    >
                      允许再次归并
                    </button>
                  )}
              </footer>
            </article>
          ))}
        </div>
      )}
      {view === 'notifications' && (
        <div className="pa-notifications">
          {rows.length === 0 && <EmptyState text="暂无通知" compact />}
          {groups.map((group) => (
            <section className="pa-notification-group" key={group.title}>
              <h3>{group.title}</h3>
              {group.items.map((notification) => {
                const payload = notification.payload;
                return (
                  <div className="pa-notification" key={notification.id}>
                    <span>{notificationLabel(notification.type)}</span>
                    <span className="pa-meta">
                      {formatDate(notification.created_at, timezone)}
                    </span>
                    {typeof payload.title === 'string' && (
                      <strong>{payload.title}</strong>
                    )}
                    {notification.type === 'maintenance.completed' && (
                      <span>
                        {payload.processed !== undefined
                          ? `${String(payload.processed)} 来源 · `
                          : ''}
                        {String(
                          payload.changes ??
                            (payload.summary as { changedObjects?: number } | undefined)
                              ?.changedObjects ??
                            payload.changedObjects ??
                            0,
                        )}{' '}
                        变更
                      </span>
                    )}
                    {notification.type.startsWith('project.') &&
                      Number(payload.linkedMemories ?? 0) > 0 && (
                        <span>{String(payload.linkedMemories)} 条历史经验</span>
                      )}
                    {notification.type.startsWith('project.') &&
                      typeof payload.changeId === 'string' && (
                        <>
                          <button
                            type="button"
                            onClick={() => setDetailId(payload.changeId as string)}
                          >
                            查看变更
                          </button>
                          <button
                            type="button"
                            disabled={
                              busyKey !== '' ||
                              notification.changeStatus !== 'applied' ||
                              Date.now() >= Number(payload.expiresAt ?? 0)
                            }
                            onClick={() =>
                              void undo(
                                {
                                  id: payload.changeId as string,
                                  createdAt: notification.created_at,
                                  expiresAt: Number(payload.expiresAt ?? 0),
                                  status: notification.changeStatus ?? '',
                                  summary: {
                                    type: 'project',
                                    changedObjects: Number(payload.linkedMemories ?? 0),
                                  },
                                },
                              )
                            }
                          >
                            撤回
                          </button>
                        </>
                      )}
                    {typeof payload.sessionId === 'string' && (
                      <button
                        type="button"
                        onClick={() => api('native.open', { sessionId: payload.sessionId })}
                      >
                        {notification.type.startsWith('project.') ? '打开对话' : '打开报告'}
                      </button>
                    )}
                    {typeof payload.error === 'string' && (
                      <span role="alert">{message(payload.error)}</span>
                    )}
                    {!notification.read_at && (
                      <button
                        type="button"
                        disabled={busyKey !== ''}
                        onClick={() => void readOne(notification)}
                      >
                        {busyKey === `read:${notification.id}` ? '处理中…' : '已读'}
                      </button>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
      {detailId && (
        <ChangeDetailsDialog
          api={api}
          changeId={detailId}
          onClose={() => setDetailId(null)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Today                                                               */
/* ------------------------------------------------------------------ */

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
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [memories, setMemories] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const quickInput = useRef<HTMLInputElement | null>(null);
  const notify = useToast();

  const load = useCallback(async () => {
    try {
      const bounds = dayBounds(timezone);
      const [taskList, eventList, inboxRows, memoryList] = await Promise.all([
        command<ListResult>(api, 'list', { kind: 'task', limit: 100 }),
        command<Row[]>(api, 'calendar', { from: bounds.start, to: bounds.end }),
        command<Notification[]>(api, 'inbox'),
        command<ListResult>(api, 'list', { kind: 'memory', limit: 5, sort: 'updated' }),
      ]);
      setTasks(taskList.items);
      setEvents(eventList);
      setNotifications(inboxRows);
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
  const unread = notifications.filter((row) => !row.read_at);

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

  const readAll = async () => {
    if (unread.length === 0) return;
    setBusyKey('read-all');
    setError('');
    try {
      for (const row of unread) {
        await command(api, 'inboxRead', { id: row.id });
      }
      notify('已全部已读');
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
            <h3>未读通知</h3>
            <button
              type="button"
              className="pa-text-button"
              disabled={busyKey !== '' || unread.length === 0}
              onClick={() => void readAll()}
            >
              {busyKey === 'read-all' ? '处理中…' : '全部已读'}
            </button>
          </header>
          {loading ? (
            <div className="pa-skeleton-line" />
          ) : unread.length === 0 ? (
            <EmptyState
              text="没有未读通知"
              actionLabel="打开收件箱"
              onAction={() => onNavigate('inbox')}
              compact
            />
          ) : (
            unread.slice(0, 3).map((row) => (
              <div className="pa-row" key={row.id}>
                <div className="pa-row-main">
                  <span>{typeof row.payload.title === 'string' ? row.payload.title : '更新'}</span>
                  <div className="pa-meta">{formatDate(row.created_at, timezone)}</div>
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

type NumericSetting =
  | 'retentionHours'
  | 'rawDays'
  | 'maintenanceHour'
  | 'maintenanceMaxItems'
  | 'maintenanceMaxSeconds'
  | 'contextCharacters'
  | 'rollbackMegabytes';

const SETTINGS_SECTIONS: Array<{ id: string; label: string }> = [
  { id: 'workspace', label: '助手工作区' },
  { id: 'memory', label: '记忆与维护' },
  { id: 'data', label: '数据与迁移' },
  { id: 'weixin', label: '微信' },
];

function Settings({
  api,
  onChange,
  onBack,
}: {
  api: Api;
  onChange: () => void;
  onBack: () => void;
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
    setSettings(nextSettings);
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

  const numberField = (key: NumericSetting, label: string) => (
    <Field label={label}>
      <input
        type="number"
        value={settings[key]}
        onChange={(event) =>
          setSettings({ ...settings, [key]: Number(event.target.value) })
        }
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
        {section === 'memory' && (
          <section className="pa-settings-card">
            <header>
              <h3>记忆与维护</h3>
              <label className="pa-switch">
                <input
                  aria-label="自动维护"
                  type="checkbox"
                  checked={settings.maintenanceEnabled}
                  onChange={(event) =>
                    setSettings({ ...settings, maintenanceEnabled: event.target.checked })
                  }
                />
                <span>自动维护</span>
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
                <Field label="每日整理时间">
                  <select
                    value={settings.maintenanceHour}
                    onChange={(event) =>
                      setSettings({ ...settings, maintenanceHour: Number(event.target.value) })
                    }
                  >
                    {Array.from({ length: 24 }, (_, hour) => (
                      <option key={hour} value={hour}>
                        {String(hour).padStart(2, '0')}:00
                      </option>
                    ))}
                  </select>
                </Field>
                {numberField('rawDays', '普通原文保留天数')}
                {numberField('retentionHours', '撤回小时数')}
              </div>
              <details className="pa-advanced">
                <summary>高级设置</summary>
                <div className="pa-grid2">
                  {numberField('maintenanceMaxItems', '每批最多条目')}
                  {numberField('maintenanceMaxSeconds', '每轮最多秒数')}
                  {numberField('contextCharacters', '召回字符预算')}
                  {numberField('rollbackMegabytes', '恢复资料空间（MB）')}
                </div>
              </details>
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
    },
  });
  const [error, setError] = useState('');
  const [createSignal, setCreateSignal] = useState(0);
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
    const onKey = (event: KeyboardEvent) => {
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
        setCreateSignal((value) => value + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const timezone = overview.settings.timezone || 'Asia/Shanghai';
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
            {item.id === 'inbox' && overview.unread > 0 && (
              <span className="pa-badge">{overview.unread}</span>
            )}
          </button>
        ))}
      </nav>
      <div className="pa-content">
        <div
          className="pa-page"
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
          {tab === 'memory' && (
            <Records key="memory" api={api} kind="memory" timezone={timezone} onChange={refresh} createSignal={createSignal} />
          )}
          {tab === 'project' && (
            <Records key="project" api={api} kind="project" timezone={timezone} onChange={refresh} createSignal={createSignal} />
          )}
          {tab === 'task' && (
            <Records key="task" api={api} kind="task" timezone={timezone} onChange={refresh} createSignal={createSignal} />
          )}
          {tab === 'tool' && (
            <Records key="tool" api={api} kind="tool" timezone={timezone} onChange={refresh} createSignal={createSignal} />
          )}
          {tab === 'calendar' && (
            <Calendar api={api} timezone={timezone} onChange={refresh} createSignal={createSignal} />
          )}
          {tab === 'inbox' && (
            <Inbox api={api} timezone={timezone} onChange={refresh} />
          )}
          {tab === 'settings' && (
            <Settings api={api} onChange={refresh} onBack={() => setTab('today')} />
          )}
        </div>
      </div>
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
    if (!result?.ok) throw new Error(result?.error?.message ?? '无法连接助手。');
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
