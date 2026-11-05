import type {Actor,Command} from '../domain/contracts.js';

/**
 * Typed view of the storage worker RPC surface.
 *
 * `StorageClient.call` is overloaded: methods listed here get their argument and
 * result shapes checked, while any other method name still compiles as `any`
 * (the worker exposes more commands than the host currently uses).
 */

export interface AssistantSettings {
 timezone:string;
 retentionHours:number;
 rawDays:number;
 maintenanceHour:number;
 maintenanceEnabled:boolean;
 maintenanceMaxItems:number;
 maintenanceMaxSeconds:number;
 contextCharacters:number;
 rollbackMegabytes:number;
 model:string;
 basePreset:string;
 workspace:string;
 reportEnabled:boolean;
 reportHour:number;
 snapshotDays:number;
 changeSummaryDays:number;
}

export interface SourceRecord {
 id:string;
 sessionId:string;
 role:'user'|'assistant'|'tool';
 text:string;
 projectEligible?:boolean;
 status?:'buffered'|'ordinary'|'pending';
 context?:{workspace:string;preset:string;origin:string};
}

export interface PendingSource {
 id:string;
 session_id:string;
 text:string;
}

export interface StoredRecord<T=any> {
 id:string;
 kind:string;
 revision:number;
 data:T;
}

export interface RecordPage {
 items:StoredRecord[];
 total:number;
}

export interface MemoryHit extends StoredRecord<{title:string;body:string;facts:unknown[];type:string}> {
 facts?:unknown[];
 originalClaims?:unknown[];
 observations?:unknown[];
}

export interface ProjectRef {id:string;revision:number;title:string;statement:string;context:Record<string,unknown>;status:string}

export interface ConversationRow {session_id:string;id?:string;title?:string}

export interface ConversationMessage {id:string;role:string;text:string}

export interface RunRow {id:string;status:string;session_id?:string}

export interface RunUpdate {
 id:string;
 status:'queued'|'running'|'succeeded'|'failed';
 sessionId?:string;
 result?:string;
}

export interface JobRow {id:string;runId:string;kind:string;nextAt:number}

export interface ToolRecord {
 id:string;
 version:string;
 definition:{
  title:string;
  kind:'workflow'|'script';
  steps:{tool:string;args:Record<string,unknown>}[];
 };
}

export interface ToolReviewRow {failures:number;executions:number}

export interface MaintenanceCommand {command:string;payload:any}

export interface MaintenanceResult {results:{changeId?:string}[]}

export interface ChangeItem {kind:string;objectId:string;title:string;action:string;detail:string}

export interface ChangeDetails {
 id:string;
 createdAt:number;
 summary:{type?:string;changedObjects?:number;title?:string;items?:ChangeItem[]};
 expiresAt:number;
 status:string;
 items:ChangeItem[];
 expiresDisplay:string;
}

export interface ReportItem {
 metadata?:Record<string,unknown>;
 kind:'memory'|'project'|'task'|'event'|'tool'|'run'|'wechat'|'maintenance'|string;
 objectId:string|null;
 action:string;
 title:string;
 detail:string;
 at:number;
}

export interface ReportSummary {
 memories:number;
 projects:number;
 tasks:number;
 events:number;
 tools:number;
 runs:number;
 wechat:number;
 maintenance:number;
}

export interface ReportWindowResult {from:number;to:number;summary:ReportSummary;items:ReportItem[]}

export interface ReportRow {
 id:string;
 windowFrom:number;
 windowTo:number;
 status:string;
 revision:number;
 conversationId:string|null;
 sessionId:string|null;
 messageId:string|null;
 snapshotId:string|null;
 body:string;
 summary:ReportSummary|Record<string,unknown>;
 createdAt:number;
 confirmedAt:number|null;
 pushedAt:number|null;
 counts:number;
}

export interface ReportDetail extends ReportRow {
 items:ReportItem[];
 revisions:{revision:number;body:string;createdAt:number}[];
}

export interface SnapshotRecord {id:string;path:string;bytes:number;sha256:string}

export interface HealthReport {integrity:string}

export interface ProjectContext {
 result:unknown;
 projects:ProjectRef[];
 source:{id:string;text:string};
 snapshot:string;
 anchor:unknown;
 binding:{sessionId:string;projectId:string|null;revision:number};
}

