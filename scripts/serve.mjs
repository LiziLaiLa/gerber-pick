import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist');
const port=Number(process.env.PORT||8795);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.zip':'application/zip','.png':'image/png','.txt':'text/plain; charset=utf-8'};
http.createServer(async(req,res)=>{
  try{
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    let target=path.resolve(root,'.'+pathname);
    if(target!==root&&!target.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
    if((await stat(target)).isDirectory())target=path.join(target,'index.html');
    const data=await readFile(target);
    res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:data);
  }catch{res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not found. Run npm run build before npm run dev.');}
}).listen(port,'127.0.0.1',()=>console.log(`GerberPick: http://127.0.0.1:${port}`));
