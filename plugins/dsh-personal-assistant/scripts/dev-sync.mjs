#!/usr/bin/env node
/**
 * Sync the freshly built plugin (lib/, locale/, manifests) into the DSH profile
 * copy that the running GUI actually loads.
 *
 * Usage:
 *   node scripts/dev-sync.mjs            # sync current build
 *   node scripts/dev-sync.mjs --watch    # build + sync on every src/ change
 *   DSH_PLUGIN_DIR=/abs/path node scripts/dev-sync.mjs   # explicit target
 *
 * Why: `plugin_manager` installs a *copy* of this package into
 * $DSH_HOME/profiles/<profile>/node_modules/dsh-personal-assistant, so editing
 * the repository does not affect the running GUI until that copy is refreshed
 * and the plugin is reloaded.
 */
import {copyFileSync,cpSync,existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const pluginRoot=resolve(fileURLToPath(new URL('.',import.meta.url)),'..');
/** Files/directories that must exist in the profile copy (package.json `files`). */
const ARTIFACTS=['lib','locale','package.json','cordis.patch.yml','icon.svg','LICENSE','THIRD_PARTY_NOTICES.md','README.md'];

function fail(message,code=1){console.error('[dev] '+message);process.exit(code);}

function resolveTarget(){
 if(process.env.DSH_PLUGIN_DIR)return resolve(process.env.DSH_PLUGIN_DIR);
 const home=process.env.DSH_HOME||join(homedir(),'.dsh');
 const profiles=join(home,'profiles');
 if(!existsSync(profiles))return null;
 const names=['desktop',...readdirSync(profiles).filter(name=>name!=='desktop').sort()];
 for(const name of names){
  const candidate=join(profiles,name,'node_modules','dsh-personal-assistant');
  if(existsSync(candidate))return candidate;
 }
 return null;
}

function profileDirectory(target){
 // <profile>/node_modules/dsh-personal-assistant -> <profile>
 return resolve(target,'..','..','..');
}

function dependencySpec(target){
 try{
  const pkg=JSON.parse(readFileSync(join(profileDirectory(target),'package.json'),'utf8'));
  return pkg.dependencies?.['dsh-personal-assistant'];
 }catch{return undefined;}
}

function build(){
 console.log('[dev] building lib/ …');
 const result=spawnSync(process.execPath,[join(pluginRoot,'scripts','build.mjs')],{cwd:pluginRoot,stdio:'inherit'});
 if(result.status!==0)fail('build failed; nothing was synced',result.status??1);
}

function sync(target){
 for(const name of ARTIFACTS){
  const source=join(pluginRoot,name);
  if(!existsSync(source))fail(`missing build artifact: ${source} (run npm run build first)`);
  const destination=join(target,name);
  if(statSync(source).isDirectory()){
   rmSync(destination,{recursive:true,force:true});
   cpSync(source,destination,{recursive:true});
  }else{
   mkdirSync(target,{recursive:true});
   // pnpm installs `file:` dependencies as hard links, so the profile copy may
   // share an inode with the repo file. cpSync refuses identical dev+ino (and an
   // in-place write would corrupt the repo build), so replace the link itself.
   rmSync(destination,{force:true});
   copyFileSync(source,destination);
  }
 }
 console.log(`[dev] synced ${ARTIFACTS.length} entries -> ${target}`);
 const spec=dependencySpec(target);
 if(spec&&!spec.startsWith('file:')&&!spec.startsWith('link:')){
  console.warn(`[dev] WARNING: profile dependency is "${spec}", not a local directory/file;`);
  console.warn('[dev] the next DSH package install will overwrite this sync. Switch to a local');
  console.warn(`[dev] directory install (file:${pluginRoot}) before iterating.`);
 }
 console.log('[dev] next: client-only change → refresh the page; host/agent/worker change → reload the plugin (disable/enable) or restart DSH.');
}

async function watch(){
 let timer=null;
 let running=false;
 const trigger=()=>{
  if(timer)clearTimeout(timer);
  timer=setTimeout(()=>{
   if(running)return;
   running=true;
   try{build();const target=resolveTarget();if(target)sync(target);}finally{running=false;}
  },250);
 };
 const stop=()=>{if(timer)clearTimeout(timer);console.log('\n[dev] watch stopped');process.exit(0);};
 process.on('SIGINT',stop);process.on('SIGTERM',stop);
 const {watch:watchDir}=await import('node:fs');
 watchDir(join(pluginRoot,'src'),{recursive:true},trigger);
 console.log('[dev] watching src/ … (Ctrl-C to stop)');
}

const target=resolveTarget();
if(!target)fail(`plugin is not installed in any DSH profile (looked under ${process.env.DSH_HOME||join(homedir(),'.dsh')}/profiles).\nInstall it first: DSH 插件页 → 添加插件 → file:${pluginRoot}`);

let sameDirectory=false;
try{sameDirectory=realpathSync(target)===realpathSync(pluginRoot);}catch{}
if(sameDirectory){
 console.log('[dev] profile points directly at this repository; no sync needed. Refresh/reload only.');
}else if(process.argv.includes('--watch')){
 build();sync(target);await watch();
}else{
 sync(target);
}
