import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceFromEvent,REPORT_SOURCE,isReportTurn} from '../src/host/session-events.ts';
const event=(kind,id='message')=>({type:'user/message',data:{message:{id,source:{kind},content:[{type:'text',text:'下次活动保留纸质名单'}]}}});
test('all native root workspaces contribute with original location and preset',()=>{
 for(const cwd of ['/work/project-a','/life/project-b']){
  const source=sourceFromEvent({id:cwd,header:{cwd,agentPreset:'custom-coding'}},event('user'));
  assert.equal(source.context.workspace,cwd);assert.equal(source.context.preset,'custom-coding');assert.equal(source.status,'buffered');assert.equal(source.id,cwd+':message');
 }
});
test('runtime context, maintenance reports and subagents are never personal memory sources',()=>{
 const session={id:'s',header:{cwd:'/work'}};
 assert.equal(sourceFromEvent(session,event('runtime-context')),null);
 assert.equal(sourceFromEvent(session,event(REPORT_SOURCE)),null);
 assert.equal(sourceFromEvent({...session,header:{...session.header,origin:'subagent'}},event('user')),null);
 const run=event('user');run.data.message.source.rpcId='run:job';assert.equal(sourceFromEvent(session,run).status,'ordinary');
});

test('report exclusion ends at the next real user turn and survives a resumed session',()=>{const events=[event(REPORT_SOURCE,'report')];const session={id:'s',header:{cwd:'/assistant'},snapshotEvents:()=>events};assert.equal(isReportTurn(session),true);assert.equal(sourceFromEvent(session,{type:'assistant/message',data:{message:{id:'r',source:{kind:'model'},content:[{type:'text',text:'整理完成'}]}}}),null);events.push(event('user','follow-up'));assert.equal(isReportTurn(session),false);assert.equal(sourceFromEvent(session,events.at(-1)).id,'s:follow-up');});
