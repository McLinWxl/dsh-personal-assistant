import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep, dirname, basename } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function atomicJson(path:string, value:unknown) {
  const tmp=path+'.'+randomUUID()+'.tmp';
  writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  // rename is atomic on the supported local filesystems.
  renameSync(tmp,path);
}
export function canonicalDestination(input:string){let current=resolve(input);const suffix:string[]=[];while(!existsSync(current)){suffix.unshift(basename(current));const parent=dirname(current);if(parent===current)throw new Error('INVALID_PATH');current=parent;}return join(realpathSync(current),...suffix);}
export function inside(root:string, path:string) {
  const target=resolve(root,path), rel=relative(resolve(root),target);
  if (rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)) throw new Error('PATH_OUTSIDE_DATA_DIRECTORY');
  {
    const real=relative(realpathSync(root),canonicalDestination(target));
    if(real==='..'||real.startsWith('..'+sep)||isAbsolute(real))throw new Error('SYMLINK_OUTSIDE_DATA_DIRECTORY');
  }
  return target;
}
export function seal(key:Buffer, text:string) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const data=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');
}
export function unseal(key:Buffer, text:string) {
  const data=Buffer.from(text,'base64');
  if(data.length<28)throw new Error('INVALID_ENCRYPTED_DATA');
  const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));
  decipher.setAuthTag(data.subarray(12,28));
  return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8');
}
export function openDirectory(input:string) {
  if(!isAbsolute(input))throw new Error('ABSOLUTE_DATA_DIRECTORY_REQUIRED');
  mkdirSync(input,{recursive:true,mode:0o700}); const root=realpathSync(input);
  const file=join(root,'manifest.json');
  if(!existsSync(file)) {
    if(existsSync(join(root,'state.sqlite')))throw new Error('UNRECOGNIZED_DATA_DIRECTORY');
    atomicJson(file,{format:'dsh-personal-assistant',schemaVersion:2,datasetId:randomUUID(),createdAt:new Date().toISOString()});
  }
  const manifest=JSON.parse(readFileSync(file,'utf8'));
  if(manifest.format==='dsh-personal-assistant'&&manifest.schemaVersion===1)throw Object.assign(new Error('MIGRATION_REQUIRED: run migrate-v2 --source <old-directory> --destination <new-directory>'),{code:'MIGRATION_REQUIRED'});
  if(manifest.format!=='dsh-personal-assistant'||manifest.schemaVersion!==2||typeof manifest.datasetId!=='string')throw new Error('UNSUPPORTED_DATA_FORMAT');
  if(existsSync(join(root,'state.sqlite'))) {
    const check=new DatabaseSync(join(root,'state.sqlite'),{readOnly:true});
    try { const version=Number(check.prepare('PRAGMA user_version').get()?.user_version);if(version>2)throw new Error('DATABASE_NEWER_THAN_PLUGIN');if(version<2)throw Object.assign(new Error('MIGRATION_REQUIRED: run migrate-v2 before opening this database'),{code:'MIGRATION_REQUIRED'}); } finally {check.close();}
  }
  for(const name of ['runtime','credentials','content/blobs','projects','tools','conversations','exports','cache'])mkdirSync(inside(root,name),{recursive:true,mode:0o700});
  const lock=join(root,'runtime','writer.lock');
  if(existsSync(lock)) {
    const old=JSON.parse(readFileSync(lock,'utf8'));
    if(old.datasetId!==manifest.datasetId||old.host!==hostname())throw new Error('DATA_DIRECTORY_LOCKED');
    try {process.kill(old.pid,0);throw new Error('DATA_DIRECTORY_LOCKED');}catch(e:any){if(e.code!=='ESRCH')throw e;}
    unlinkSync(lock);
  }
  const token=randomUUID(); const fd=openSync(lock,'wx',0o600);
  writeFileSync(fd,JSON.stringify({pid:process.pid,host:hostname(),datasetId:manifest.datasetId,token}));closeSync(fd);
  try {
    const keyPath=join(root,'credentials','rollback.key');
    if(!existsSync(keyPath))writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
    if(lstatSync(keyPath).isSymbolicLink())throw new Error('INVALID_KEY_FILE');
    const key=readFileSync(keyPath);if(key.length!==32)throw new Error('INVALID_KEY_FILE');
    return {root,manifest,codec:{seal:(v:string)=>seal(key,v),open:(v:string)=>unseal(key,v)},release:()=>{
      if(existsSync(lock)&&JSON.parse(readFileSync(lock,'utf8')).token===token)unlinkSync(lock);
      key.fill(0);
    }};
  } catch(error){unlinkSync(lock);throw error;}
}
export class Vault {
  private key:Buffer|undefined;
  private salt:Buffer|undefined;
  private values:Record<string,unknown>={};
  constructor(private root:string){}
  get path(){return join(this.root,'credentials','vault.enc');}
  get unlocked(){return this.key!==undefined;}
  unlock(passphrase:string) {
    if(passphrase.length<10||passphrase.length>1024)throw new Error('PASSPHRASE_MINIMUM_10_CHARACTERS');
    const stored=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):null;
    if(stored&&(stored.version!==1||stored.kdf!=='scrypt-32768-8-1'))throw new Error('UNSUPPORTED_VAULT');
    const salt=stored?Buffer.from(stored.salt,'base64'):randomBytes(16);
    const key=scryptSync(passphrase,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
    let values;try{values=stored?JSON.parse(unseal(key,stored.data)):{};}catch{key.fill(0);throw new Error('VAULT_UNLOCK_FAILED');}
    this.lock();this.key=key;this.salt=salt;this.values=values;if(!stored)this.save();return{unlocked:true};
  }
  get(name:string){if(!this.key)throw new Error('VAULT_LOCKED');return this.values[name];}
  set(name:string,value:unknown){if(!this.key)throw new Error('VAULT_LOCKED');this.values[name]=value;this.save();}
  private save(){atomicJson(this.path,{version:1,kdf:'scrypt-32768-8-1',salt:this.salt!.toString('base64'),data:seal(this.key!,JSON.stringify(this.values))});}
  lock(){this.key?.fill(0);this.key=undefined;this.values={};}
}
