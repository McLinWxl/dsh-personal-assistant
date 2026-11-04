// The slice of the DSH plugin context this entry point relies on. AssistantService
// and the other collaborators still accept the context structurally; widen here
// first when a new host API is used rather than falling back to `any`.
export interface FetchRoute {
 path:string;
 methods:string[];
 requestBody:'buffered';
 fetch(request:Request):Promise<Response>;
}

export interface PluginContext {
 provide(name:string,value:unknown):void;
 plugin(plugin:unknown):void;
 effect(effect:()=>()=>unknown,label?:string):void;
 on(event:string,listener:(...args:any[])=>any):unknown;
 agentPresets:{list():Promise<unknown[]>};
 connection:{fetch:{register(route:FetchRoute):()=>void}};
}

export interface PluginConfig {dataRoot:string}
