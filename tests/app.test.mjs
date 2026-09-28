import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from '../server.mjs';
import { detectLanguage } from '../src/runtime/agent-engine.mjs';

const dataFile=resolve('data/company.json');
let backup=''; let server; let base='';

before(async()=>{
  backup=await readFile(dataFile,'utf8');
  server=createServer();
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  base=`http://127.0.0.1:${server.address().port}`;
});

after(async()=>{
  await writeFile(dataFile,backup,'utf8');
  await new Promise(r=>server.close(r));
});

test('health endpoint is ready',async()=>{
  const r=await fetch(base+'/api/health'); assert.equal(r.status,200); const j=await r.json(); assert.equal(j.ok,true); assert.ok(j.agent.model);
});

test('dashboard returns operational stats',async()=>{
  const r=await fetch(base+'/api/dashboard'); const j=await r.json(); assert.ok(j.stats.activeProjects>=1); assert.ok(Array.isArray(j.attention)); assert.ok(Array.isArray(j.team));
});

test('local agent answers and returns tool trace',async()=>{
  const r=await fetch(base+'/api/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'What needs my attention today?'})});
  const j=await r.json(); assert.equal(r.status,200); assert.ok(j.text.length>20); assert.ok(j.tools.some(x=>x.name==='get_today_plan')); assert.equal(j.responseLanguage,'en-US');
});

test('Roman Urdu language routing works',()=>{assert.equal(detectLanguage('aaj mujhe kya karna hai'),'ur-PK')});

test('task status can be updated',async()=>{
  const r=await fetch(base+'/api/tasks/t6',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:'IN_PROGRESS'})}); const j=await r.json(); assert.equal(r.status,200); assert.equal(j.status,'IN_PROGRESS');
});

test('leave request can be approved',async()=>{
  const r=await fetch(base+'/api/hr/leave/l1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'APPROVE'})}); const j=await r.json(); assert.equal(r.status,200); assert.equal(j.status,'APPROVED');
});

test('knowledge memory persists',async()=>{
  const r=await fetch(base+'/api/knowledge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Test memory',content:'Remember this test item',category:'Test'})}); assert.equal(r.status,201);
  const s=await fetch(base+'/api/knowledge?q='+encodeURIComponent('test memory')); const j=await s.json(); assert.ok(j.some(x=>x.title==='Test memory'));
});
