import {randomUUID} from 'node:crypto';
import type {AssistantService} from './service.js';
export function nextLocalHour(now:number,timezone:string,hour:number){
 const format=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 let next=Math.floor(now/60000)*60000+60000;for(let i=0;i<3000;i++,next+=60000)if(format.format(next)===String(hour).padStart(2,'0')+':00')return next;
 throw new Error('UNABLE_TO_SCHEDULE_LOCAL_TIME');
}
export class Scheduler {
 private timer:ReturnType<typeof setTimeout>|undefined;private stopped=false;private pending:Promise<any>|undefined;
 constructor(private service:AssistantService){}
 async reconfigure(){const settings=await this.service.command('settingsGet',{});await this.service.storage.call('jobReschedule',{id:'memory-daily',nextAt:nextLocalHour(Date.now(),settings.timezone,settings.maintenanceHour)});}
 async start(){this.stopped=false;const settings=await this.service.command('settingsGet',{});const now=Date.now();await this.service.storage.call('jobEnsure',{id:'memory-daily',kind:'memory',nextAt:nextLocalHour(now,settings.timezone,settings.maintenanceHour)});await this.service.storage.call('jobEnsure',{id:'capture-pending',kind:'capture',nextAt:now});await this.service.storage.call('jobEnsure',{id:'project-pending',kind:'projects',nextAt:now});await this.service.storage.call('jobEnsure',{id:'retention',kind:'retention',nextAt:now});await this.service.storage.call('jobEnsure',{id:'tools-weekly',kind:'tools',nextAt:now+7*86400000});this.schedule();}
 private schedule(){if(!this.stopped)this.timer=setTimeout(()=>{this.pending=this.tick().catch(e=>this.service.report(e)).finally(()=>this.schedule());},15000);this.timer?.unref();}
 async tick(){if(this.stopped)return;await this.service.storage.call('reminders');const settings=await this.service.command('settingsGet',{});const job=await this.service.storage.call('jobClaim',{claimId:randomUUID(),leaseMs:(settings.maintenanceMaxSeconds+60)*1000});if(!job)return;
 let error:string|undefined,retry=false;try{
  if(job.kind==='retention')await this.service.storage.call('purge');
  else if(job.kind==='capture')retry=!!(await this.service.capturePending())?.busy;
  else if(job.kind==='projects')retry=!!(await this.service.captureProjects())?.busy;
  else if(job.kind==='memory')retry=!!(await this.service.maintenance())?.busy;
  else if(job.kind==='tools')await this.service.reviewTools();
 }catch(e:any){error=e.message;await this.service.storage.call('notify',{id:'job-error:'+job.runId,type:'maintenance.failed',payload:{jobId:job.id,error}});}
 const nextAt=error||retry?Date.now()+15*60000:['capture','projects'].includes(job.kind)?Date.now()+30000:job.kind==='retention'?Date.now()+15*60000:job.kind==='tools'?Date.now()+7*86400000:nextLocalHour(Date.now(),settings.timezone,settings.maintenanceHour);
 await this.service.storage.call('jobFinish',{id:job.id,runId:job.runId,nextAt,error});}
 async stop(){this.stopped=true;if(this.timer)clearTimeout(this.timer);await this.pending;}
}
