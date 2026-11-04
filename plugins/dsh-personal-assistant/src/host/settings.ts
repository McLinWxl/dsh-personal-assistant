import {join} from 'node:path';
import type {PluginContext} from './context.js';
export async function settingsOptions(ctx:PluginContext,root:string){
 const selection=ctx.agentDefaultModel.currentSelection(),presets=(await ctx.agentPresets.list()).filter((p:any)=>!['personal-assistant','personal-assistant-maintenance'].includes(p.id));
 const catalogs=await Promise.allSettled(ctx.llm.listProviders().map(async(p:any)=>(await ctx.llm.listModels(p.id)).map((m:any)=>({id:p.id+'/'+m.id,name:(p.name??p.id)+' · '+m.name}))));
 const models=catalogs.flatMap(r=>r.status==='fulfilled'?r.value:[]),defaultModel=selection?.provider&&selection?.model?selection.provider+'/'+selection.model:'';
 const date=new Date(),stamp=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('')+'-'+String(date.getHours()).padStart(2,'0')+String(date.getMinutes()).padStart(2,'0')+String(date.getSeconds()).padStart(2,'0');
 const presetLabel=(p:any)=>p?.name??({cordis:'内置助手',standard:'标准助手'} as any)[p?.id]??p?.id;
 return{models,presets:presets.map((p:any)=>({...p,name:presetLabel(p)})),defaults:{model:defaultModel,modelName:models.find((m:any)=>m.id===defaultModel)?.name??defaultModel,basePreset:ctx.agentPresets.defaultId,presetName:presetLabel(presets.find((p:any)=>p.id===ctx.agentPresets.defaultId))??ctx.agentPresets.defaultId,workspace:join(root,'projects','workspace'),exportDirectory:join(root,'..','DSH Assistant Backup '+stamp)},exportName:'DSH Assistant Backup '+stamp};
}
