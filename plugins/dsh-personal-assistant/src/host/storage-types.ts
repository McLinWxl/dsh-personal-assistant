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

export interface ProjectRef {id:string;revision:number;title:string;goal:string;context:Record<string,unknown>;status:string}

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

export interface ChangeItem {before?:{data:any}|null;after?:{data:any}|null}

export interface ChangeDetails {
 id:string;
 summary:{type?:string;changedObjects?:number};
 expiresAt:number;
 items:ChangeItem[];
}

export interface HealthReport {integrity:string}

export interface ProjectContext {
 result:ProjectRef|null;
 projects:ProjectRef[];
 source:{id:string;text:string};
 snapshot:unknown;
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
 toolDefinition:{args:{id:string;sessionId?:string};result:ToolRecord};
 toolUsage:{args:{id:string;toolId:string;version:string;outcome:'succeeded'|'failed'};result:unknown};
 toolReview:{args:Record<string,unknown>;result:ToolReviewRow[]};
 workflowResult:{args:{sessionId:string;toolId:string;version:string};result:{outcome:string}|null};
 projectInspect:{args:{sourceId:string};result:ProjectContext};
 projectApply:{args:{sourceId:string;snapshot:unknown;plan:unknown;memories:unknown[];captured?:unknown[];requestId:string};result:ProjectRef|null};
 projectPreview:{args:{sourceId:string;snapshot:unknown;plan:unknown;memories:unknown[]};result:{result:ProjectRef|null;project:ProjectRef;memories:unknown[];captured:unknown[]}};
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
