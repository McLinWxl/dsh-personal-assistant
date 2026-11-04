import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceCredentials} from '../lib/credentials.js';
const binding={token:'synthetic-token',owner:'owner',bot:'bot',base:'https://ilinkai.weixin.qq.com',generation:'generation'};
function backend(){const values=new Map();return{values,factory:async(service,account)=>({getPassword:async()=>values.get(service+'/'+account)??null,setPassword:async value=>{values.set(service+'/'+account,value);},deletePassword:async()=>values.delete(service+'/'+account)})};}
test('device credentials survive service restart but do not follow a dataset to another device',async()=>{
 const a=backend(),b=backend();let dataset='dataset-a';const original=new DeviceCredentials(async()=>dataset,a.factory);await original.set(binding);
 assert.deepEqual(await new DeviceCredentials(async()=>dataset,a.factory).get(),binding);
 assert.equal(await new DeviceCredentials(async()=>dataset,b.factory).get(),null);
 dataset='dataset-b';assert.equal(await original.get(),null);dataset='dataset-a';await original.set(null);assert.equal(await original.get(),null);
});
test('secure store failures never become successful saves or expose credential values',async()=>{
 const fail=async()=>{throw new Error('synthetic-token');};const store=new DeviceCredentials(async()=>'dataset',async()=>({getPassword:fail,setPassword:fail,deletePassword:fail}));
 for(const operation of [()=>store.get(),()=>store.set(binding),()=>store.set(null)])await assert.rejects(operation(),e=>e.message==='WEIXIN_SECURE_STORE_UNAVAILABLE');
 const invalid=new DeviceCredentials(async()=>'dataset',async()=>({getPassword:async()=>'{invalid synthetic-token',setPassword:async()=>{},deletePassword:async()=>true}));
 await assert.rejects(invalid.get(),e=>e.message==='WEIXIN_SECURE_STORE_INVALID');
});
