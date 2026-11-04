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
  model: z.string().max(160), basePreset: z.string().min(1).max(100), workspace: z.string().max(2000),
});
export const defaults = { timezone: 'Asia/Shanghai', retentionHours: 72, rawDays: 90, maintenanceHour: 3,
  maintenanceEnabled: true, maintenanceMaxItems: 80, maintenanceMaxSeconds: 180, contextCharacters: 12000,
  rollbackMegabytes: 100, model: '', basePreset: 'default', workspace: '' };
export type Settings = z.infer<typeof settingsSchema>;

export const projectSchema = z.strictObject({ title: text, goal: z.string().max(10000).default(''),
  domains: labels.default([]), topics: labels.default([]), context: context.default({}),
  status: z.enum(['active', 'paused', 'completed', 'archived']).default('active') });
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
  overview: z.strictObject({}), list: z.strictObject({ kind: z.enum(['memory','project','task','event','tool','entity']), query: z.string().max(500).default(''), projectId: id.optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(40) }),
  get: z.strictObject({ id }), relations:z.strictObject({id}), settingsGet: z.strictObject({}), settingsSave: patchSchema(settingsSchema),
  projectCreate: projectSchema, projectEdit: z.strictObject({ id, revision: z.number().int(), patch: patchSchema(projectSchema) }),
  memoryCapture: memorySchema,
  memoryRefresh:z.strictObject({id,revision:z.number().int(),facts:z.array(fact).min(1).max(40),domains:labels,topics:labels}),
  memoryClassify:z.strictObject({id,revision:z.number().int(),domains:labels,topics:labels,reusable:z.boolean().optional()}),
  memoryPrune:z.strictObject({id,revision:z.number().int(),reason:z.enum(['expired','old-low-value'])}),
  memoryEdit: z.strictObject({ id, revision: z.number().int(), patch: z.strictObject({ title:text.optional(), body:text.optional(), notes:z.string().max(10000).optional(), pinned:z.boolean().optional(), importance:z.number().int().min(1).max(5).optional(), domains:labels.optional(), topics:labels.optional(), visibility:z.enum(['personal','private']).optional() }) }),
  memorySearch: z.strictObject({ query:text, projectId:id.optional(), purpose:z.enum(['personal','external']).default('personal'), limit:z.number().int().min(1).max(30).default(12) }),
  related: z.strictObject({ projectId:id }), associate: z.strictObject({ projectId:id, memories:z.array(version).max(30) }),
  consolidate: z.strictObject({ groups:z.array(z.strictObject({ memories:z.array(version).min(2).max(20), canonicalFacts:z.array(fact).min(1).max(50) })).max(20) }),
  maintain: z.strictObject({}), changes: z.strictObject({ offset:z.number().int().nonnegative().default(0) }), change: z.strictObject({ id }), undo:z.strictObject({ id }),
  remove: z.strictObject({ id, revision:z.number().int() }),
  memoryRemove:z.strictObject({id,revision:z.number().int()}),allowMerge:z.strictObject({id}),
  taskCreate:taskSchema, taskEdit:z.strictObject({id,revision:z.number().int(),patch:patchSchema(taskSchema)}),
  eventOverride:z.strictObject({id,revision:z.number().int(),occurrence:z.string().min(10).max(45),cancelled:z.boolean().default(false),patch:patchSchema(eventSchema).default({})}),
  eventCreate:eventSchema, eventEdit:z.strictObject({id,revision:z.number().int(),patch:patchSchema(eventSchema)}),
  calendar:z.strictObject({from:timestamp,to:timestamp}), icsImport:z.strictObject({content:z.string().min(1).max(2000000),timezone:settingsSchema.shape.timezone}), icsExport:z.strictObject({ids:z.array(id).max(500).optional()}),
  inbox:z.strictObject({offset:z.number().int().nonnegative().default(0)}), inboxRead:z.strictObject({id}),
  toolSave: z.strictObject({id:id.optional(),revision:z.number().int().optional(),definition:workflowSchema}),
  toolActivate:z.strictObject({id,revision:z.number().int(),version:id}), toolVersions:z.strictObject({id}),
  sourceReview:z.strictObject({sourceId:id,reason:z.enum(['captured','ordinary','temporary'])}),
  entitySave:z.strictObject({id:id.optional(),revision:z.number().int().optional(),name:text,type:z.enum(['person','place','organization','item','topic']),aliases:labels.default([]),domains:labels.default([])}),
  link:z.strictObject({from:id,to:id,kind:z.enum(['about','belongs_to','reuses_method','related_to'])}),
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
