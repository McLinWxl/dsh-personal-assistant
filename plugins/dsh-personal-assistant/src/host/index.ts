import z from '@deepseek-ai/schemastery';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {AssistantService} from './service.js';
import {WeixinChannel} from '../channels/weixin.js';
import * as globalAgent from './agent.js';
import {Scheduler} from './scheduler.js';
import {atomicJson} from '../storage/files.js';
import {settingsOptions} from './settings.js';
import type {PluginContext,PluginConfig} from './context.js';
export const name='personal-assistant';
export const inject=['connection','sessionController','agentPresets','agents','llm','agentDefaultModel','workspaceRegistry','tools','systemPrompt'];
export const Config=z.object({dataRoot:z.string().default('')});
export async function apply(ctx:PluginContext,config:PluginConfig){
 const home=process.env.DSH_HOME||join(homedir(),'.dsh'),locator=join(home,'personal-assistant.json');
 let stored;try{stored=existsSync(locator)?JSON.parse(readFileSync(locator,'utf8')).root:undefined;}catch{}
 const root=stored||config.dataRoot||join(homedir(),'Documents','DSH Assistant');
 const service=new AssistantService(ctx,root,async path=>{mkdirSync(home,{recursive:true});atomicJson(locator,{root:path});});
 await service.start();ctx.provide('personalAssistant',service);ctx.plugin(globalAgent);
 const scheduler=new Scheduler(service);await scheduler.start();const weixin=new WeixinChannel(service);service.channel=weixin;await weixin.start();
 const endpoint='personal-assistant';
 const handler=async(method:string,payload:any)=>{
  switch(method){
   case'command':{const result=await service.command(payload.command,payload.payload,{kind:'ui'},payload.requestId);if(payload.command==='settingsSave')await scheduler.reconfigure();return result;}
   case'memory.manual':{const sourceId='manual:'+crypto.randomUUID();const {title,body,type,projectId,...extra}=payload;await service.storage.call('source',{id:sourceId,sessionId:'manual',role:'user' as const,text:body});return service.command('memoryCapture',{title,body,type,projectId,notes:extra.notes??'',domains:extra.domains??[],importance:extra.importance??3,pinned:extra.pinned??false,reusable:extra.reusable??false,facts:[{subject:title,predicate:'内容',value:body}],sourceId,quote:body,occurredAt:new Date().toISOString()},{kind:'ui'});}
   case'task.run':return service.run(payload);
   case'runs':return service.storage.call('runList');
   case'report.generate':return service.generateReport({trigger:'manual'});
   case'maintenance.run':await service.storage.call('jobScheduleNow',{id:'memory-daily'});return{scheduled:true};
   case'jobs':return service.storage.call('jobList');
   case'data.export':await scheduler.stop();try{return await service.exportData(payload.destination);}finally{await scheduler.start();}
   case'data.select':await weixin.stop();await scheduler.stop();try{const result=await service.switchRoot(payload.root);await scheduler.start();await weixin.start();return result;}catch(e){await scheduler.start();await weixin.start();throw e;}
   case'settings.options':return settingsOptions(ctx,service.root);
   case'data.exportDestination':{if(typeof payload.parent!=='string'||!payload.parent)throw new Error('ABSOLUTE_EXPORT_PATH_REQUIRED');return join(payload.parent,(await settingsOptions(ctx,service.root)).exportName);}
   case'weixin.status':return weixin.status();
   case'weixin.begin':return weixin.begin();
   case'weixin.poll':return weixin.poll(payload.attemptId,payload.verifyCode);
   case'weixin.disconnect':return weixin.disconnect();
   case'vault.state':return service.storage.call('vaultState');
   case'vault.unlock':{await service.storage.call('vaultUnlock',payload);try{const binding=await service.storage.call('vaultGet',{name:'weixin'});if(binding)await weixin.importLegacy(binding);return{imported:!!binding};}finally{await service.storage.call('vaultLock');}}
   case'vault.lock':await weixin.stop();return service.storage.call('vaultLock');
   case'health':return service.storage.call('health');
   case'presets':return ctx.agentPresets.list();
   default:throw new Error('UNKNOWN_ASSISTANT_METHOD');
  }
 };
 const off=ctx.connection.fetch.register({path:'/api/'+endpoint,methods:['POST'],requestBody:'buffered',async fetch(request:Request){
  if(request.method!=='POST')return new Response(null,{status:405});
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return new Response(null,{status:415});
  const text=await request.text();if(text.length>2500000)return new Response(null,{status:413});let message;
  try{message=JSON.parse(text);}catch{return new Response(null,{status:400});}
  if(message?.type!=='client-request'||message.method!==endpoint||typeof message.rpcId!=='string'||typeof message.payload?.method!=='string')return new Response(null,{status:400});
  let result;try{result={ok:true,value:await handler(message.payload.method,message.payload.payload??{})};}catch(e:any){result={ok:false,error:{code:e.code??'assistant/operation-failed',message:e.message,details:e.issues??{}}};}
  return Response.json({type:'server-response',rpcId:message.rpcId,result});
 }});
 ctx.effect(()=>async()=>{off();await weixin.stop();await scheduler.stop();await service.close();},'personal-assistant.dispose');
 await service.initializeWorkspace();
}
