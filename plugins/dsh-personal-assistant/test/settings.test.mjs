import test from 'node:test';import assert from 'node:assert/strict';import {join} from 'node:path';import {settingsOptions} from '../lib/settings.js';
test('settings expose real defaults and selectable catalogs without losing healthy providers',async()=>{
 const ctx={agentDefaultModel:{currentSelection:()=>({provider:'ready',model:'model'})},agentPresets:{defaultId:'standard',list:async()=>[{id:'standard',name:'标准助手'},{id:'personal-assistant'},{id:'personal-assistant-maintenance'}]},llm:{listProviders:()=>[{id:'ready',name:'服务商'},{id:'offline'}],listModels:async id=>{if(id==='offline')throw new Error('offline');return[{id:'model',name:'模型'}];}}};
 const options=await settingsOptions(ctx,join(process.cwd(),'data'));
 assert.equal(options.defaults.modelName,'服务商 · 模型');assert.equal(options.defaults.presetName,'标准助手');assert.equal(options.defaults.workspace,join(process.cwd(),'data','projects','workspace'));
 assert.equal(options.models.length,1);assert.equal(options.presets.length,1);assert.notEqual(options.defaults.exportDirectory,'');
});
