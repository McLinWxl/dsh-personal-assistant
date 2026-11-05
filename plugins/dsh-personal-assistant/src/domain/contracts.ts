import { z } from 'zod';

export const text = z.string().trim().min(1).max(10000);
export const id = z.string().min(1).max(180);
export const timestamp = z.iso.datetime({ offset: true });
export const fact = z.strictObject({ subject: text, predicate: text, value: text });
export const context = z.record(z.string().max(80), z.union([z.string().max(300), z.boolean(), z.number().finite()]));
export const version = z.strictObject({ id, revision: z.number().int().positive() });
export const labels = z.array(z.string().trim().min(1).max(80)).max(30);
export const settingsSchema = z.strictObject({
  timezone: z.string().refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }),
  retentionHours: z.number().int().min(1).max(720), rawDays: z.number().int().min(1).max(3650),
  maintenanceHour: z.number().int().min(0).max(23), maintenanceEnabled: z.boolean(),
  maintenanceMaxItems: z.number().int().min(1).max(500), maintenanceMaxSeconds: z.number().int().min(30).max(1800),
  contextCharacters: z.number().int().min(1000).max(32000), rollbackMegabytes: z.number().int().min(5).max(2048),
  reportEnabled: z.boolean().default(true), reportHour: z.number().int().min(0).max(23).default(7),
  snapshotDays: z.number().int().min(1).max(90).default(7), changeSummaryDays: z.number().int().min(1).max(365).default(90),
  model: z.string().max(160), basePreset: z.string().min(1).max(100), workspace: z.string().max(2000),
});
export const defaults = { timezone: 'Asia/Shanghai', retentionHours: 72, rawDays: 90, maintenanceHour: 3,
  maintenanceEnabled: true, maintenanceMaxItems: 80, maintenanceMaxSeconds: 180, contextCharacters: 12000,
  rollbackMegabytes: 100, reportEnabled: true, reportHour: 7, snapshotDays: 7, changeSummaryDays: 90,
  model: '', basePreset: 'default', workspace: '' };
export type Settings = z.infer<typeof settingsSchema>;

export const projectSchema = z.strictObject({ title: text, statement: z.string().max(10000).default(''),
  domains: labels.default([]), topics: labels.default([]), context: context.default({}),
  status: z.enum(['active', 'paused', 'completed', 'archived']).default('active') });
export const projectKey = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/);
export const projectEvidence = z.strictObject({
  basis: z.enum(['explicit', 'sustained']),
  sources: z.array(z.strictObject({ sourceId: id, quote: text })).min(1).max(10),
});
export const projectReason = {
  reason: z.string().max(2000).default(''),
  confidence: z.number().min(0).max(1).default(1),
};
export const projectOperations = ['projectCreate', 'projectEdit', 'projectRename', 'projectMove',
  'projectMerge', 'projectSplit', 'projectArchive', 'projectRestore', 'projectRemove',
  'projectAttach', 'projectDetach', 'projectAlias', 'projectBind'] as const;