export interface StorageMethods {
 settingsGet:{args:Record<string,unknown>;result:AssistantSettings};
 command:{args:{command:Command|string;payload:any;actor:Actor;requestId:string};result:any};
 source:{args:SourceRecord;result:unknown};
 sourceReady:{args:{sessionId:string};result:unknown};
 sourceRecover:{args:{busy:string[]};result:unknown};
 pendingSources:{args:{limit:number};result:PendingSource[]};
 notify:{args:{id?:string;type:string;payload?:Record<string,unknown>};result:unknown};
 runCreate:{args:{requestId:string;taskId?:string;workflowVersion?:string};result:{id:string}};
 runGet:{args:{id:string};result:RunRow};
 runUpdate:{args:RunUpdate;result:unknown};
 runRecover:{args:Record<string,unknown>;result:unknown};
 conversationList:{args:Record<string,unknown>;result:ConversationRow[]};
 conversationMessages:{args:{sessionId:string};result:ConversationMessage[]};
 conversationSave:{args:{id:string;sessionId:string;title:string};result:unknown};
 conversationNeedsRebind:{args:{sessionId:string};result:boolean};
 conversationRebind:{args:{previous:string;sessionId:string};result:unknown};
 conversationInvalidateNative:{args:Record<string,unknown>;result:unknown};
 jobEnsure:{args:{id:string;kind:string;nextAt:number};result:unknown};
 jobReschedule:{args:{id:string;nextAt:number};result:unknown};
 jobScheduleNow:{args:{id:string};result:unknown};
 jobList:{args:Record<string,unknown>;result:JobRow[]};
 jobClaim:{args:{claimId:string;leaseMs:number};result:JobRow|null};
 jobFinish:{args:{id:string;runId:string;nextAt:number;error?:string};result:unknown};
 reminders:{args:Record<string,unknown>;result:unknown};
 purge:{args:Record<string,unknown>;result:unknown};
 maintenanceApply:{args:{commands:MaintenanceCommand[];sourceId?:string;requestId:string};result:MaintenanceResult};
 maintenanceStamp:{args:Record<string,unknown>;result:{changed:boolean;value:unknown;offset:number}};
 maintenanceProgress:{args:{offset:number};result:unknown};
 maintenanceDone:{args:{stamp:unknown};result:unknown};
 change:{args:{id:string};result:ChangeDetails};
 reportWindow:{args:{from?:number};result:ReportWindowResult};
 reportSave:{args:{from:number;to:number;summary:any;items:ReportItem[];conversationId?:string;sessionId?:string;messageId?:string;snapshotId?:string;body:string};result:{id:string;revision:number;status:string}};
 reportRevise:{args:{id:string;body:string;summary?:any;items?:ReportItem[]};result:{id:string;revision:number}};
 reportConfirm:{args:{id:string};result:ReportRow};
 reportList:{args:{offset?:number;limit?:number};result:{items:ReportRow[];total:number;offset:number}};
 reportGet:{args:{id:string};result:ReportDetail};
 snapshotTake:{args:Record<string,unknown>;result:SnapshotRecord};
 snapshotPrune:{args:{days?:number};result:{removed:number}};
 toolDefinition:{args:{id:string;sessionId?:string};result:ToolRecord};
 toolUsage:{args:{id:string;toolId:string;version:string;outcome:'succeeded'|'failed'};result:unknown};
 toolReview:{args:Record<string,unknown>;result:ToolReviewRow[]};
 workflowResult:{args:{sessionId:string;toolId:string;version:string};result:{outcome:string}|null};
 projectInspect:{args:{sourceId:string};result:ProjectContext};
 projectApply:{args:{sourceId:string;snapshot:unknown;plan:unknown;selections:unknown[];requestId:string};result:unknown};
 projectPreview:{args:{sourceId:string;snapshot:unknown;plan:unknown;selections:unknown[]};result:{result?:unknown;targets:{index:number;project:unknown;memories:unknown[];captured:unknown[]}[]}};
 projectPending:{args:{limit:number;busy:string[]};result:PendingSource[]};
 projectRetry:{args:{sourceId:string;error:string};result:unknown};
 export:{args:{destination:string};result:unknown};
 health:{args:Record<string,unknown>;result:HealthReport};
 vaultState:{args:Record<string,unknown>;result:unknown};
 vaultUnlock:{args:Record<string,unknown>;result:unknown};
 vaultGet:{args:{name:string};result:{name:string;value:string}|null};
 vaultLock:{args:Record<string,unknown>;result:unknown};
 close:{args:Record<string,unknown>;result:unknown};
}
