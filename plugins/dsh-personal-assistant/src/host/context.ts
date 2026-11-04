import type {Actor} from '../domain/contracts.js';

/**
 * The slice of the DSH host this plugin actually relies on.
 *
 * These interfaces are structural: they document the contract instead of
 * importing @deepseek-ai/dsh-* runtime types, which are provided by the host
 * at runtime and are not installable from the registry. Widen a member here
 * (and only here) when a new host API is used, rather than falling back to
 * `any` at the call site.
 */

export interface FetchRoute {
 path:string;
 methods:string[];
 requestBody:'buffered';
 fetch(request:Request):Promise<Response>;
}

export interface Logger {
 warn?(message:string):void;
 info?(message:string):void;
 error?(message:string):void;
}

/** Message shape shared by user/assistant/tool events. */
export interface SessionMessage {
 id?:string;
 content?:{type:string;text?:string}[];
 source?:{kind?:string;rpcId?:string};
}

export interface SessionEvent {
 type:string;
 data:any;
}

export interface SessionHeader {
 origin?:string;
 agentPreset?:string;
 cwd?:string;
 workspaceId?:string;
}

export interface OwnerSession {
 id:string;
 header:SessionHeader;
 snapshotEvents():SessionEvent[];
 events?:SessionEvent[];
}

export interface AgentHandle {
 id:string;
 status:string;
 session:OwnerSession;
 cancel(reason:{kind:string},options?:{keepInbox?:boolean}):void;
 whenIdle():Promise<void>;
 followup(message:unknown):void;
}

export interface SessionController {
 create(input:{workspaceId:string;agentPreset:string}):Promise<{sessionId:string}>;
 rename(input:{sessionId:string;title:string}):Promise<unknown>;
 selectModel(input:{sessionId:string;provider:string;model:string}):Promise<unknown>;
 prompt(input:{sessionId:string;requestId:string;content:{type:'text';text:string}[];clientTimeZone:string},signal:AbortSignal):Promise<unknown>;
}

export interface WorkspaceRecord {id:string;path:string}

export interface WorkspaceRegistry {
 create(cwd:string,name:string):Promise<WorkspaceRecord>;
}

export interface PresetSummary {id:string;name?:string}

export interface AgentPresets {
 defaultId:string;
 list():Promise<PresetSummary[]>;
 readDocument(id:string):Promise<{content:string}>;
 register(input:{id:string;name:string;order:number;plugins:unknown[]}):Promise<()=>unknown>;
 resolve(id:string):Promise<{broken?:string}>;
}

export interface ModelSelection {provider?:string;model?:string}

export interface LlmCall {
 config:Record<string,unknown>;
 stream(options:Record<string,unknown>):AsyncIterable<unknown>;
}

export interface LlmService {
 listProviders():{id:string;name?:string}[];
 listModels(providerId:string):Promise<{id:string;name:string}[]>;
 prepareCall(
  config:Record<string,unknown>,
  signal:AbortSignal,
  transform:(controls:unknown,model:any)=>Record<string,unknown>,
 ):Promise<LlmCall>;
}

export interface ToolExecutionInput {
 callId:string;
 rootCallId?:string;
 name:string;
 arguments:any;
 agent:AgentHandle;
 parent?:symbol;
 signal:AbortSignal;
}

export interface ToolExecutionResult {isError:boolean;value?:unknown;error?:{code?:string}}

export interface ToolRegistry {
 register(tool:unknown):void;
 get(name:string,agent?:AgentHandle):unknown;
 execute(input:ToolExecutionInput):Promise<ToolExecutionResult>;
}

/** Minimal storage surface the assistant tools and channel need. */
export interface StorageCaller {
 call(method:string,args?:any):Promise<any>;
}

/**
 * The service instance published as `personalAssistant`. Only the members that
 * other host modules (agent tools, WeChat channel, scheduler) consume appear
 * here; AssistantService implements them.
 */
export interface PersonalAssistantApi {
 assistantWorkspacePath:string;
 workflowRuns:Map<string,{id:string;version:string}>;
 storage:StorageCaller;
 channel:{sendFile(sessionId:string,path:string,cwd:string,callId:string):Promise<unknown>};
 isReport(agent:AgentHandle|undefined):boolean;
 currentSource(agent:AgentHandle):Promise<{id:string;text?:string}|null>;
 turnSources(agent:AgentHandle):Promise<{id:string;role:string;text:string}[]>;
 prepareContext(agent:AgentHandle,reviewOnly:boolean):Promise<string>;
 command(command:string,payload:any,actor?:Actor,requestId?:string):Promise<any>;
 projects:{resolve(sourceId:string,projectId:string|undefined,signal:AbortSignal):Promise<unknown>};
}

export interface PluginContext {
 personalAssistant:PersonalAssistantApi;
 logger?:Logger;
 sessionController:SessionController;
 agentPresets:AgentPresets;
 agents:{get(sessionId:string):AgentHandle|undefined;list():AgentHandle[]};
 llm:LlmService;
 agentDefaultModel:{currentSelection():ModelSelection};
 workspaceRegistry:WorkspaceRegistry;
 tools:ToolRegistry;
 systemPrompt:unknown;
 provide(name:string,value:unknown):void;
 plugin(plugin:unknown):void;
 effect(effect:()=>()=>unknown,label?:string):void;
 on(event:string,listener:(...args:any[])=>any):()=>void;
 connection:{fetch:{register(route:FetchRoute):()=>void}};
}

export interface PluginConfig {dataRoot:string}