export const projectCreateSchema = projectSchema.extend({
  key: projectKey.optional(), parent: version.nullable().default(null),
  evidence: projectEvidence.optional(), ...projectReason,
});
export const memorySchema = z.strictObject({ title: text, body: text, notes:z.string().max(10000).default(''),
  type: z.enum(['fact','method','episode','preference','decision','goal']),
  facts: z.array(fact).min(1).max(40),
  sourceId: id, quote: text, projectId: id.optional(),
  occurredAt: timestamp, timePrecision: z.enum(['instant','day','month','year','approximate']).default('instant'),
  domains: labels.default([]), topics: labels.default([]), requirements: context.default({}),
  validFrom: timestamp.nullable().default(null), validTo: timestamp.nullable().default(null),
  importance: z.number().int().min(1).max(5).default(3), reusable: z.boolean().describe('仅 method 和 fact 可为 true；其他类别保存为 false。'),
  visibility: z.enum(['personal','private']).default('personal'), pinned: z.boolean().default(false),
});
export const taskSchema = z.strictObject({ title: text, description: z.string().max(20000).default(''),
  projectId: id.nullable().default(null), domains: labels.default([]), dueAt: timestamp.nullable().default(null),
  importance: z.number().int().min(1).max(5).default(3),
  status: z.enum(['todo','scheduled','running','needs-review','completed','cancelled','failed']).default('todo'),
  dependsOn: z.array(id).max(30).default([]), result: z.string().max(20000).default(''),
});
export const eventSchema = z.strictObject({ title: text, projectId: id.nullable().default(null),
  taskId: id.nullable().default(null), domains: labels.default([]),
  start: z.string().min(10).max(45), end: z.string().min(10).max(45), timezone: settingsSchema.shape.timezone,
  allDay: z.boolean().default(false), importance: z.number().int().min(1).max(5).default(3),
  recurrence: z.string().max(500).default(''), location: z.string().max(1000).default(''),
  description: z.string().max(20000).default(''),
});
export const workflowSchema = z.strictObject({ title: text, description: z.string().max(5000).default(''),
  kind: z.enum(['workflow','script']), steps: z.array(z.strictObject({ tool: id, args: z.record(z.string(),z.json()) })).max(30).default([]),
  source: z.string().max(100000).default(''), language: z.enum(['javascript','python','shell']).default('javascript'),
  capabilities: z.array(z.enum(['read-files','write-files','network','process'])).default([]),
  parameters: z.record(z.string(),z.json()).default({}),
});
// Zod 4 applies nested defaults even inside optional fields. Patch inputs must
// preserve omission, so remove creation defaults before making fields optional.
function patchSchema(schema:z.ZodObject<any>){return z.strictObject(Object.fromEntries(Object.entries(schema.shape).map(([key,value])=>{let field=value as z.ZodType;while(field instanceof z.ZodDefault)field=field.unwrap() as z.ZodType;return[key,field.optional()];})));}
export const schemas = {
  overview: z.strictObject({}), list: z.strictObject({ kind: z.enum(['memory','project','task','event','tool','entity']), query: z.string().max(500).default(''), projectId: id.optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(40), sort: z.enum(['updated','created','title']).default('updated') }),
  searchAll: z.strictObject({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(50).default(20) }),
  get: z.strictObject({ id }), relations:z.strictObject({id}), settingsGet: z.strictObject({}), settingsSave: patchSchema(settingsSchema),
  projectCreate: projectCreateSchema,
  projectEdit: version.extend({ patch: patchSchema(projectSchema), ...projectReason }),
  projectTree: z.strictObject({ rootId: id.optional(), includeArchived: z.boolean().default(true) }),
  projectRename: version.extend({ title: text, ...projectReason }),
  projectMove: version.extend({ parent: version.nullable(), ...projectReason }),
  projectMerge: z.strictObject({ source: version, target: version, ...projectReason }),
  projectSplit: version.extend({
    parts: z.array(z.strictObject({
      project: projectSchema, key: projectKey.optional(),
      objects: z.array(version).max(500).default([]),
      children: z.array(version).max(100).default([]),
    })).min(2).max(20), ...projectReason,
  }),
  projectArchive: version.extend({ ...projectReason }),
  projectRestore: version.extend({ status: z.enum(['active','paused','completed']).default('active'), ...projectReason }),
  projectAttach: z.strictObject({ object: version, project: version, role: z.enum(['contains','applies_to']).default('contains'), ...projectReason }),
  projectDetach: z.strictObject({ object: version, project: version, role: z.enum(['contains','applies_to']).default('contains'), ...projectReason }),
  projectAlias: version.extend({ alias: text, action: z.enum(['add','remove']), ...projectReason }),
  projectBind: z.strictObject({ sessionId: id.optional(), project: version.nullable(), expectedRevision: z.number().int().nonnegative(), ...projectReason }),
  projectBinding: z.strictObject({ sessionId: id.optional() }),
  projectPreview: z.strictObject({ operation: z.enum(projectOperations), payload: z.record(z.string(), z.json()) }),
  projectDecisions: z.strictObject({ status: z.enum(['unresolved','failed','applied']).optional(), limit: z.number().int().min(1).max(100).default(40) }),
  memoryCapture: memorySchema,
  memoryRefresh:z.strictObject({id,revision:z.number().int(),facts:z.array(fact).min(1).max(40),domains:labels,topics:labels}),
  memoryClassify:z.strictObject({id,revision:z.number().int(),domains:labels,topics:labels,reusable:z.boolean().optional()}),
  memoryPrune:z.strictObject({id,revision:z.number().int(),reason:z.enum(['expired','old-low-value'])}),
  memoryEdit: z.strictObject({ id, revision: z.number().int(), patch: z.strictObject({ title:text.optional(), body:text.optional(), notes:z.string().max(10000).optional(), pinned:z.boolean().optional(), importance:z.number().int().min(1).max(5).optional(), domains:labels.optional(), topics:labels.optional(), visibility:z.enum(['personal','private']).optional(), projectId:z.string().nullable().optional() }) }),
  memorySearch: z.strictObject({ query:text, projectId:id.optional(), purpose:z.enum(['personal','external']).default('personal'), limit:z.number().int().min(1).max(30).default(12) }),
  related: z.strictObject({ projectId:id }), associate: z.strictObject({ projectId:id, memories:z.array(version).max(30) }),
  consolidate: z.strictObject({ groups:z.array(z.strictObject({ memories:z.array(version).min(2).max(20), canonicalFacts:z.array(fact).min(1).max(50) })).max(20) }),
  maintain: z.strictObject({}), changes: z.strictObject({ offset:z.number().int().nonnegative().default(0) }), change: z.strictObject({ id }),
  reportWindow: z.strictObject({ from: z.number().int().optional() }),
  reportSave: z.strictObject({ from: z.number().int(), to: z.number().int(), summary: z.any(), items: z.array(z.any()), conversationId: z.string().optional(), sessionId: z.string().optional(), messageId: z.string().optional(), snapshotId: z.string().optional(), body: z.string() }),
  reportRevise: z.strictObject({ id: z.string(), body: z.string(), summary: z.any().optional(), items: z.array(z.any()).optional() }),
  reportConfirm: z.strictObject({ id: z.string() }),
  reportList: z.strictObject({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) }),
  reportGet: z.strictObject({ id: z.string() }),
  snapshotTake: z.strictObject({}),
  snapshotPrune: z.strictObject({ days: z.number().int().min(1).max(90).optional() }),
  remove: z.strictObject({ id, revision:z.number().int() }),
  memoryRemove:z.strictObject({id,revision:z.number().int()}),
  projectRemove:version.extend({ ...projectReason }),
  taskCreate:taskSchema, taskEdit:z.strictObject({id,revision:z.number().int(),patch:patchSchema(taskSchema)}),
  eventOverride:z.strictObject({id,revision:z.number().int(),occurrence:z.string().min(10).max(45),cancelled:z.boolean().default(false),patch:patchSchema(eventSchema).default({})}),
  eventCreate:eventSchema, eventEdit:z.strictObject({id,revision:z.number().int(),patch:patchSchema(eventSchema)}),
  calendar:z.strictObject({from:timestamp,to:timestamp}), icsImport:z.strictObject({content:z.string().min(1).max(2000000),timezone:settingsSchema.shape.timezone}), icsExport:z.strictObject({ids:z.array(id).max(500).optional()}),
  inbox:z.strictObject({offset:z.number().int().nonnegative().default(0)}), inboxRead:z.strictObject({id}),
  toolSave: z.strictObject({id:id.optional(),revision:z.number().int().optional(),projectId:id.nullable().optional(),definition:workflowSchema}),
  toolActivate:z.strictObject({id,revision:z.number().int(),version:id}), toolVersions:z.strictObject({id}),
  sourceReview:z.strictObject({sourceId:id,reason:z.enum(['captured','ordinary','temporary'])}),
  entitySave:z.strictObject({id:id.optional(),revision:z.number().int().optional(),name:text,type:z.enum(['person','place','organization','item','topic']),aliases:labels.default([]),domains:labels.default([])}),
  link:z.strictObject({from:id,to:id,kind:z.enum(['about','related_to'])}),
  capabilityGapReport: z.strictObject({ kind: z.enum(['unavailable','prerequisite','reported']), target: id, context: text, code: id.optional() }),
  capabilityGaps: z.strictObject({ status: z.enum(['open','planned','resolved','dismissed']).optional(), limit: z.number().int().min(1).max(100).default(40) }),
  capabilityGapUpdate: z.strictObject({ id, revision: z.number().int().positive(), status: z.enum(['planned','resolved','dismissed']), resolution: text, toolId: id.optional() }),
  capabilityProposal: z.strictObject({ gapIds: z.array(id).min(1).max(30), kind: z.enum(['registration','workflow','implementation']), title: text, plan: text, toolId: id.optional() }),
  capabilityCatalog: z.strictObject({}),
};
export type Command = keyof typeof schemas;
export type Actor = { kind:'ui'|'model'|'maintenance'|'system'; sourceId?:string; sessionId?:string; allowedSourceIds?:string[] };
export function validate(command:string, payload:unknown) {
  if (!Object.hasOwn(schemas,command)) throw new Error('UNKNOWN_COMMAND');
  return (schemas[command as Command] as z.ZodType).parse(payload);
}
export function formattedDeadline(ms:number, timezone:string) {
  return new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'short'}).format(new Date(ms));
}
