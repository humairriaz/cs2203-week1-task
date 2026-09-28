import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData, mutateData } from './src/runtime/store.mjs';
import { getDashboard, getTeam, getProjects, getTasks, getHr, getSales, getFinance, getKnowledge, getReports } from './src/runtime/dashboard.mjs';
import { runAgent, agentStatus } from './src/runtime/agent-engine.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const publicDir=join(root,'public');

async function loadEnv(){
  try{
    const raw=await readFile(join(root,'.env'),'utf8');
    for(const line of raw.split(/\r?\n/)){
      const s=line.trim(); if(!s||s.startsWith('#')||!s.includes('=')) continue;
      const i=s.indexOf('='); const k=s.slice(0,i).trim(); let v=s.slice(i+1).trim();
      if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1);
      if(!(k in process.env)) process.env[k]=v;
    }
  }catch{}
}
await loadEnv();

const PORT=Number(process.env.PORT||3000);
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon'};

function send(res,status,body,headers={}){res.writeHead(status,headers);res.end(body);}
function json(res,status,obj){send(res,status,JSON.stringify(obj),{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});}
async function bodyJson(req){let raw='';for await(const c of req){raw+=c;if(raw.length>1_000_000)throw new Error('Body too large');}if(!raw)return{};try{return JSON.parse(raw)}catch{throw new Error('Invalid JSON')}}

async function api(req,res,url){
  const p=url.pathname;
  if(req.method==='GET'&&p==='/api/health') return json(res,200,{ok:true,service:'DeepCiphers Agent',time:new Date().toISOString(),agent:agentStatus()});
  if(req.method==='GET'&&p==='/api/dashboard') return json(res,200,await getDashboard());
  if(req.method==='GET'&&p==='/api/team') return json(res,200,await getTeam());
  if(req.method==='GET'&&p==='/api/projects') return json(res,200,await getProjects());
  if(req.method==='GET'&&p==='/api/tasks') return json(res,200,await getTasks());
  if(req.method==='GET'&&p==='/api/hr') return json(res,200,await getHr());
  if(req.method==='GET'&&p==='/api/sales') return json(res,200,await getSales());
  if(req.method==='GET'&&p==='/api/finance') return json(res,200,await getFinance());
  if(req.method==='GET'&&p==='/api/reports') return json(res,200,await getReports());
  if(req.method==='GET'&&p==='/api/settings') return json(res,200,{agent:agentStatus(),storage:'local-json',operatorMode:'queue-only',version:'V17 Full Working'});
  if(req.method==='GET'&&p==='/api/knowledge') return json(res,200,await getKnowledge(url.searchParams.get('q')||''));
  if(req.method==='GET'&&p==='/api/operator'){const d=await loadData();return json(res,200,d.operatorQueue||[])}

  if(req.method==='POST'&&p==='/api/agent'){
    const b=await bodyJson(req); const message=String(b.message||'').trim(); if(!message)return json(res,400,{error:'message is required'});
    return json(res,200,await runAgent(message,Array.isArray(b.history)?b.history:[]));
  }
  if(req.method==='POST'&&p==='/api/knowledge'){
    const b=await bodyJson(req); const title=String(b.title||'').trim(), content=String(b.content||'').trim(), category=String(b.category||'Agent Memory').trim();
    if(!title||!content)return json(res,400,{error:'title and content are required'});
    const item=await mutateData(d=>{const x={id:`m${Date.now()}`,title:title.slice(0,120),content:content.slice(0,4000),category:category.slice(0,80),createdAt:new Date().toISOString()};d.memories.push(x);return x;});
    return json(res,201,item);
  }
  if(req.method==='POST'&&p==='/api/operator'){
    const b=await bodyJson(req); const command=String(b.command||'').trim(); if(!command)return json(res,400,{error:'command is required'});
    const item=await mutateData(d=>{const x={id:`op${Date.now()}`,command:command.slice(0,500),device:String(b.device||'default'),status:'QUEUED',createdAt:new Date().toISOString()};d.operatorQueue.push(x);return x;});
    return json(res,201,item);
  }
  const taskMatch=p.match(/^\/api\/tasks\/([^/]+)$/);
  if(taskMatch&&req.method==='PATCH'){
    const b=await bodyJson(req); const allowed=['TODO','IN_PROGRESS','BLOCKED','REVIEW','CHANGES_REQUESTED','DONE','APPROVED'];
    if(!allowed.includes(String(b.status)))return json(res,400,{error:'invalid status'});
    const updated=await mutateData(d=>{const t=d.tasks.find(x=>x.id===taskMatch[1]);if(!t)return null;t.status=String(b.status);t.updatedAt=new Date().toISOString();return t;});
    return updated?json(res,200,updated):json(res,404,{error:'task not found'});
  }
  const leaveMatch=p.match(/^\/api\/hr\/leave\/([^/]+)$/);
  if(leaveMatch&&req.method==='POST'){
    const b=await bodyJson(req); const action=String(b.action||'').toUpperCase(); if(!['APPROVE','REJECT'].includes(action))return json(res,400,{error:'action must be APPROVE or REJECT'});
    const updated=await mutateData(d=>{const l=d.leaveRequests.find(x=>x.id===leaveMatch[1]);if(!l)return null;l.status=action==='APPROVE'?'APPROVED':'REJECTED';l.decidedAt=new Date().toISOString();return l;});
    return updated?json(res,200,updated):json(res,404,{error:'leave request not found'});
  }
  return json(res,404,{error:'API route not found'});
}

async function staticFile(req,res,url){
  let p=url.pathname==='/'?'/index.html':url.pathname;
  const safe=normalize(p).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/,'');
  const file=resolve(publicDir,safe);
  if(!file.startsWith(resolve(publicDir))) return send(res,403,'Forbidden');
  try{const st=await stat(file);if(!st.isFile())throw new Error('not file');const data=await readFile(file);send(res,200,data,{'content-type':mime[extname(file).toLowerCase()]||'application/octet-stream','cache-control':'no-cache'});}catch{send(res,404,'Not found',{'content-type':'text/plain; charset=utf-8'});}
}

export function createServer(){
  return http.createServer(async(req,res)=>{
    const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
    try{if(url.pathname.startsWith('/api/'))await api(req,res,url);else await staticFile(req,res,url);}catch(err){console.error(err);json(res,500,{error:'Internal server error',detail:String(err?.message||err)});}
  });
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const server=createServer();
  server.listen(PORT,()=>console.log(`DeepCiphers Agent running on http://localhost:${PORT}`));
}
