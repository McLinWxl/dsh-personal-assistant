import type {OwnerSession,SessionEvent} from './context.js';
import type {SourceRecord} from './storage-types.js';
export const REPORT_SOURCE='personal-assistant-report';
export const messageText=(message:any)=>(message?.content??[]).filter((v:any)=>v.type==='text').map((v:any)=>v.text).join('\n');
export function isOwnerSession(session:OwnerSession){return session?.header?.origin!=='subagent';}
export function isUserMessage(event:SessionEvent){return event.type==='user/message'&&(event.data.message??event.data).source?.kind==='user';}
export function isReportTurn(session:OwnerSession){const event=(session.snapshotEvents?.()??[]).findLast((e:SessionEvent)=>e.type==='user/message'&&['user',REPORT_SOURCE].includes((e.data.message??e.data).source?.kind));return(event?.data.message??event?.data)?.source?.kind===REPORT_SOURCE;}
/** Root conversations retain their own workspace and preset. Runtime messages and child agents never become personal facts. */
export function sourceFromEvent(session:OwnerSession,event:SessionEvent):SourceRecord|null{
 if(!isOwnerSession(session)||isReportTurn(session))return null;
 if(!['user/message','assistant/message'].includes(event.type))return null;
 const message=event.data.message??event.data;
 if(event.type==='user/message'&&!isUserMessage(event)||message.source?.kind===REPORT_SOURCE)return null;
 const text=messageText(message);if(!message.id||!text)return null;
 return{id:session.id+':'+message.id,sessionId:session.id,role:event.type==='user/message'?'user':'assistant',text,
  projectEligible:!String(message.source?.rpcId??'').startsWith('run:'),
  status:event.type==='user/message'&&!String(message.source?.rpcId??'').startsWith('run:')?'buffered':'ordinary',
  context:{workspace:session.header.cwd??'',preset:session.header.agentPreset??'',origin:session.header.origin??'user'}};
}
