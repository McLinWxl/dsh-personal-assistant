// Structural contracts for the DSH APIs this plugin consumes.
// The real @deepseek-ai/dsh-tools / dsh-llm / cordis-plugin-include packages ship
// inside the DSH runtime and are not installed as type dependencies here, so this
// file is the single place that describes our side of the host boundary. Keep each
// member limited to what the plugin actually calls; everything else stays unknown.
declare module '@deepseek-ai/dsh-tools' {
 export interface ToolRenderPart {type:'text';text:string}
 export interface ToolDefinition {
  name:string;
  description:string;
  parameters:Record<string,unknown>;
  output?:{schema?:unknown;render?(args:unknown,value:unknown):ToolRenderPart[]};
  execute(args:any,execution:any):unknown;
 }
 export function defineTool(definition:ToolDefinition):unknown;
}

declare module '@deepseek-ai/dsh-llm' {
 export interface LlmContentBlock {type:'text';text:string}
 export interface LlmUserMessage {content:LlmContentBlock[];source:{kind:string}}
 export function createUserMessage(message:LlmUserMessage):unknown;
 export interface LlmFinish {kind:string;failure?:{code?:string}}
 export interface LlmBlock {type:string;text?:string}
 export class BlockAssembler {
  push(chunk:unknown):void;
  readonly finish?:LlmFinish;
  blocks():LlmBlock[];
 }
}

// Unused by the current source but kept so the import site stays typed if it returns.
declare module '@deepseek-ai/cordis-plugin-include' {
 export const entryListSchema:unknown;
}

declare module '*.css' {const content:string;export default content;}
