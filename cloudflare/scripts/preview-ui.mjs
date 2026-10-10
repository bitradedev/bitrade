import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
const root=resolve('bi-trade/web');
const pages={'/':'intro.html','/intro':'intro.html','/intro.html':'intro.html','/home':'index.html','/dashboard':'index.html','/docs':'index.html','/pair':'index.html','/playbook':'index.html'};
const publicPaths=new Set(['/api/state','/api/health','/api/public','/api/public/agent','/api/token','/api/leaderboard','/api/runtime']);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.md':'text/markdown; charset=utf-8'};
const server=createServer(async(req,res)=>{
 try{if(req.method!=='GET'){res.writeHead(405,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:'界面预览仅提供查看；账户操作请使用正式网站。'}));}
 const url=new URL(req.url,'http://127.0.0.1:8796');
 if(url.pathname.startsWith('/api/')){
  if(!publicPaths.has(url.pathname)){res.writeHead(404);return res.end();}
  const response=await fetch('https://bitrade.site'+url.pathname+url.search,{signal:AbortSignal.timeout(15000),redirect:'error'});
  res.writeHead(response.status,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(Buffer.from(await response.arrayBuffer()));
 }
 const name=pages[url.pathname]??url.pathname.slice(1);if(!/^[a-zA-Z0-9_.-]+$/.test(name)||!mime[extname(name)]){res.writeHead(404);return res.end();}
 const data=await readFile(resolve(root,name));res.writeHead(200,{'Content-Type':mime[extname(name)],'Cache-Control':'no-store'});res.end(data);
 }catch{res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'预览读取失败，请稍后重试。'}));}
});
server.listen(8796,'127.0.0.1',()=>console.log('UI preview: http://127.0.0.1:8796/'));
