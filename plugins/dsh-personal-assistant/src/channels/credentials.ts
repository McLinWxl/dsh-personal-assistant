type Entry = {getPassword():Promise<string|null>;setPassword(value:string):Promise<void>;deletePassword():Promise<boolean>};
type Factory = (service:string,account:string)=>Promise<Entry>;
const SERVICE='com.mclinwxl.dsh-personal-assistant';
async function systemEntry(service:string,account:string):Promise<Entry>{
 const {AsyncEntry}=await import('@napi-rs/keyring');
 return new AsyncEntry(service,account,{linux:{store:'secret-service'}});
}
export class DeviceCredentials {
 constructor(private dataset:()=>Promise<string>,private factory:Factory=systemEntry){}
 private async entry(){const id=await this.dataset();if(!/^[a-zA-Z0-9-]+$/.test(id))throw new Error('INVALID_CREDENTIAL_DATASET');try{return await this.factory(SERVICE,'weixin:'+id);}catch{throw new Error('WEIXIN_SECURE_STORE_UNAVAILABLE');}}
 async get(){const entry=await this.entry();let raw;try{raw=await entry.getPassword();}catch{throw new Error('WEIXIN_SECURE_STORE_UNAVAILABLE');}if(raw===null)return null;try{const value=JSON.parse(raw);if(value.version!==1||!value.binding?.token||!value.binding?.owner||!value.binding?.bot||!value.binding?.base||!value.binding?.generation)throw new Error();return value.binding;}catch{throw new Error('WEIXIN_SECURE_STORE_INVALID');}}
 async set(binding:any){const entry=await this.entry();try{if(binding===null)await entry.deletePassword();else await entry.setPassword(JSON.stringify({version:1,binding}));}catch{throw new Error('WEIXIN_SECURE_STORE_UNAVAILABLE');}}
}
