import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {dependencyNotice} from './license-notices.mjs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
await mkdir(join(root,'lib'),{recursive:true});
const require=createRequire(import.meta.url),tz=require('@touch4it/ical-timezones');
const names=Object.keys(require('@touch4it/ical-timezones/zones.js'));
await writeFile(join(root,'lib/zones.json'),JSON.stringify(Object.fromEntries(names.map(name=>[name,tz.getVtimezoneComponent(name)]))));
const entries={agent:'src/host/agent.ts',worker:'src/storage/worker.ts',core:'src/storage/store.ts',channels:'src/channels/weixin.ts',credentials:'src/channels/credentials.ts',settings:'src/host/settings.ts',host:'src/host/index.ts'};
for(const [name,path] of Object.entries(entries))await build({entryPoints:[join(root,path)],outfile:join(root,'lib',name+'.js'),bundle:true,format:'esm',platform:'node',target:'node24',packages:'bundle',external:['@deepseek-ai/*','@napi-rs/keyring'],banner:{js:"import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"},legalComments:'eof'});
{
  const result=await build({entryPoints:[join(root,'src/client/index.tsx')],bundle:true,format:'cjs',platform:'browser',target:'chrome120',external:['react','react-dom','react/jsx-runtime'],loader:{'.css':'text'},write:false,legalComments:'eof'});
  await writeFile(join(root,'lib/client.js'),'window.__ModuleLoader__.load({id:"dsh-personal-assistant",factory(require){var module={exports:{}};var exports=module.exports;\n'+result.outputFiles[0].text+'\nreturn module.exports;}});\n');
}
const licenses=await Promise.all(['zod','ical.js','js-yaml','qrcode','pngjs','dijkstrajs','@touch4it/ical-timezones','@napi-rs/keyring'].map(name=>dependencyNotice(join(root,'node_modules',name))));
await writeFile(join(root,'THIRD_PARTY_NOTICES.md'),licenses.join('\n\n'));
console.log('Built all plugin entries.');
