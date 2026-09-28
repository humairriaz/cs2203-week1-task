const base=process.env.BASE_URL||'http://localhost:3000';
for(const path of ['/api/health','/api/dashboard','/api/team','/api/projects','/api/tasks','/api/hr','/api/sales','/api/finance','/api/reports']){
  const r=await fetch(base+path); if(!r.ok) throw new Error(`${path}: HTTP ${r.status}`); console.log('PASS',path);
}
console.log('Smoke test complete.');
