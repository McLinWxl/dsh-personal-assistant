import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
export class StorageClient {
  private worker:Worker;
  private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  ready:Promise<void>;
  private closed=false;
  constructor(root:string,options:any={}){
    this.worker=new Worker(new URL('./worker.js',import.meta.url),{workerData:{root,options}});
    this.ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{reject(new Error('STORAGE_START_TIMEOUT'));void this.worker.terminate();},30000);const cleanup=()=>{clearTimeout(timer);this.worker.off('error',error);this.worker.off('exit',exit);this.worker.off('message',listener);};const error=(e:Error)=>{cleanup();reject(e);};const exit=()=>error(new Error('STORAGE_START_FAILED'));const listener=(m:any)=>{if(m.ready){cleanup();resolve();}};this.worker.once('error',error);this.worker.once('exit',exit);this.worker.on('message',listener);});
    this.worker.on('message',(message:any)=>{if(message.ready)return;const entry=this.pending.get(message.id);if(!entry)return;this.pending.delete(message.id);clearTimeout(entry.timer);if(message.error)entry.reject(Object.assign(new Error(message.error.message),message.error));else entry.resolve(message.result);});
    this.worker.on('error',error=>this.fail(error));this.worker.on('exit',code=>{this.closed=true;this.fail(new Error('STORAGE_WORKER_EXITED_'+code));});
  }
  private fail(error:Error){for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}this.pending.clear();}
  async call(method:string,args:any={}){await this.ready;if(this.closed)throw new Error('STORAGE_CLOSED');return new Promise<any>((resolve,reject)=>{const id=randomUUID();const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('STORAGE_OPERATION_TIMEOUT_CHECK_STATE'));},method==='export'?600000:120000);this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({id,method,args});});}
  async close(){if(this.closed)return;await this.call('close');this.closed=true;await this.worker.terminate();}
}
