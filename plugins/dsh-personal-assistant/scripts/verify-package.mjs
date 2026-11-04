import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {Worker} from 'node:worker_threads';import assert from 'node:assert/strict';
import {archiveFiles} from './archive-files.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),temp=mkdtempSync(join(tmpdir(),'assistant-package-'));
try{
 let archive;
 if(process.argv[2]) archive=resolve(process.argv[2]);
 else {
  const packed=spawnSync(process.execPath,[process.env.npm_execpath,'pack','--ignore-scripts','--json','--pack-destination',temp],{cwd:root,encoding:'utf8'});
  if(packed.status!==0)throw packed.error??new Error(packed.stderr);
  archive=join(temp,JSON.parse(packed.stdout)[0].filename);
 }
 const listed=spawnSync('tar',['-tzf',archive],{encoding:'utf8'});
 if(listed.status!==0)throw listed.error??new Error(listed.stderr);
 const manifest={size:statSync(archive).size,files:archiveFiles(listed.stdout)};
 for(const item of manifest.files){assert.ok(!/(^|\/)(node_modules|src|docs?|tests?|__tests__|fixtures?|spikes|artifacts|\.local|runtime)(\/|$)/i.test(item.path));assert.ok(!/(^|\/)(\.env[^/]*|\.credentials[^/]*)(\/|$)/i.test(item.path));assert.ok(!/\.(test|spec)\.[^/]+$/i.test(item.path));assert.ok(!/\.(sqlite(?:-wal|-shm)?|key|pem)$/i.test(item.path));}
 for(const file of ['lib/host.js','lib/agent.js','lib/client.js','lib/worker.js','lib/zones.json','LICENSE','THIRD_PARTY_NOTICES.md','cordis.patch.yml'])assert.ok(manifest.files.some(f=>f.path===file),file);
 const unpack=spawnSync('tar',['-xzf',archive,'-C',temp],{encoding:'utf8'});if(unpack.status!==0)throw new Error(unpack.stderr);
 const pkg=JSON.parse(readFileSync(join(temp,'package','package.json'),'utf8'));assert.equal(pkg.license,'MIT');assert.equal(pkg.private,false);assert.match(readFileSync(join(temp,'package','lib','client.js'),'utf8'),/window\.__ModuleLoader__\.load/);
 const worker=new Worker(pathToFileURL(join(temp,'package','lib','worker.js')),{workerData:{root:join(temp,'data')}});await new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',resolve);});const response=new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',resolve);});worker.postMessage({id:'check',method:'health'});assert.equal((await response).result.integrity,'ok');const closed=new Promise(resolve=>worker.once('message',resolve));worker.postMessage({id:'close',method:'close'});await closed;await worker.terminate();
 console.log(JSON.stringify({package:pkg.name,version:pkg.version,files:manifest.files.length,bytes:manifest.size,isolatedWorker:'passed'}));
}finally{rmSync(temp,{recursive:true,force:true});}
