import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {projectDecision, projectSelection, projectPrompt, experiencePrompt} from '../domain/projects.js';
import type {AssistantService} from './service.js';

export class ProjectLifecycle {
  private active=new Map<string,Promise<any>>();
  constructor(private service:AssistantService) {}
  get running(){return this.active.size>0;}
  async model<T extends z.ZodType>(schema:T,prompt:string,input:any,deadline:number,signal?:AbortSignal):Promise<z.output<T>>{return schema.parse(await this.service.projectModel(schema,prompt,input,deadline,signal));}
  resolve(sourceId:string,deadline=Date.now()+180000,signal?:AbortSignal,trigger:'conversation'|'background'='conversation') {
    if(this.service.acceptingProjects===false)throw new Error('ASSISTANT_RELOADING');
    const existing=this.active.get(sourceId);if(existing)return existing;
    const promise=this.run(sourceId,deadline,signal,trigger).finally(()=>this.active.delete(sourceId));this.active.set(sourceId,promise);return promise;
  }
  private async run(sourceId:string,deadline:number,signal:AbortSignal|undefined,trigger:'conversation'|'background') {
    let validationError:string|undefined,previousPlan:any;
    for(let attempt=0;attempt<3;attempt++) {
      signal?.throwIfAborted();this.service.shutdownSignal.throwIfAborted();
      const context=await this.service.storage.call('projectInspect',{sourceId});if(context.result)return context.result;
      if(context.source.text.length>100000) {
        return this.service.storage.call('projectApply',{sourceId,snapshot:context.snapshot,plan:{decision:'review',basis:'unclear',quote:context.source.text.slice(0,100)},memories:[],requestId:randomUUID()});
      }
      try {
        const plan=await this.model(projectDecision,projectPrompt,{now:new Date().toISOString(),trigger,...context,previousPlan,validationError},deadline,signal);previousPlan=plan;
        if(trigger==='background'&&plan.decision==='defer')throw new Error('PROJECT_DECISION_INVALID');
        const input={sourceId,snapshot:context.snapshot,plan,memories:[]};
        const preview=await this.service.storage.call('projectPreview',input);if(preview.result)return preview.result;
        const selection=preview.memories.length||preview.captured.length?await this.model(projectSelection,experiencePrompt,{project:preview.project,memories:preview.memories,captured:preview.captured},deadline,signal):{memories:[],captured:[]};
        signal?.throwIfAborted();this.service.shutdownSignal.throwIfAborted();
        return await this.service.storage.call('projectApply',{...input,...selection,requestId:randomUUID()});
      } catch(error:any) {
        validationError=error.message;
        if(signal?.aborted||this.service.shutdownSignal.aborted||Date.now()+1000>=deadline)throw error;
        if(attempt===2) {
          if(/PROJECT_MATCH_|PROJECT_CONTEXT_|PROJECT_COMMITMENT_|PROJECT_DECISION_/.test(validationError!)) {
            const latest=await this.service.storage.call('projectInspect',{sourceId});
            return this.service.storage.call('projectApply',{sourceId,snapshot:latest.snapshot,plan:{decision:'review',basis:'unclear',quote:latest.source.text.slice(0,100)},memories:[],requestId:randomUUID()});
          }
          throw error;
        }
      }
    }
  }
  async drain(deadline:number,busy:string[],limit:number) {
    let processed=0;
    for(const source of await this.service.storage.call('projectPending',{limit,busy})) {
      if(busy.includes(source.session_id))continue;if(deadline-Date.now()<15000)break;
      try{await this.resolve(source.id,deadline,undefined,'background');processed++;}
      catch(error:any){if(this.service.shutdownSignal.aborted)throw error;await this.service.storage.call('projectRetry',{sourceId:source.id,error:error.message});}
    }
    return processed;
  }
  async settled(){await Promise.allSettled(this.active.values());}
}
