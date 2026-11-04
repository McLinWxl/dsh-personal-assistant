import ICAL from 'ical.js';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
let zoneDefinitions:Record<string,string>|undefined;
function definition(name:string){if(name==='UTC')return null;zoneDefinitions??=JSON.parse(readFileSync(new URL('./zones.json',import.meta.url),'utf8'));const content=zoneDefinitions![name];if(!content)throw new Error('CALENDAR_TIMEZONE_UNAVAILABLE');return content;}
function attach(component:any,definitions:string[]){const root=new ICAL.Component('vcalendar');for(const content of new Set(definitions))root.addSubcomponent(new ICAL.Component(ICAL.parse(content)));root.addSubcomponent(component);return component;}
function componentFor(data:any,uid:string){return data.ics?attach(new ICAL.Component(ICAL.parse(data.ics)),data.zones??[]):eventComponent(data,uid);}
export function eventComponent(data:any,uid:string){
 const c=new ICAL.Component('vevent'),tz=data.allDay?null:definition(data.timezone),zone=tz?new ICAL.Timezone(new ICAL.Component(ICAL.parse(tz))):ICAL.Timezone.utcTimezone;
 attach(c,tz?[tz]:[]);c.addPropertyWithValue('uid',uid);c.addPropertyWithValue('summary',data.title);c.addPropertyWithValue('dtstamp',ICAL.Time.fromJSDate(new Date(),true));
 for(const [key,value]of[['dtstart',data.start],['dtend',data.end]]){
  let time:ICAL.Time;
  if(data.allDay){time=ICAL.Time.fromDateString(value);if(time.toString()!==value||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw new Error('INVALID_CALENDAR_DATE');}
  else{
   if(!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw new Error('EVENT_TIME_OFFSET_REQUIRED');
   if(tz){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:data.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(p=>[p.type,p.value]));
    time=new ICAL.Time({year:+parts.year,month:+parts.month,day:+parts.day,hour:+parts.hour,minute:+parts.minute,second:+parts.second,isDate:false},zone);
    if(Math.abs(time.toJSDate().getTime()-Date.parse(value))>=1000)throw new Error('CALENDAR_TIMEZONE_RULES_NEED_UPDATE');
   }else time=ICAL.Time.fromJSDate(new Date(value),true);
  }
  c.addPropertyWithValue(key,time);if(tz)c.getFirstProperty(key)!.setParameter('tzid',zone.tzid);
 }
 if(data.recurrence)c.addPropertyWithValue('rrule',ICAL.Recur.fromString(data.recurrence));
 if(data.description)c.addPropertyWithValue('description',data.description);if(data.location)c.addPropertyWithValue('location',data.location);
 if(data.domains?.length)c.addPropertyWithValue('categories',data.domains.join(','));return c;
}
export function validateEvent(data:any){const c=eventComponent(data,'validation'),event=new ICAL.Event(c);if(event.endDate.compare(event.startDate)<=0)throw new Error('EVENT_END_MUST_FOLLOW_START');
 if(data.allDay&&(!/^\d{4}-\d{2}-\d{2}$/.test(data.start)||!/^\d{4}-\d{2}-\d{2}$/.test(data.end)))throw new Error('ALL_DAY_DATE_REQUIRED');return data;}
export function calendarIdentity(data:any){return JSON.stringify([data.title,data.allDay,data.allDay?data.start:Date.parse(data.start),data.allDay?data.end:Date.parse(data.end),data.recurrence??'',data.location??'',data.description??'',data.recurrenceId??'']);}
export function importCalendar(content:string,timezone:string){
 const root=new ICAL.Component(ICAL.parse(content));if(root.name!=='vcalendar')throw new Error('INVALID_CALENDAR');
 const zones=root.getAllSubcomponents('vtimezone').map(c=>c.toString()),available=new Set(root.getAllSubcomponents('vtimezone').map(c=>String(c.getFirstPropertyValue('tzid'))));
 const items:any[]=[];
 for(const component of root.getAllSubcomponents('vevent')){
  for(const property of ['dtstart','dtend','recurrence-id']){const p=component.getFirstProperty(property),zone=p?.getParameter('tzid');if(zone&&!available.has(String(zone))&&zone!=='UTC'){const content=definition(String(zone));if(content){root.addSubcomponent(new ICAL.Component(ICAL.parse(content)));zones.push(content);available.add(String(zone));}}}
  const event=new ICAL.Event(component),uid=event.uid||randomUUID();if(!event.startDate)throw new Error('ICS_START_REQUIRED');
  const start=event.startDate,end=event.endDate;
  if(!start.isDate&&start.zone===ICAL.Timezone.localTimezone){const content=definition(timezone);if(content&&!available.has(timezone)){root.addSubcomponent(new ICAL.Component(ICAL.parse(content)));zones.push(content);available.add(timezone);}for(const field of ['dtstart','dtend','recurrence-id']){const prop=component.getFirstProperty(field);if(prop)prop.setParameter('tzid',timezone);}start.zone=timezone==='UTC'?ICAL.Timezone.utcTimezone:root.getTimeZoneByID(timezone)!;end.zone=start.zone;}
  const actualTimezone=String(component.getFirstProperty('dtstart')?.getParameter('tzid')??timezone);
  items.push({uid,recurrenceId:component.getFirstPropertyValue('recurrence-id')?.toString()??'',ics:component.toString(),zones:[...zones],
   title:event.summary||'日程',start:start.isDate?start.toString():start.toJSDate().toISOString(),end:end.isDate?end.toString():end.toJSDate().toISOString(),timezone:actualTimezone,allDay:start.isDate,
   recurrence:component.getFirstPropertyValue('rrule')?.toString()??'',location:event.location||'',description:event.description||'',projectId:null,taskId:null,domains:[],importance:3,
   importHash:createHash('sha256').update(component.toString()).digest('hex')});if(items.length>500)throw new Error('ICS_TOO_MANY_EVENTS');
 }return items;
}
export function exportCalendar(rows:any[]){
 const root=new ICAL.Component('vcalendar');root.addPropertyWithValue('version','2.0');root.addPropertyWithValue('prodid','-//DSH Personal Assistant//EN');const zones=new Set<string>();
 for(const row of rows){const data=row.data;const definitions=data.zones??(!data.allDay&&data.timezone!=='UTC'?[definition(data.timezone)!]:[]);for(const zone of definitions)if(!zones.has(zone)){root.addSubcomponent(new ICAL.Component(ICAL.parse(zone)));zones.add(zone);}root.addSubcomponent(componentFor(data,data.uid??row.id));}
 return root.toString()+'\r\n';
}
export function overrideOccurrence(data:any,occurrence:string,patch:any,cancelled:boolean){
 const original=new ICAL.Event(componentFor(data,data.uid));if(!original.isRecurring())throw new Error('RECURRING_EVENT_REQUIRED');
 const iterator=original.iterator();let next:any,found:any,count=0;while((next=iterator.next())){if(++count>10000)throw new Error('RECURRENCE_EXPANSION_BUDGET_EXCEEDED');if(next.toString()===occurrence){found=original.getOccurrenceDetails(next);break;}if(next.toString()>occurrence)break;}
 if(!found)throw new Error('OCCURRENCE_NOT_FOUND');
 const updated={...data,...patch,start:patch.start??(found.startDate.isDate?found.startDate.toString():found.startDate.toJSDate().toISOString()),end:patch.end??(found.endDate.isDate?found.endDate.toString():found.endDate.toJSDate().toISOString()),recurrence:'',recurrenceId:occurrence,ics:undefined,zones:undefined,importHash:undefined,cancelled};validateEvent(updated);
 const component=eventComponent(updated,data.uid);component.addPropertyWithValue('recurrence-id',next);if(!next.isDate&&next.zone.tzid!=='UTC')component.getFirstProperty('recurrence-id')!.setParameter('tzid',next.zone.tzid);if(cancelled)component.addPropertyWithValue('status','CANCELLED');
 return{...updated,ics:component.toString(),zones:component.parent!.getAllSubcomponents('vtimezone').map(c=>c.toString())};
}
export function calendarOccurrences(rows:any[],from:string,to:string){
 const begin=Date.parse(from),end=Date.parse(to);if(!Number.isFinite(begin)||!Number.isFinite(end)||end<=begin||end-begin>370*86400000)throw new Error('INVALID_CALENDAR_RANGE');
 const result:any[]=[],grouped=new Map<string,any[]>();for(const row of rows){const key=row.data.uid??row.id;if(!grouped.has(key))grouped.set(key,[]);grouped.get(key)!.push(row);}
 const add=(start:ICAL.Time,finish:ICAL.Time,row:any,key?:string)=>{const a=start.toJSDate().getTime(),b=finish.toJSDate().getTime();if(a<end&&b>begin){result.push({...row,occurrenceKey:key,occurrenceStart:start.isDate?start.toString():start.toJSDate().toISOString(),occurrenceEnd:finish.isDate?finish.toString():finish.toJSDate().toISOString()});if(result.length>2000)throw new Error('CALENDAR_RESULT_BUDGET_EXCEEDED');}};
 for(const entries of grouped.values()){
  const master=entries.find(r=>!r.data.recurrenceId),exceptions=entries.filter(r=>r.data.recurrenceId);const identities=new Set(exceptions.map(r=>{const c=componentFor(r.data,r.data.uid);return(c.getFirstPropertyValue('recurrence-id') as ICAL.Time).toUnixTime();}));
  if(master){const event=new ICAL.Event(componentFor(master.data,master.data.uid??master.id));if(event.component.getFirstPropertyValue('status')!=='CANCELLED'){
   if(!event.isRecurring())add(event.startDate,event.endDate,master);
   else {const iterator=event.iterator();let next:any,count=0;while((next=iterator.next())){if(++count>10000)throw new Error('RECURRENCE_EXPANSION_BUDGET_EXCEEDED');if(next.toJSDate().getTime()>=end)break;if(identities.has(next.toUnixTime()))continue;const occurrence=event.getOccurrenceDetails(next);add(occurrence.startDate,occurrence.endDate,master,next.toString());}}
  }}
  for(const row of exceptions){const event=new ICAL.Event(componentFor(row.data,row.data.uid));if(event.component.getFirstPropertyValue('status')!=='CANCELLED')add(event.startDate,event.endDate,row,row.data.recurrenceId);}
 }return result.sort((a,b)=>a.occurrenceStart.localeCompare(b.occurrenceStart));
}
