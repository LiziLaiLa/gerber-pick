import {build} from 'esbuild';
import {mkdir,readFile,readdir,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {zipSync,strToU8} from 'fflate';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
await mkdir('dist/vendor',{recursive:true});
await build({entryPoints:['src/app.js'],bundle:true,minify:true,format:'iife',target:['es2020'],outfile:'dist/app.js',legalComments:'external'});
await Promise.all([
  copyFile('src/index.html','dist/index.html'),copyFile('src/style.css','dist/style.css'),
  copyFile('node_modules/pcb-stackup/dist/pcb-stackup.min.js','dist/vendor/pcb-stackup.min.js'),
  copyFile('node_modules/pcb-stackup/dist/pcb-stackup.min.js.LICENSE.txt','dist/vendor/pcb-stackup.min.js.LICENSE.txt'),
]);
const demo={};
for(const name of await readdir('fixtures'))if(name.startsWith('demo-'))demo[name]=new Uint8Array(await readFile(path.join('fixtures',name)));
await writeFile('dist/demo.zip',zipSync(demo));
const notices=[];
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
for(const [directory,pkg] of Object.entries(lock.packages)){
  if(!directory||pkg.dev||pkg.optional)continue;
  const names=await readdir(directory).catch(()=>[]);
  const license=names.find(n=>/^licen[cs]e(?:\..*)?$/i.test(n));
  if(license)notices.push(`## ${directory.replace('node_modules/','')} ${pkg.version}\n\n${await readFile(path.join(directory,license),'utf8')}`);
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt',notices.join('\n\n---\n\n'));
await copyFile('LICENSE','dist/LICENSE');
await writeFile('dist/.nojekyll','');
const files={};
async function collect(dir){for(const e of await readdir(dir,{withFileTypes:true})){
  const p=path.join(dir,e.name);if(e.isDirectory())await collect(p);else files[p.slice(5).replaceAll('\\','/')]=new Uint8Array(await readFile(p));
}}
await collect('dist');
files['START.txt']=strToU8('GerberPick: serve this folder with any static server, e.g. python -m http.server 8080, then open http://localhost:8080. No uploads or backend.\n');
await writeFile('gerber-pick-web.zip',zipSync(files));
console.log('Built dist/ and gerber-pick-web.zip (all scripts bundled locally).');
