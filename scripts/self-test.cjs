const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { console.log('PASS', name); passed++; }).catch((e) => { console.error('FAIL', name, '\n ', e && e.stack || e); failed++; });
}

function loadTs(rel, mocks={}) {
  const filename = path.join(root, rel);
  const source = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
  }, fileName: filename }).outputText;
  const module = { exports: {} };
  function localRequire(spec) {
    if (Object.prototype.hasOwnProperty.call(mocks, spec)) return mocks[spec];
    if (spec.startsWith('@/')) {
      if (Object.prototype.hasOwnProperty.call(mocks, spec)) return mocks[spec];
      if (spec === '@/lib/company-agent') return { processCompanyAutomation:async()=>[] };
      if (spec === '@/lib/marketing-agent') return { adaptMarketingCaption:(caption,goal)=>({linkedin:(caption+(goal?'\n\n'+goal:'')).trim(),instagram:caption.trim(),facebook:caption.trim()}), normalizeMarketingPlatforms:(input)=>Array.isArray(input)?[...new Set(input.filter((x)=>['linkedin','instagram','facebook'].includes(x)))]:[], processMarketingAutomation:async()=>[] };
      if (spec === '@/lib/employee-auth') return loadTs('src/lib/employee-auth.ts', mocks);
      throw new Error('Unmocked alias import '+spec+' in '+rel);
    }
    if (spec.startsWith('.')) {
      const abs = path.resolve(path.dirname(filename), spec);
      const key = './' + path.relative(root, abs).replace(/\\/g,'/');
      if (Object.prototype.hasOwnProperty.call(mocks, spec)) return mocks[spec];
      if (Object.prototype.hasOwnProperty.call(mocks, key)) return mocks[key];
      const target = fs.existsSync(abs+'.ts') ? abs+'.ts' : fs.existsSync(abs+'.tsx') ? abs+'.tsx' : abs;
      return loadTs(path.relative(root,target), mocks);
    }
    return require(spec);
  }
  const fn = new Function('exports','require','module','__filename','__dirname', js);
  fn(module.exports, localRequire, module, filename, path.dirname(filename));
  return module.exports;
}

function jsonResponse(data, init={}) {
  return new Response(JSON.stringify(data), { status: init.status || 200, headers: { 'Content-Type':'application/json', ...(init.headers||{}) } });
}

(async () => {
  process.env.ENCRYPTION_KEY='12345678901234567890123456789012';
  await test('AES token encryption round-trip and non-plaintext storage', () => {
    const { encrypt, decrypt } = loadTs('src/lib/crypto.ts');
    const token='super-secret-token';
    const enc=encrypt(token);
    assert.notStrictEqual(enc, token);
    assert.strictEqual(decrypt(enc), token);
  });

  await test('Dashboard auth cookie accepts valid session and rejects invalid one', async () => {
    process.env.DASHBOARD_ACCESS_KEY='private-key-123';
    const auth=loadTs('src/lib/dashboard-auth.ts');
    const v=await auth.dashboardSessionValue();
    assert.ok(v && v.length===64);
    assert.strictEqual(await auth.isDashboardRequestAuthorized(new Request('https://x.test',{headers:{cookie:`deepciphers_admin_session=${v}`}})), true);
    assert.strictEqual(await auth.isDashboardRequestAuthorized(new Request('https://x.test',{headers:{cookie:'deepciphers_admin_session=bad'}})), false);
  });

  await test('Post API rejects empty caption', async () => {
    const NextResponse={ json:(body, init={})=>({body,status:init.status||200}) };
    const route=loadTs('src/app/api/posts/route.ts',{
      'next/server':{NextResponse}, '@/lib/db':{db:{}}, '@/lib/publish':{publishPost:async()=>({})}, '@/lib/types':{}
    });
    const req=new Request('http://x/api/posts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({platforms:['linkedin']})});
    const r=await route.POST(req); assert.strictEqual(r.status,400); assert.match(r.body.error,/Caption/);
  });

  await test('Post API requires image when Instagram selected', async () => {
    const NextResponse={ json:(body, init={})=>({body,status:init.status||200}) };
    const route=loadTs('src/app/api/posts/route.ts',{
      'next/server':{NextResponse}, '@/lib/db':{db:{}}, '@/lib/publish':{publishPost:async()=>({})}, '@/lib/types':{}
    });
    const req=new Request('http://x/api/posts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({caption:'hello',platforms:['instagram']})});
    const r=await route.POST(req); assert.strictEqual(r.status,400); assert.match(r.body.error,/requires an image/i);
  });

  await test('Post API stores ISO schedule date and does not publish immediately', async () => {
    let created=null, published=false;
    const NextResponse={ json:(body, init={})=>({body,status:init.status||200}) };
    const db={post:{create:async({data})=>{created={id:'p1',...data};return created;}}};
    const route=loadTs('src/app/api/posts/route.ts',{
      'next/server':{NextResponse}, '@/lib/db':{db}, '@/lib/publish':{publishPost:async()=>{published=true;}}, '@/lib/types':{}
    });
    const future=new Date(Date.now()+3600000).toISOString();
    const req=new Request('http://x/api/posts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({caption:'hello',platforms:['linkedin'],mode:'schedule',scheduledAt:future})});
    const r=await route.POST(req); assert.strictEqual(r.status,201); assert.strictEqual(published,false); assert.strictEqual(created.scheduledAt.toISOString(),future);
  });

  await test('Post API publishes immediately in now mode', async () => {
    let publishId=null;
    const NextResponse={ json:(body, init={})=>({body,status:init.status||200}) };
    const db={post:{create:async({data})=>({id:'p-now',...data})}};
    const route=loadTs('src/app/api/posts/route.ts',{
      'next/server':{NextResponse}, '@/lib/db':{db}, '@/lib/publish':{publishPost:async(id)=>{publishId=id;return {status:'PUBLISHED',results:[]}}}, '@/lib/types':{}
    });
    const req=new Request('http://x/api/posts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({caption:'hello',platforms:['linkedin'],mode:'now'})});
    const r=await route.POST(req); assert.strictEqual(r.status,201); assert.strictEqual(publishId,'p-now'); assert.strictEqual(r.body.status,'PUBLISHED');
  });

  await test('Cron route rejects missing secret and accepts correct Bearer secret', async () => {
    process.env.CRON_SECRET='cron-secret';
    const NextResponse={ json:(body, init={})=>({body,status:init.status||200}) };
    let runs=0;
    const route=loadTs('src/app/api/cron/publish/route.ts',{
      'next/server':{NextResponse}, '@/lib/publish':{publishDuePosts:async()=>{runs++;return []}}, '@/lib/team-agent':{processStaleEmployeeReminders:async()=>[]}
    });
    let r=await route.GET(new Request('http://x/api/cron/publish')); assert.strictEqual(r.status,401); assert.strictEqual(runs,0);
    r=await route.GET(new Request('http://x/api/cron/publish',{headers:{authorization:'Bearer cron-secret'}})); assert.strictEqual(r.status,200); assert.strictEqual(runs,1);
  });

  await test('LinkedIn text publish sends official /rest/posts payload', async () => {
    const calls=[];
    const mockFetch=async (url, init={})=>{ calls.push({url:String(url),init}); return new Response('',{status:201,headers:{'x-restli-id':'urn:li:share:123'}}); };
    const mod=loadTs('src/lib/providers/linkedin.ts',{
      '../connections':{getConnection:async()=>({accountId:'urn:li:person:abc',accessToken:'tok'})},
      '../http':{fetchWithTimeout:mockFetch,responseError:async(p,r)=>new Error(p+':'+r.status)}, '../types':{}
    });
    const out=await mod.publishLinkedIn({caption:'Hello'});
    assert.strictEqual(calls.length,1); assert.match(calls[0].url,/\/rest\/posts$/);
    const body=JSON.parse(calls[0].init.body); assert.strictEqual(body.author,'urn:li:person:abc'); assert.strictEqual(body.commentary,'Hello');
    assert.strictEqual(out.externalId,'urn:li:share:123'); assert.match(out.permalink,/linkedin\.com/);
  });

  await test('LinkedIn image publish initializes, downloads, uploads, then creates post', async () => {
    const calls=[];
    const mockFetch=async (url, init={})=>{
      const u=String(url); calls.push({url:u,init});
      if (u.includes('initializeUpload')) return jsonResponse({value:{uploadUrl:'https://upload.linkedin.test/u',image:'urn:li:image:1'}});
      if (u==='https://cdn.test/a.jpg') return new Response(new Uint8Array([1,2,3]),{status:200});
      if (u==='https://upload.linkedin.test/u') return new Response('',{status:201});
      if (u.endsWith('/rest/posts')) return new Response('',{status:201,headers:{'x-restli-id':'urn:li:share:9'}});
      throw new Error('unexpected '+u);
    };
    const mod=loadTs('src/lib/providers/linkedin.ts',{
      '../connections':{getConnection:async()=>({accountId:'urn:li:person:abc',accessToken:'tok'})},
      '../http':{fetchWithTimeout:mockFetch,responseError:async(p,r)=>new Error(p+':'+r.status)}, '../types':{}
    });
    await mod.publishLinkedIn({caption:'Photo',mediaUrl:'https://cdn.test/a.jpg'});
    assert.strictEqual(calls.length,4);
    const post=JSON.parse(calls[3].init.body); assert.strictEqual(post.content.media.id,'urn:li:image:1');
  });

  await test('Facebook image publish uses page /photos and fetches permalink', async () => {
    const calls=[];
    const mockFetch=async (url, init={})=>{
      const u=String(url); calls.push({url:u,init});
      if (u.includes('/photos')) return jsonResponse({id:'photo1',post_id:'page_99'});
      if (u.includes('/page_99?')) return jsonResponse({permalink_url:'https://facebook.test/post'});
      throw new Error('unexpected '+u);
    };
    const mod=loadTs('src/lib/providers/facebook.ts',{
      '../connections':{getConnection:async()=>({accountId:'page',accessToken:'ptok'})},
      '../http':{fetchWithTimeout:mockFetch,responseError:async(p,r)=>new Error(p+':'+r.status)}, '../types':{}
    });
    const out=await mod.publishFacebook({caption:'Hi',mediaUrl:'https://cdn.test/x.jpg'});
    assert.match(calls[0].url,/\/page\/photos$/); assert.strictEqual(out.permalink,'https://facebook.test/post');
    const params=calls[0].init.body; assert.strictEqual(params.get('caption'),'Hi'); assert.strictEqual(params.get('url'),'https://cdn.test/x.jpg');
  });

  await test('Instagram publish waits for FINISHED container then publishes and fetches permalink', async () => {
    const calls=[]; let statusChecks=0;
    const mockFetch=async (url, init={})=>{
      const u=String(url); calls.push({url:u,init});
      if (u.endsWith('/ig123/media')) return jsonResponse({id:'container1'});
      if (u.includes('/container1?')) { statusChecks++; return jsonResponse({status_code: statusChecks<2?'IN_PROGRESS':'FINISHED'}); }
      if (u.endsWith('/ig123/media_publish')) return jsonResponse({id:'media9'});
      if (u.includes('/media9?')) return jsonResponse({permalink:'https://instagram.test/p/9'});
      throw new Error('unexpected '+u);
    };
    const mod=loadTs('src/lib/providers/instagram.ts',{
      '../connections':{getConnection:async()=>({accountId:'ig123',accessToken:'tok'})},
      '../http':{fetchWithTimeout:mockFetch,responseError:async(p,r)=>new Error(p+':'+r.status),sleep:async()=>{}}, '../types':{}
    });
    const out=await mod.publishInstagram({caption:'Hi',mediaUrl:'https://cdn.test/x.jpg'});
    assert.strictEqual(statusChecks,2); assert.strictEqual(out.permalink,'https://instagram.test/p/9');
  });

  await test('WhatsApp group share URL contains all published social links', async () => {
    const mod=loadTs('src/lib/whatsapp-share.ts');
    const url=mod.buildWhatsAppShareUrl([
      {platform:'linkedin',status:'PUBLISHED',permalink:'https://linkedin.test/post'},
      {platform:'facebook',status:'PUBLISHED',permalink:'https://facebook.test/post'},
      {platform:'instagram',status:'PUBLISHED',permalink:'https://instagram.test/post'},
    ]);
    assert.ok(url && url.startsWith('https://wa.me/?text='));
    const text=decodeURIComponent(url.split('text=')[1]);
    assert.match(text,/Facebook: https:\/\/facebook\.test\/post/);
    assert.match(text,/Instagram: https:\/\/instagram\.test\/post/);
    assert.match(text,/LinkedIn: https:\/\/linkedin\.test\/post/);
  });

  await test('Publish retry skips already-published channels and retries only failed channel', async () => {
    const calls=[];
    const post={id:'p1',caption:'Hi',mediaUrl:null,platforms:['linkedin','facebook'],status:'PARTIAL',publications:[
      {platform:'linkedin',status:'PUBLISHED',permalink:'https://li'}, {platform:'facebook',status:'FAILED',error:'x'}
    ]};
    const publicationRows=JSON.parse(JSON.stringify(post.publications));
    const db={
      post:{findUnique:async()=>post,update:async({data})=>{post.status=data.status;return post;},updateMany:async()=>({count:1})},
      publication:{
        upsert:async({where,update})=>{calls.push('upsert:'+where.postId_platform.platform); const r=publicationRows.find(x=>x.platform===where.postId_platform.platform); if(r){r.status=update.status;r.error=update.error;}},
        update:async({where,data})=>{const r=publicationRows.find(x=>x.platform===where.postId_platform.platform);Object.assign(r,data);},
        findMany:async()=>publicationRows,
      }
    };
    const mod=loadTs('src/lib/publish.ts',{
      './db':{db}, './types':{},
      './providers/linkedin':{publishLinkedIn:async()=>{calls.push('linkedin');return {externalId:'li'}}},
      './providers/facebook':{publishFacebook:async()=>{calls.push('facebook');return {externalId:'fb',permalink:'https://fb'}}},
      './providers/instagram':{publishInstagram:async()=>{calls.push('instagram');return {externalId:'ig'}}}
    });
    const out=await mod.publishPost('p1',true);
    assert.ok(!calls.includes('linkedin')); assert.ok(calls.includes('facebook')); assert.strictEqual(out.status,'PUBLISHED');
  });


  await test('Instagram processing ERROR aborts before media_publish', async () => {
    const calls=[];
    const mockFetch=async (url, init={})=>{
      const u=String(url); calls.push(u);
      if (u.endsWith('/ig123/media')) return jsonResponse({id:'container1'});
      if (u.includes('/container1?')) return jsonResponse({status_code:'ERROR',status:'Bad image'});
      if (u.endsWith('/ig123/media_publish')) throw new Error('should not publish');
      throw new Error('unexpected '+u);
    };
    const mod=loadTs('src/lib/providers/instagram.ts',{
      '../connections':{getConnection:async()=>({accountId:'ig123',accessToken:'tok'})},
      '../http':{fetchWithTimeout:mockFetch,responseError:async(p,r)=>new Error(p+':'+r.status),sleep:async()=>{}}, '../types':{}
    });
    await assert.rejects(()=>mod.publishInstagram({caption:'Hi',mediaUrl:'https://cdn.test/x.jpg'}),/Bad image/);
    assert.ok(!calls.some(x=>x.endsWith('/ig123/media_publish')));
  });

  await test('publishPost partial failure marks PARTIAL and preserves successful channel', async () => {
    const rows=[]; const post={id:'p2',caption:'Hi',mediaUrl:null,platforms:['linkedin','facebook'],status:'SCHEDULED',publications:[]};
    const db={post:{findUnique:async()=>post,update:async({data})=>{post.status=data.status;return post;}},publication:{
      upsert:async({where,create,update})=>{let r=rows.find(x=>x.platform===where.postId_platform.platform); if(!r){r={...create};rows.push(r);} else Object.assign(r,update);},
      update:async({where,data})=>{const r=rows.find(x=>x.platform===where.postId_platform.platform);Object.assign(r,data);},
      findMany:async()=>rows
    }};
    const mod=loadTs('src/lib/publish.ts',{
      './db':{db}, './types':{}, './providers/linkedin':{publishLinkedIn:async()=>({externalId:'li',permalink:'https://li'})},
      './providers/facebook':{publishFacebook:async()=>{throw new Error('fb down')}}, './providers/instagram':{publishInstagram:async()=>({externalId:'ig'})}
    });
    const out=await mod.publishPost('p2'); assert.strictEqual(out.status,'PARTIAL');
    assert.strictEqual(rows.find(x=>x.platform==='linkedin').status,'PUBLISHED'); assert.strictEqual(rows.find(x=>x.platform==='facebook').status,'FAILED');
  });

  await test('publishDuePosts atomically claims scheduled jobs before publishing', async () => {
    const calls=[];
    const due=[{id:'a',status:'SCHEDULED',updatedAt:new Date()}];
    const post={id:'a',caption:'Hi',mediaUrl:null,platforms:['linkedin'],status:'SCHEDULED',publications:[]};
    const rows=[];
    const db={post:{
      findMany:async()=>due,
      updateMany:async({where,data})=>{calls.push('claim'); if(where.status==='SCHEDULED'){post.status=data.status; return {count:1}} return {count:0}},
      findUnique:async()=>post,
      update:async({data})=>{post.status=data.status;return post;}
    },publication:{
      upsert:async({create})=>{rows.push({...create})}, update:async({where,data})=>{Object.assign(rows.find(x=>x.platform===where.postId_platform.platform),data)}, findMany:async()=>rows
    }};
    const mod=loadTs('src/lib/publish.ts',{
      './db':{db}, './types':{}, './providers/linkedin':{publishLinkedIn:async()=>{calls.push('publish');return {externalId:'li'}}},
      './providers/facebook':{publishFacebook:async()=>({externalId:'fb'})}, './providers/instagram':{publishInstagram:async()=>({externalId:'ig'})}
    });
    const out=await mod.publishDuePosts(); assert.strictEqual(out.length,1); assert.deepStrictEqual(calls.slice(0,2),['claim','publish']);
  });

  await test('Meta OAuth callback rejects state mismatch without API calls', async () => {
    let fetched=false;
    const NextResponse={ redirect:(url)=>({url:String(url),cookies:{delete:()=>{}}}) };
    const origFetch=global.fetch; global.fetch=async()=>{fetched=true;throw new Error('no');};
    process.env.APP_URL='https://app.test';
    try {
      const route=loadTs('src/app/api/auth/meta/callback/route.ts',{'next/server':{NextRequest:class{},NextResponse},'@/lib/connections':{saveConnection:async()=>{}},'@/lib/db':{db:{connection:{deleteMany:async()=>{}}}}});
      const req={nextUrl:new URL('https://app.test/api/auth/meta/callback?code=x&state=bad'),cookies:{get:()=>({value:'expected'})}};
      const r=await route.GET(req); assert.match(r.url,/connect=meta_error/); assert.strictEqual(fetched,false);
    } finally {global.fetch=origFetch;}
  });

  await test('LinkedIn OAuth callback rejects state mismatch without token exchange', async () => {
    let fetched=false;
    const NextResponse={ redirect:(url)=>({url:String(url),cookies:{delete:()=>{}}}) };
    const origFetch=global.fetch; global.fetch=async()=>{fetched=true;throw new Error('no');};
    process.env.APP_URL='https://app.test';
    try {
      const route=loadTs('src/app/api/auth/linkedin/callback/route.ts',{'next/server':{NextRequest:class{},NextResponse},'@/lib/connections':{saveConnection:async()=>{}}});
      const req={nextUrl:new URL('https://app.test/api/auth/linkedin/callback?code=x&state=bad'),cookies:{get:()=>({value:'expected'})}};
      const r=await route.GET(req); assert.match(r.url,/connect=linkedin_error/); assert.strictEqual(fetched,false);
    } finally {global.fetch=origFetch;}
  });

  await test('Post API rejects past schedule and overlong Instagram caption', async () => {
    const NextResponse={ json:(body, init={})=>({body,status:init.status||200}) };
    const route=loadTs('src/app/api/posts/route.ts',{'next/server':{NextResponse}, '@/lib/db':{db:{}}, '@/lib/publish':{publishPost:async()=>({})}, '@/lib/types':{}});
    let req=new Request('http://x/api/posts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({caption:'hello',platforms:['linkedin'],mode:'schedule',scheduledAt:new Date(Date.now()-1000).toISOString()})});
    let r=await route.POST(req); assert.strictEqual(r.status,400); assert.match(r.body.error,/future/);
    req=new Request('http://x/api/posts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({caption:'x'.repeat(2201),mediaUrl:'https://x.test/a.jpg',platforms:['instagram']})});
    r=await route.POST(req); assert.strictEqual(r.status,400); assert.match(r.body.error,/too long/);
  });



  function portalEmployee(overrides={}) {
    return {
      id:'e1',employeeCode:'DC26-DEV-EMP-001',departmentCode:'DEV',accessToken:'tok',name:'Ali',role:'Developer',memberType:'EMPLOYEE',systemRole:'EMPLOYEE',isActive:true,leaveBalance:12,currentStatus:'OFFLINE',statusStartedAt:new Date(),
      events:[],tasks:[],marketingTasks:[],dailyUpdates:[],leaveRequests:[],accessRequests:[],weeklySummaries:[],documents:[],announcementAcks:[],companyNotifications:[],
      ...overrides,
    };
  }

  await test('Employee ID formatter uses DC + year + department + role + sequence', () => {
    const ids=loadTs('src/lib/employee-id.ts');
    assert.strictEqual(ids.formatEmployeeId(new Date('2026-09-01T00:00:00.000Z'),'DEV','EMPLOYEE',1),'DC26-DEV-EMP-001');
    assert.strictEqual(ids.formatEmployeeId(new Date('2026-09-01T00:00:00.000Z'),'AI','INTERN',12),'DC26-AI-INT-012');
  });

  await test('Team API creates employee profile with generated company ID', async () => {
    let created=null;
    const db={employee:{findFirst:async()=>null,create:async({data})=>{created={id:'e1',...data,events:[],tasks:[],dailyUpdates:[],leaveRequests:[],accessRequests:[],weeklySummaries:[],documents:[]};return created;}}};
    const employeeId=loadTs('src/lib/employee-id.ts');
    const route=loadTs('src/app/api/team/route.ts',{'@/lib/db':{db},'@/lib/employee-id':employeeId});
    const req=new Request('http://x/api/team',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Ali Khan',role:'Developer',departmentCode:'DEV',managerName:'Ayesha',joiningDate:'2026-09-01',workStart:'09:00',workEnd:'18:00'})});
    const r=await route.POST(req); const body=await r.json();
    assert.strictEqual(r.status,201); assert.strictEqual(body.name,'Ali Khan'); assert.strictEqual(body.department,'Development'); assert.strictEqual(body.employeeCode,'DC26-DEV-EMP-001'); assert.ok(body.accessToken && body.accessToken.length>=24); assert.ok(body.temporaryPassword && body.temporaryPassword.startsWith('DC-')); assert.ok(created.passwordHash && created.passwordHash.startsWith('scrypt$')); assert.strictEqual(body.passwordHash, undefined);
  });

  await test('Employee password hashing and signed session round-trip', () => {
    process.env.EMPLOYEE_SESSION_SECRET='employee-session-secret-12345678901234567890';
    const auth=loadTs('src/lib/employee-auth.ts');
    const hash=auth.hashEmployeePassword('StrongPass123');
    assert.ok(hash.startsWith('scrypt$'));
    assert.strictEqual(auth.verifyEmployeePassword('StrongPass123',hash),true);
    assert.strictEqual(auth.verifyEmployeePassword('wrong',hash),false);
    const token=auth.createEmployeeSession('e1',2,3600);
    const session=auth.verifyEmployeeSession(token);
    assert.strictEqual(session.employeeId,'e1'); assert.strictEqual(session.version,2);
  });

  await test('Manager can reset employee login password without deleting history', async () => {
    let updateData=null;
    const db={employee:{findUnique:async()=>({id:'e1',employeeCode:'DC26-DEV-EMP-001',name:'Ali'}),update:async({data})=>{updateData=data;return {id:'e1'}}}};
    const route=loadTs('src/app/api/team/[id]/reset-password/route.ts',{'@/lib/db':{db}});
    const r=await route.POST(new Request('http://x/api/team/e1/reset-password',{method:'POST'}),{params:Promise.resolve({id:'e1'})});
    const body=await r.json(); assert.strictEqual(r.status,200); assert.ok(body.temporaryPassword.startsWith('DC-')); assert.ok(updateData.passwordHash.startsWith('scrypt$')); assert.strictEqual(updateData.mustChangePassword,true);
  });

  await test('Team API increments employee ID inside the same department/year/type', async () => {
    const db={employee:{findFirst:async()=>({employeeCode:'DC26-WEB-EMP-007'}),create:async({data})=>({id:'e8',...data,events:[],tasks:[],dailyUpdates:[],leaveRequests:[],accessRequests:[],weeklySummaries:[],documents:[]})}};
    const employeeId=loadTs('src/lib/employee-id.ts');
    const route=loadTs('src/app/api/team/route.ts',{'@/lib/db':{db},'@/lib/employee-id':employeeId});
    const req=new Request('http://x/api/team',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Web Dev',departmentCode:'WEB',joiningDate:'2026-09-02'})});
    const r=await route.POST(req); const body=await r.json(); assert.strictEqual(r.status,201); assert.strictEqual(body.employeeCode,'DC26-WEB-EMP-008');
  });

  await test('Team API creates intern with generated intern ID, mentor and internship dates', async () => {
    const db={employee:{findFirst:async()=>null,create:async({data})=>({id:'i1',...data,events:[],tasks:[],dailyUpdates:[],leaveRequests:[],accessRequests:[],weeklySummaries:[],documents:[]})}};
    const employeeId=loadTs('src/lib/employee-id.ts');
    const route=loadTs('src/app/api/team/route.ts',{'@/lib/db':{db},'@/lib/employee-id':employeeId});
    const req=new Request('http://x/api/team',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Sara Intern',role:'Frontend Intern',departmentCode:'WEB',joiningDate:'2026-09-01',memberType:'INTERN',mentorName:'Ayesha',internshipStart:'2026-09-01',internshipEnd:'2026-12-01'})});
    const r=await route.POST(req); const body=await r.json();
    assert.strictEqual(r.status,201); assert.strictEqual(body.memberType,'INTERN'); assert.strictEqual(body.employeeCode,'DC26-WEB-INT-001'); assert.strictEqual(body.mentorName,'Ayesha');
  });

  await test('Intern creation rejects missing mentor', async () => {
    const db={employee:{findFirst:async()=>null,create:async()=>{throw new Error('should not create')}}};
    const employeeId=loadTs('src/lib/employee-id.ts');
    const route=loadTs('src/app/api/team/route.ts',{'@/lib/db':{db},'@/lib/employee-id':employeeId});
    const req=new Request('http://x/api/team',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Sara',departmentCode:'AI',joiningDate:'2026-09-01',memberType:'INTERN',internshipStart:'2026-09-01',internshipEnd:'2026-12-01'})});
    const r=await route.POST(req); const body=await r.json(); assert.strictEqual(r.status,400); assert.match(body.error,/mentor/i);
  });

  await test('Employee work API requires a task when status is Working', async () => {
    const employee=portalEmployee();
    const db={employee:{findUnique:async()=>employee}};
    const route=loadTs('src/app/api/work/[token]/route.ts',{'@/lib/db':{db}});
    const req=new Request('http://x/api/work/tok',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:'WORKING',task:''})});
    const r=await route.POST(req,{params:Promise.resolve({token:'tok'})}); const body=await r.json();
    assert.strictEqual(r.status,400); assert.match(body.error,/task/i);
  });

  await test('Employee work API updates status and returns portal data', async () => {
    let state=portalEmployee(); let event=null;
    const db={
      employee:{findUnique:async()=>state,update:async({data})=>{state={...state,...data};return state;}},
      workEvent:{create:async({data})=>{event=data;return {id:'w1',...data}}},
      announcement:{findMany:async()=>[]},
      $transaction:async(fn)=>fn({workEvent:{create:async({data})=>{event=data;return {id:'w1',...data}}},employee:{update:async({data})=>{state={...state,...data};return state;}}})
    };
    const route=loadTs('src/app/api/work/[token]/route.ts',{'@/lib/db':{db}});
    const req=new Request('http://x/api/work/tok',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:'WORKING',project:'Website',task:'API integration'})});
    const r=await route.POST(req,{params:Promise.resolve({token:'tok'})}); const body=await r.json();
    assert.strictEqual(r.status,200); assert.strictEqual(body.currentStatus,'WORKING'); assert.strictEqual(event.task,'API integration');
  });

  await test('Employee daily update saves completed work and blocker', async () => {
    let state=portalEmployee(); let saved=null;
    const db={employee:{findUnique:async()=>state,update:async()=>state},dailyUpdate:{create:async({data})=>{saved=data;return {id:'d1',createdAt:new Date(),...data}}},announcement:{findMany:async()=>[]}};
    const route=loadTs('src/app/api/work/[token]/route.ts',{'@/lib/db':{db}});
    const req=new Request('http://x/api/work/tok',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'daily_update',completed:'Finished API',nextPlan:'Testing',blocker:'Waiting for client'})});
    const r=await route.POST(req,{params:Promise.resolve({token:'tok'})});
    assert.strictEqual(r.status,200); assert.strictEqual(saved.completed,'Finished API'); assert.strictEqual(saved.blocker,'Waiting for client');
  });

  await test('One-day leave auto-approves when balance is available', async () => {
    let state=portalEmployee({leaveBalance:5}); let created=null;
    const tx={leaveRequest:{create:async({data})=>{created=data;return {id:'l1',...data}}},employee:{update:async({data})=>{state={...state,...data};return state;}}};
    const db={employee:{findUnique:async()=>state},announcement:{findMany:async()=>[]},$transaction:async(fn)=>fn(tx)};
    const route=loadTs('src/app/api/work/[token]/route.ts',{'@/lib/db':{db}});
    const req=new Request('http://x/api/work/tok',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'leave_request',startDate:'2026-10-01',endDate:'2026-10-01',reason:'Personal'})});
    const r=await route.POST(req,{params:Promise.resolve({token:'tok'})});
    assert.strictEqual(r.status,200); assert.strictEqual(created.status,'APPROVED'); assert.strictEqual(created.autoApproved,true); assert.strictEqual(state.leaveBalance,4);
  });

  await test('Access request is saved for manager approval', async () => {
    const state=portalEmployee(); let created=null;
    const db={employee:{findUnique:async()=>state},accessRequest:{create:async({data})=>{created=data;return {id:'a1',...data}}},announcement:{findMany:async()=>[]}};
    const route=loadTs('src/app/api/work/[token]/route.ts',{'@/lib/db':{db}});
    const req=new Request('http://x/api/work/tok',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'access_request',resource:'GitHub Project ABC',reason:'Assigned task'})});
    const r=await route.POST(req,{params:Promise.resolve({token:'tok'})}); assert.strictEqual(r.status,200); assert.strictEqual(created.resource,'GitHub Project ABC');
  });

  await test('Manager can assign a task with priority and deadline', async () => {
    let created=null;
    const db={employee:{findUnique:async()=>({id:'e1'})},employeeTask:{create:async({data})=>{created=data;return {id:'t1',...data}}}};
    const route=loadTs('src/app/api/team/[id]/tasks/route.ts',{'@/lib/db':{db}});
    const req=new Request('http://x/api/team/e1/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Build API',project:'Website',priority:'HIGH',deadline:'2026-10-01T10:00:00.000Z'})});
    const r=await route.POST(req,{params:Promise.resolve({id:'e1'})}); assert.strictEqual(r.status,201); assert.strictEqual(created.priority,'HIGH');
  });

  await test('Manager leave approval decrements leave balance', async () => {
    const leave={id:'l1',employeeId:'e1',days:2,status:'PENDING',startDate:new Date('2026-10-10T00:00:00Z'),endDate:new Date('2026-10-11T00:00:00Z'),employee:{leaveBalance:5}};
    let balance=null, status=null;
    const tx={leaveRequest:{update:async({data})=>{status=data.status;return {...leave,...data}}},employee:{update:async({data})=>{balance=data.leaveBalance;return {id:'e1',...data}}}};
    const db={leaveRequest:{findUnique:async()=>leave},$transaction:async(fn)=>fn(tx)};
    const route=loadTs('src/app/api/team/leave/[id]/route.ts',{'@/lib/db':{db}});
    const req=new Request('http://x/api/team/leave/l1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'approve'})});
    const r=await route.POST(req,{params:Promise.resolve({id:'l1'})}); assert.strictEqual(r.status,200); assert.strictEqual(status,'APPROVED'); assert.strictEqual(balance,3);
  });

  await test('Manager can approve an access request', async () => {
    let status=null;
    const db={accessRequest:{findUnique:async()=>({id:'a1',status:'PENDING'}),update:async({data})=>{status=data.status;return {id:'a1',...data}}}};
    const route=loadTs('src/app/api/team/access/[id]/route.ts',{'@/lib/db':{db}});
    const req=new Request('http://x/api/team/access/a1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'approve'})});
    const r=await route.POST(req,{params:Promise.resolve({id:'a1'})}); assert.strictEqual(r.status,200); assert.strictEqual(status,'APPROVED');
  });

  await test('Employee can acknowledge a company announcement', async () => {
    const state=portalEmployee(); let ack=null;
    const db={employee:{findUnique:async()=>state},announcement:{findUnique:async()=>({id:'n1'}),findMany:async()=>[{id:'n1',title:'Policy',body:'Read this',createdAt:new Date()}]},announcementAck:{upsert:async({create})=>{ack=create;return {id:'ack1',...create}}}};
    const route=loadTs('src/app/api/work/[token]/route.ts',{'@/lib/db':{db}});
    const req=new Request('http://x/api/work/tok',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'ack_announcement',announcementId:'n1'})});
    const r=await route.POST(req,{params:Promise.resolve({token:'tok'})}); assert.strictEqual(r.status,200); assert.strictEqual(ack.employeeId,'e1');
  });

  await test('Manager reminder API queues reminder for employee portal', async () => {
    let updateData=null; const db={employee:{update:async({data})=>{updateData=data;return {id:'e1',...data}}}};
    const route=loadTs('src/app/api/team/[id]/remind/route.ts',{'@/lib/db':{db}});
    const req=new Request('http://x/api/team/e1/remind',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'Update your task.'})});
    const r=await route.POST(req,{params:Promise.resolve({id:'e1'})}); const body=await r.json(); assert.strictEqual(r.status,200); assert.strictEqual(body.ok,true); assert.strictEqual(updateData.pendingReminderText,'Update your task.');
  });

  await test('Team agent queues stale-work reminder', async () => {
    const updates=[]; let call=0;
    const db={employee:{findMany:async()=>{call++; return call===1 ? [{id:'e1',name:'Ali',lastReminderAt:null}] : [];},update:async({where,data})=>{updates.push({where,data});return {id:where.id,...data};}}};
    const mod=loadTs('src/lib/team-agent.ts',{'./db':{db}}); const out=await mod.processStaleEmployeeReminders();
    assert.strictEqual(out.length,1); assert.strictEqual(out[0].reason,'stale_work'); assert.match(updates[0].data.pendingReminderText,/marked Working/i);
  });

  await test('Team agent reminds intern when weekly progress is overdue', async () => {
    const updates=[]; let call=0; const now=Date.now();
    const intern={id:'i1',name:'Sara',memberType:'INTERN',timezone:'Asia/Karachi',internshipStart:new Date(now-14*86400000),internshipEnd:new Date(now+30*86400000),weeklyProgressAt:new Date(now-8*86400000),lastReminderAt:null,lastDailyUpdateReminderAt:null,currentStatus:'WORKING',dailyUpdates:[{createdAt:new Date()}],leaveRequests:[],tasks:[]};
    const db={employee:{findMany:async()=>{call++;return call===1?[]:[intern]},update:async({where,data})=>{updates.push({where,data});return {id:where.id,...data};}},$transaction:async()=>{}};
    const mod=loadTs('src/lib/team-agent.ts',{'./db':{db}}); const out=await mod.processStaleEmployeeReminders();
    assert.strictEqual(out.length,1); assert.strictEqual(out[0].reason,'intern_weekly_progress'); assert.match(updates[0].data.pendingReminderText,/weekly internship progress/i);
  });


  await test('Marketing caption adapter prepares all three platform versions', () => {
    const mod=loadTs('src/lib/marketing-agent.ts',{'./db':{db:{}}});
    const out=mod.adaptMarketingCaption('Build smarter AI automation for your team','Book a consultation');
    assert.match(out.linkedin,/Book a consultation/); assert.match(out.instagram,/#automation/i); assert.ok(out.facebook.length>10);
  });

  await test('Marketing API creates assigned task with selected channels', async () => {
    let created=null;
    const db={marketingCampaign:{findUnique:async()=>({id:'c1'})},employee:{findUnique:async()=>({id:'e1'})},marketingTask:{create:async({data})=>{created=data;return {id:'m1',...data}}}};
    const route=loadTs('src/app/api/marketing/route.ts',{'@/lib/db':{db},'@/lib/marketing-agent':{adaptMarketingCaption:(x)=>({linkedin:x,instagram:x,facebook:x}),normalizeMarketingPlatforms:(x)=>x},'@/lib/publish':{publishPost:async()=>({status:'PUBLISHED'})}});
    const req=new Request('http://x/api/marketing',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'create_task',campaignId:'c1',employeeId:'e1',title:'Launch post',platforms:['linkedin','instagram'],autoPublish:true})});
    const r=await route.POST(req); assert.strictEqual(r.status,201); assert.deepStrictEqual(created.platforms,['linkedin','instagram']); assert.strictEqual(created.employeeId,'e1');
  });

  await test('Marketing draft submission creates platform captions and review status', async () => {
    let updated=null;
    const task={id:'m1',campaign:{goal:'Book a call'}};
    const db={marketingTask:{findUnique:async()=>task,update:async({data})=>{updated=data;return {...task,...data}}}};
    const route=loadTs('src/app/api/marketing/route.ts',{'@/lib/db':{db},'@/lib/marketing-agent':{adaptMarketingCaption:(x,g)=>({linkedin:x+' '+g,instagram:x,facebook:x}),normalizeMarketingPlatforms:(x)=>x},'@/lib/publish':{publishPost:async()=>({status:'PUBLISHED'})}});
    const req=new Request('http://x/api/marketing',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'submit_draft',taskId:'m1',masterCaption:'Master copy'})});
    const r=await route.POST(req); assert.strictEqual(r.status,200); assert.strictEqual(updated.status,'REVIEW'); assert.match(updated.adaptedCaptions.linkedin,/Book a call/);
  });

  await test('Marketing approval with future publish time schedules Post automatically', async () => {
    const future=new Date(Date.now()+3600000); let postCreated=null, taskUpdate=null, publishCalls=0;
    const task={id:'m1',status:'REVIEW',platforms:['linkedin','facebook'],adaptedCaptions:{linkedin:'LI',facebook:'FB'},masterCaption:'Master',mediaUrl:null,autoPublish:true,publishAt:future,campaign:{goal:null},post:null};
    const db={marketingTask:{findUnique:async()=>task,update:async({data})=>{taskUpdate=data;return {...task,...data}}},post:{create:async({data})=>{postCreated={id:'p1',...data};return postCreated}}};
    const route=loadTs('src/app/api/marketing/route.ts',{'@/lib/db':{db},'@/lib/marketing-agent':{adaptMarketingCaption:(x)=>({linkedin:x,instagram:x,facebook:x}),normalizeMarketingPlatforms:(x)=>x},'@/lib/publish':{publishPost:async()=>{publishCalls++;return {status:'PUBLISHED'}}}});
    const req=new Request('http://x/api/marketing',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'approve',taskId:'m1'})});
    const r=await route.POST(req); const body=await r.json(); assert.strictEqual(r.status,200); assert.strictEqual(body.status,'SCHEDULED'); assert.strictEqual(publishCalls,0); assert.strictEqual(taskUpdate.status,'SCHEDULED'); assert.strictEqual(postCreated.platformCaptions.linkedin,'LI');
  });

  await test('Employee can submit assigned marketing draft for manager review', async () => {
    let marketingUpdate=null; const employee=portalEmployee({marketingTasks:[]});
    const marketingTask={id:'mt1',employeeId:'e1',status:'IN_PROGRESS',campaign:{goal:'Request a demo'}};
    const db={employee:{findUnique:async()=>employee,update:async()=>employee},marketingTask:{findFirst:async()=>marketingTask,update:async({data})=>{marketingUpdate=data;return {...marketingTask,...data}}},announcement:{findMany:async()=>[]}};
    const route=loadTs('src/app/api/work/[token]/route.ts',{'@/lib/db':{db},'@/lib/marketing-agent':{adaptMarketingCaption:(x,g)=>({linkedin:x+' '+g,instagram:x,facebook:x})}});
    const req=new Request('http://x/api/work/tok',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'marketing_draft',taskId:'mt1',masterCaption:'Campaign copy'})});
    const r=await route.POST(req,{params:Promise.resolve({token:'tok'})}); assert.strictEqual(r.status,200); assert.strictEqual(marketingUpdate.status,'REVIEW'); assert.match(marketingUpdate.adaptedCaptions.linkedin,/Request a demo/);
  });


  await test('Company admin can assign a role-based dashboard position', async () => {
    let updated=null;
    const db={employee:{update:async({where,data})=>{updated={id:where.id,...data};return updated}}};
    const route=loadTs('src/app/api/company/route.ts',{'@/lib/db':{db}});
    const req=new Request('http://x/api/company',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'assign_company_role',employeeId:'e1',role:'TEAM_LEAD'})});
    const r=await route.POST(req); const body=await r.json(); assert.strictEqual(r.status,200); assert.strictEqual(body.systemRole,'TEAM_LEAD');
  });

  await test('Company admin creates project with generated DC project code and Team Lead', async () => {
    let created=null; const members=[];
    const project={findFirst:async()=>null,create:async({data})=>{created={id:'p1',...data};return created},findUnique:async()=>({...created,manager:null,lead:null,members:[],milestones:[],tasks:[],files:[]})};
    const db={project,projectMember:{upsert:async({create})=>{members.push(create);return create}}};
    const route=loadTs('src/app/api/company/route.ts',{'@/lib/db':{db}});
    const req=new Request('http://x/api/company',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'create_project',name:'Client Website',clientName:'ABC',managerId:'pm1',leadId:'lead1',deadline:'2026-12-01'})});
    const r=await route.POST(req); const body=await r.json(); assert.strictEqual(r.status,201); assert.match(body.code,/^DC\d{2}-PRJ-001$/); assert.strictEqual(created.leadId,'lead1'); assert.ok(members.some(m=>m.employeeId==='lead1'&&m.role==='TEAM_LEAD'));
  });

  await test('Employee project submission creates versioned proof and moves task to review', async () => {
    let submission=null,taskStatus=null; const employee=portalEmployee();
    const projectTask={id:'pt1',assigneeId:'e1',title:'Homepage',project:{id:'p1',code:'DC26-PRJ-001',name:'Website',leadId:'lead1'},submissions:[{version:1}]};
    const tx={taskSubmission:{create:async({data})=>{submission=data;return {id:'s2',...data}}},projectTask:{update:async({data})=>{taskStatus=data.status;return {...projectTask,...data}}},companyNotification:{create:async()=>({id:'n1'})}};
    const db={employee:{findUnique:async()=>employee},projectTask:{findFirst:async()=>projectTask},announcement:{findMany:async()=>[]},$transaction:async(fn)=>fn(tx)};
    const route=loadTs('src/app/api/work/[token]/route.ts',{'@/lib/db':{db}});
    const req=new Request('http://x/api/work/tok',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'task_submission',taskId:'pt1',summary:'Completed responsive homepage',previewUrl:'https://preview.test'})});
    const r=await route.POST(req,{params:Promise.resolve({token:'tok'})}); assert.strictEqual(r.status,200); assert.strictEqual(submission.version,2); assert.strictEqual(taskStatus,'REVIEW'); assert.strictEqual(submission.previewUrl,'https://preview.test');
  });

  await test('Team Lead can approve project proof and forward it to Project Manager queue', async () => {
    const employee=portalEmployee({systemRole:'TEAM_LEAD'}); let submissionStatus=null,taskStatus=null,notification=null;
    const submission={id:'s1',authorId:'e2',documentUrl:null,taskId:'pt1',task:{id:'pt1',title:'API integration',project:{id:'p1',leadId:'e1',managerId:'pm1'}}};
    const db={employee:{findUnique:async()=>employee},taskSubmission:{findUnique:async()=>submission,update:async({data})=>{submissionStatus=data.status;return {...submission,...data}}},projectTask:{update:async({data})=>{taskStatus=data.status;return {id:'pt1',...data}}},companyNotification:{create:async({data})=>{notification=data;return {id:'n1',...data}}},announcement:{findMany:async()=>[]},$transaction:async(items)=>Promise.all(items)};
    const route=loadTs('src/app/api/work/[token]/route.ts',{'@/lib/db':{db}});
    const req=new Request('http://x/api/work/tok',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'review_submission',submissionId:'s1',decision:'approve'})});
    const r=await route.POST(req,{params:Promise.resolve({token:'tok'})}); assert.strictEqual(r.status,200); assert.strictEqual(submissionStatus,'APPROVED'); assert.strictEqual(taskStatus,'APPROVED'); assert.strictEqual(notification.employeeId,'e2');
  });

  await test('Finance API creates numbered invoice for payment tracking', async () => {
    let created=null;
    const db={invoice:{findFirst:async()=>({invoiceNo:'DC-INV-2026-004'}),create:async({data})=>{created=data;return {id:'inv5',...data}}}};
    const route=loadTs('src/app/api/company/route.ts',{'@/lib/db':{db}});
    const req=new Request('http://x/api/company',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'create_invoice',clientName:'ABC Ltd',amount:2500,dueDate:'2026-10-15'})});
    const r=await route.POST(req); const body=await r.json(); assert.strictEqual(r.status,201); assert.match(body.invoiceNo,/DC-INV-\d{4}-005/); assert.strictEqual(created.status,'SENT');
  });

  await test('Project Operations AI Agent uses live project tool data before answering', async () => {
    process.env.GEMINI_API_KEY='test-key';
    process.env.GEMINI_AGENT_MODEL='gemini-2.5-flash-lite';
    const db={
      project:{
        findFirst:async()=>({id:'p1',code:'DC26-PRJ-001',name:'ABC Website'}),
        findUnique:async()=>({
          id:'p1',code:'DC26-PRJ-001',name:'ABC Website',clientName:'ABC',status:'ACTIVE',priority:'HIGH',deadline:new Date('2026-10-01T00:00:00Z'),
          manager:{name:'Ayesha',employeeCode:'DC26-OPS-EMP-001'},lead:{name:'Ali',employeeCode:'DC26-DEV-EMP-001'},
          members:[{role:'TEAM_LEAD',employee:{name:'Ali',employeeCode:'DC26-DEV-EMP-001',currentStatus:'WORKING'}}],
          milestones:[{title:'Frontend',status:'IN_PROGRESS',dueAt:new Date('2026-09-28T00:00:00Z'),sortOrder:0,createdAt:new Date()}],
          tasks:[{title:'Homepage',status:'IN_PROGRESS',priority:'HIGH',dueAt:new Date('2026-09-25T00:00:00Z'),assignee:{name:'Sara',employeeCode:'DC26-WEB-EMP-001'},submissions:[],createdAt:new Date()}],
        }),
      }
    };
    const originalFetch=global.fetch; let calls=0;
    global.fetch=async()=>{calls++; return jsonResponse(calls===1?{candidates:[{content:{role:'model',parts:[{functionCall:{name:'get_project_status',args:{query:'ABC Website'}}}]}}]}:{candidates:[{content:{role:'model',parts:[{text:'ABC Website active hai aur Homepage in progress hai.'}]}}]});};
    try{
      const mod=loadTs('src/lib/company-ai-agent.ts',{'./db':{db}});
      const out=await mod.runCompanyAiAgent('ABC Website ka status batao');
      assert.strictEqual(calls,2); assert.match(out.text,/ABC Website/); assert.strictEqual(out.tools[0].name,'get_project_status');
    } finally { global.fetch=originalFetch; }
  });

  await test('Founder employee query returns structured live profile focus for the voice UI', async () => {
    process.env.GEMINI_API_KEY='test-key';
    const employee={id:'e1',employeeCode:'DC26-WEB-EMP-001',name:'Ali Raza',role:'Software Developer',department:'Web Development',profileImageUrl:null,currentStatus:'WORKING',currentProject:'E-Commerce Website',currentTask:'Web pages design',statusStartedAt:new Date('2026-09-20T10:20:00Z'),lastSeenAt:new Date('2026-09-20T11:00:00Z')};
    const db={
      employee:{findFirst:async()=>employee,findUnique:async()=>employee,findMany:async()=>[]},
      projectTask:{findMany:async()=>[{id:'pt1',title:'Web pages design',status:'IN_PROGRESS',priority:'HIGH',dueAt:new Date('2026-09-21T00:00:00Z'),createdAt:new Date(),project:{code:'DC26-PRJ-001',name:'E-Commerce Website',lead:{name:'Sara Lead'}},submissions:[{screenshotUrl:'https://example.com/work.png',createdAt:new Date('2026-09-20T10:55:00Z')}]}]},
      dailyUpdate:{findFirst:async()=>({completed:'Homepage aur service pages ka design work in progress hai.',nextPlan:'Responsive states',blocker:null,createdAt:new Date('2026-09-20T10:58:00Z')})},
    };
    const originalFetch=global.fetch; let calls=0;
    global.fetch=async()=>{calls++; return jsonResponse(calls===1?{candidates:[{content:{role:'model',parts:[{functionCall:{name:'get_employee_workload',args:{employee_query:'Ali'}}}]}}]}:{candidates:[{content:{role:'model',parts:[{text:'Ali E-Commerce Website par web pages design kar raha hai.'}]}}]});};
    try{
      const mod=loadTs('src/lib/company-ai-agent.ts',{'./db':{db}});
      const out=await mod.runCompanyAiAgent('Ali ko kya task diya hai?');
      assert.strictEqual(out.focus.name,'Ali Raza'); assert.strictEqual(out.focus.currentTask,'Web pages design'); assert.strictEqual(out.focus.status,'WORKING'); assert.strictEqual(out.focus.screenshots.length,1); assert.strictEqual(out.focus.teamLead,'Sara Lead');
    } finally { global.fetch=originalFetch; }
  });

  await test('Project Operations AI Agent can send an explicit employee reminder', async () => {
    process.env.GEMINI_API_KEY='test-key'; let notification=null;
    const db={
      employee:{findFirst:async()=>({id:'e1',employeeCode:'DC26-WEB-EMP-001',name:'Sara',department:'Web Development',systemRole:'EMPLOYEE',currentStatus:'WORKING',currentProject:'ABC Website',currentTask:'Homepage'})},
      companyNotification:{create:async({data})=>{notification=data;return {id:'n1',...data}}},
    };
    const originalFetch=global.fetch; let calls=0;
    global.fetch=async()=>{calls++; return jsonResponse(calls===1?{candidates:[{content:{role:'model',parts:[{functionCall:{name:'send_internal_reminder',args:{employee_query:'Sara',message:'Homepage ka latest update share karein.',project_query:null}}}]}}]}:{candidates:[{content:{role:'model',parts:[{text:'Sara ko reminder bhej diya hai.'}]}}]});};
    try{
      const mod=loadTs('src/lib/company-ai-agent.ts',{'./db':{db}});
      const out=await mod.runCompanyAiAgent('Sara ko homepage update ka reminder bhejo');
      assert.strictEqual(notification.employeeId,'e1'); assert.strictEqual(notification.kind,'AI_AGENT_REMINDER'); assert.match(out.text,/reminder/i);
    } finally { global.fetch=originalFetch; }
  });

  await test('Tracked work timer excludes Break and Away time', async () => {
    const events=[
      {status:'WORKING',createdAt:new Date('2026-09-20T10:00:00Z')},
      {status:'BREAK',createdAt:new Date('2026-09-20T10:30:00Z')},
      {status:'WORKING',createdAt:new Date('2026-09-20T10:40:00Z')},
      {status:'AWAY',createdAt:new Date('2026-09-20T11:00:00Z')},
      {status:'WORKING',createdAt:new Date('2026-09-20T11:10:00Z')},
    ];
    const db={workEvent:{findMany:async()=>events}};
    const mod=loadTs('src/lib/tracker-time.ts',{'@/lib/db':{db}});
    const ms=await mod.trackedWorkMsForSession({employeeId:'e1',startedAt:new Date('2026-09-20T10:00:00Z'),endedAt:null},new Date('2026-09-20T11:20:00Z'));
    assert.strictEqual(ms,60*60*1000);
  });

  await test('Tracker login returns revocable bearer token and 4-10 minute policy', async () => {
    const auth=loadTs('src/lib/employee-auth.ts');
    const employee={id:'e1',employeeCode:'DC26-WEB-EMP-001',name:'Ali Raza',role:'Developer',department:'Web',isActive:true,passwordHash:auth.hashEmployeePassword('Pass123!')};
    const db={employee:{findUnique:async()=>employee}};
    const route=loadTs('src/app/api/tracker/auth/route.ts',{
      '@/lib/db':{db},
      '@/lib/employee-auth':auth,
      '@/lib/tracker-auth':{issueTrackerToken:async()=>({token:'dct_test',expiresAt:new Date('2026-10-20T00:00:00Z')}),authenticateTrackerRequest:async()=>null,revokeTrackerToken:async()=>true},
    });
    const req=new Request('http://x/api/tracker/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({employeeCode:'DC26-WEB-EMP-001',password:'Pass123!',deviceName:'Ali Laptop',platform:'win32'})});
    const r=await route.POST(req); const body=await r.json(); assert.strictEqual(r.status,200); assert.strictEqual(body.token,'dct_test'); assert.deepStrictEqual(body.policy.screenshotIntervalMinutes,{min:4,max:10}); assert.strictEqual(body.policy.visibleTrackingRequired,true); assert.strictEqual(body.policy.captureScope,'all-displays'); assert.strictEqual(body.policy.automaticUpload,true); assert.strictEqual(body.policy.employeeCanDeleteOrEdit,false);
  });

  await test('Tracker Start Work requires visible tracking acknowledgement', async () => {
    const route=loadTs('src/app/api/tracker/session/route.ts',{
      '@/lib/db':{db:{}},
      '@/lib/tracker-auth':{authenticateTrackerRequest:async()=>({employee:{id:'e1'},token:{platform:'win32',deviceName:'Laptop'}})},
      '@/lib/tracker-time':{trackedWorkMsForSession:async()=>0},
    });
    const req=new Request('http://x/api/tracker/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:'pt1',consentAcknowledged:false})});
    const r=await route.POST(req); const body=await r.json(); assert.strictEqual(r.status,400); assert.match(body.error,/consent/i);
  });

  await test('Tracker Start Work creates live session and updates Team Live fields', async () => {
    let sessionData=null, employeeData=null, eventData=null;
    const task={id:'pt1',projectId:'p1',title:'Homepage UI',project:{id:'p1',name:'ABC Website'}};
    const tx={
      workSession:{create:async({data})=>{sessionData=data;return {id:'ws1',...data,project:{id:'p1',code:'DC26-PRJ-001',name:'ABC Website'},task:{id:'pt1',title:'Homepage UI',status:'IN_PROGRESS',dueAt:null}}}},
      employee:{update:async({data})=>{employeeData=data;return {id:'e1',...data}}},
      workEvent:{create:async({data})=>{eventData=data;return {id:'we1',...data}}},
    };
    const db={
      workSession:{findFirst:async()=>null},
      workScreenshot:{count:async()=>0},
      projectTask:{findFirst:async()=>task},
      $transaction:async(fn)=>fn(tx),
    };
    const route=loadTs('src/app/api/tracker/session/route.ts',{
      '@/lib/db':{db},
      '@/lib/tracker-auth':{authenticateTrackerRequest:async()=>({employee:{id:'e1'},token:{platform:'win32',deviceName:'Laptop'}})},
      '@/lib/tracker-time':{trackedWorkMsForSession:async()=>0},
    });
    const req=new Request('http://x/api/tracker/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:'pt1',consentAcknowledged:true,trackerVersion:'1.0.0'})});
    const r=await route.POST(req); assert.strictEqual(r.status,201); assert.strictEqual(sessionData.trackingEnabled,true); assert.strictEqual(employeeData.currentStatus,'WORKING'); assert.strictEqual(employeeData.currentProject,'ABC Website'); assert.strictEqual(employeeData.currentTask,'Homepage UI'); assert.strictEqual(eventData.status,'WORKING');
  });

  await test('Screenshot backend refuses capture when employee is not Working', async () => {
    const db={workSession:{findFirst:async()=>({id:'ws1',employeeId:'e1',endedAt:null,status:'BREAK',trackingEnabled:false})}};
    const route=loadTs('src/app/api/tracker/screenshots/route.ts',{
      '@/lib/screenshot-storage':{storeWorkScreenshot:async()=>{throw new Error('must not upload')}},
      '@/lib/db':{db},
      '@/lib/tracker-auth':{authenticateTrackerRequest:async()=>({employee:{id:'e1',employeeCode:'DC26-WEB-EMP-001'}})},
      '@/lib/tracker-time':{wasSessionWorkingAt:async()=>false},
    });
    const form=new FormData(); form.set('sessionId','ws1'); form.set('screenshot',new File([new Uint8Array([1,2,3])],'shot.png',{type:'image/png'}));
    const r=await route.POST(new Request('http://x/api/tracker/screenshots',{method:'POST',body:form})); const body=await r.json(); assert.strictEqual(r.status,409); assert.match(body.error,/Working/i);
  });


  await test('Queued screenshot uploads after session end when it was captured during Working', async () => {
    let createdData=null;
    const startedAt=new Date('2026-09-20T10:00:00Z');
    const endedAt=new Date('2026-09-20T11:00:00Z');
    const db={
      workSession:{findFirst:async()=>({id:'ws1',employeeId:'e1',startedAt,endedAt,status:'OFFLINE',trackingEnabled:false}),update:async()=>({})},
      workScreenshot:{findFirst:async()=>null,create:async({data})=>{createdData=data;return {id:'shot1',...data}}},
      employee:{update:async()=>({})},
      $transaction:async(fn)=>fn({workScreenshot:{create:async({data})=>{createdData=data;return {id:'shot1',...data}}},workSession:{update:async()=>({})},employee:{update:async()=>({})}}),
    };
    const route=loadTs('src/app/api/tracker/screenshots/route.ts',{
      '@/lib/screenshot-storage':{storeWorkScreenshot:async(path)=>({url:'private://shot',pathname:path})},
      '@/lib/db':{db},
      '@/lib/tracker-auth':{authenticateTrackerRequest:async()=>({employee:{id:'e1',employeeCode:'DC26-WEB-EMP-001'}})},
      '@/lib/tracker-time':{wasSessionWorkingAt:async()=>true},
    });
    const form=new FormData(); form.set('sessionId','ws1'); form.set('captureId','capture-12345678'); form.set('displayId','display-1'); form.set('capturedAt','2026-09-20T10:30:00Z'); form.set('width','1600'); form.set('height','900'); form.set('screenshot',new File([new Uint8Array([1,2,3])],'shot.jpg',{type:'image/jpeg'}));
    const r=await route.POST(new Request('http://x/api/tracker/screenshots',{method:'POST',body:form})); const body=await r.json(); assert.strictEqual(r.status,201); assert.strictEqual(body.screenshot.id,'shot1'); assert.strictEqual(createdData.sessionId,'ws1'); assert.strictEqual(new Date(createdData.capturedAt).toISOString(),'2026-09-20T10:30:00.000Z');
  });

  await test('Screenshot retry is idempotent and does not create duplicate rows', async () => {
    const existing={id:'shot-existing',sessionId:'ws1',storagePath:'work-screenshots/DC26-WEB-EMP-001/ws1/capture-12345678-display-1.jpg',capturedAt:new Date('2026-09-20T10:30:00Z'),width:1600,height:900,fileSize:3};
    const db={workSession:{findFirst:async()=>({id:'ws1',employeeId:'e1',startedAt:new Date('2026-09-20T10:00:00Z'),endedAt:null,status:'WORKING',trackingEnabled:true})},workScreenshot:{findFirst:async()=>existing}};
    const route=loadTs('src/app/api/tracker/screenshots/route.ts',{
      '@/lib/screenshot-storage':{storeWorkScreenshot:async()=>{throw new Error('duplicate retry must not upload again')}},
      '@/lib/db':{db},
      '@/lib/tracker-auth':{authenticateTrackerRequest:async()=>({employee:{id:'e1',employeeCode:'DC26-WEB-EMP-001'}})},
      '@/lib/tracker-time':{wasSessionWorkingAt:async()=>true},
    });
    const form=new FormData(); form.set('sessionId','ws1'); form.set('captureId','capture-12345678'); form.set('displayId','display-1'); form.set('capturedAt','2026-09-20T10:30:00Z'); form.set('width','1600'); form.set('height','900'); form.set('screenshot',new File([new Uint8Array([1,2,3])],'shot.jpg',{type:'image/jpeg'}));
    const r=await route.POST(new Request('http://x/api/tracker/screenshots',{method:'POST',body:form})); const body=await r.json(); assert.strictEqual(r.status,200); assert.strictEqual(body.duplicate,true); assert.strictEqual(body.screenshot.id,'shot-existing');
  });

  await test('Company Agent can read official DeepCiphers company knowledge', async () => {
    process.env.GEMINI_API_KEY='test-key';
    const db={
      companyProfile:{findUnique:async()=>({id:'deepciphers',name:'DeepCiphers',tagline:'Unlocking the digital possibilities',services:['Web Development','AI Automation'],departments:['Development','AI']})},
      companyKnowledgeItem:{findMany:async()=>[{category:'Policy',title:'Remote Work',content:'DeepCiphers operates remotely.'}]},
    };
    const originalFetch=global.fetch; let calls=0;
    global.fetch=async()=>{calls++; return jsonResponse(calls===1?{candidates:[{content:{role:'model',parts:[{functionCall:{name:'get_company_profile',args:{}}}]}}]}:{candidates:[{content:{role:'model',parts:[{text:'DeepCiphers remote software aur AI company hai.'}]}}]});};
    try{
      const mod=loadTs('src/lib/company-ai-agent.ts',{'./db':{db}});
      const out=await mod.runCompanyAiAgent('DeepCiphers kya company hai?');
      assert.strictEqual(out.tools[0].name,'get_company_profile'); assert.match(out.text,/DeepCiphers/);
    } finally { global.fetch=originalFetch; }
  });

  await test('Persistent Agent memory falls back to CompanyAgentRun when knowledge table is unavailable', async () => {
    let created=null;
    const db={
      companyKnowledgeItem:{findFirst:async()=>{throw new Error('missing table')},create:async()=>{throw new Error('missing table')}},
      companyAgentRun:{create:async({data})=>{created={id:'mem1',...data};return created}},
    };
    const mod=loadTs('src/lib/agent-memory.ts',{'./db':{db}});
    const out=await mod.rememberCompanyInformation('Client preference','Acme prefers weekly Friday updates.','Client');
    assert.strictEqual(out.ok,true); assert.strictEqual(out.remembered.storage,'agent_run'); assert.strictEqual(created.status,'MEMORY'); assert.match(created.output,/Friday/);
  });

  await test('Persistent Agent context recalls relevant prior successful conversations across sessions', async () => {
    const now=new Date();
    const db={
      companyAgentRun:{findMany:async({where})=>where.status==='COMPLETED'?[{input:'Acme project launch color is navy',output:'Noted for the Acme launch.',createdAt:now}]:[]},
      companyKnowledgeItem:{findMany:async()=>[]},
    };
    const mod=loadTs('src/lib/agent-memory.ts',{'./db':{db}});
    const context=await mod.buildAgentMemoryContext('What did we decide about Acme launch color?');
    assert.match(context,/Acme project launch color is navy/); assert.match(context,/RELEVANT PRIOR ADMIN CONVERSATIONS/);
  });

  await test('Agent URL reader blocks localhost/private targets before fetching', async () => {
    const db={};
    const mod=loadTs('src/lib/agent-memory.ts',{'./db':{db}});
    await assert.rejects(()=>mod.readPublicWebSource('http://127.0.0.1:3000/private'),/private|local/i);
  });

  await test('Company Agent automatically injects relevant long-term conversation memory into Gemini context', async () => {
    process.env.GEMINI_API_KEY='test-key';
    const db={
      companyAgentRun:{findMany:async({where})=>where.status==='COMPLETED'?[{input:'Client Orion prefers a Monday status report',output:'Saved context for Orion.',createdAt:new Date()}]:[]},
      companyKnowledgeItem:{findMany:async()=>[]},
    };
    const originalFetch=global.fetch; let requestBody=null;
    global.fetch=async(_url,init={})=>{requestBody=JSON.parse(init.body);return jsonResponse({candidates:[{content:{role:'model',parts:[{text:'Orion prefers a Monday status report.'}]}}]});};
    try{
      const mod=loadTs('src/lib/company-ai-agent.ts',{'./db':{db}});
      const out=await mod.runCompanyAiAgent('Orion ka status report kab hota hai?');
      assert.match(out.text,/Monday/); assert.match(JSON.stringify(requestBody),/Monday status report/);
    } finally { global.fetch=originalFetch; }
  });


  await test('Company Agent approves an explicitly requested pending leave through dashboard automation', async () => {
    process.env.GEMINI_API_KEY='test-key';
    const employee={id:'e1',employeeCode:'DC26-WEB-EMP-001',name:'Sara',department:'Web Development',systemRole:'EMPLOYEE',currentStatus:'OFFLINE',currentProject:null,currentTask:null,leaveBalance:12};
    let leaveStatus='PENDING', employeeUpdate=null;
    const leave={id:'l1',employeeId:'e1',startDate:new Date('2026-10-01T00:00:00Z'),endDate:new Date('2026-10-02T00:00:00Z'),days:2,reason:'Personal',status:'PENDING',employee};
    const db={
      employee:{findFirst:async()=>employee},
      leaveRequest:{findMany:async()=>[leave]},
      $transaction:async(fn)=>fn({
        leaveRequest:{update:async()=>{leaveStatus='APPROVED';return {...leave,status:'APPROVED'}}},
        employee:{update:async({data})=>{employeeUpdate=data;return {}}},
      }),
    };
    const originalFetch=global.fetch; let calls=0;
    global.fetch=async()=>jsonResponse(++calls===1?{candidates:[{content:{role:'model',parts:[{functionCall:{name:'resolve_leave_request',args:{action:'approve',employee_query:'Sara'}}}]}}]}:{candidates:[{content:{role:'model',parts:[{text:'Sara ki leave approve kar di hai.'}]}}]});
    try{
      const mod=loadTs('src/lib/company-ai-agent.ts',{'./db':{db},'./agent-memory':{buildAgentMemoryContext:async()=>'',getRecentCompanyUpdates:async()=>[],rememberCompanyInformation:async()=>({}),rememberUrlSource:async()=>({})}});
      const out=await mod.runCompanyAiAgent('Sara ki pending leave approve kar do');
      assert.strictEqual(out.tools[0].name,'resolve_leave_request'); assert.strictEqual(leaveStatus,'APPROVED'); assert.ok(employeeUpdate);
    } finally { global.fetch=originalFetch; }
  });

  await test('Company Agent publishes an announcement directly from an Admin command', async () => {
    process.env.GEMINI_API_KEY='test-key'; let created=null;
    const db={announcement:{create:async({data})=>{created={id:'a1',createdAt:new Date(),...data};return created;}}};
    const originalFetch=global.fetch; let calls=0;
    global.fetch=async()=>jsonResponse(++calls===1?{candidates:[{content:{role:'model',parts:[{functionCall:{name:'publish_announcement',args:{title:'Office Update',message:'Monday meeting 10 AM.'}}}]}}]}:{candidates:[{content:{role:'model',parts:[{text:'Announcement publish ho gaya hai.'}]}}]});
    try{
      const mod=loadTs('src/lib/company-ai-agent.ts',{'./db':{db},'./agent-memory':{buildAgentMemoryContext:async()=>'',getRecentCompanyUpdates:async()=>[],rememberCompanyInformation:async()=>({}),rememberUrlSource:async()=>({})}});
      const out=await mod.runCompanyAiAgent('Announcement publish karo: Monday meeting 10 AM');
      assert.strictEqual(out.tools[0].name,'publish_announcement'); assert.strictEqual(created.title,'Office Update'); assert.match(created.body,/Monday/);
    } finally { global.fetch=originalFetch; }
  });

  await test('Company Agent can create a new employee and returns generated login credentials', async () => {
    process.env.GEMINI_API_KEY='test-key'; let createdData=null;
    const db={employee:{findFirst:async()=>null,create:async({data})=>{createdData=data;return {id:'e2',employeeCode:'DC26-WEB-EMP-001',name:data.name,role:data.role,department:data.department,systemRole:data.systemRole,email:data.email,joiningDate:data.joiningDate}}}};
    const originalFetch=global.fetch; let calls=0;
    global.fetch=async()=>jsonResponse(++calls===1?{candidates:[{content:{role:'model',parts:[{functionCall:{name:'create_team_member',args:{name:'Ali Khan',department_code:'WEB',designation:'Frontend Developer',email:'ali@example.com'}}}]}}]}:{candidates:[{content:{role:'model',parts:[{text:'Ali ko employee ke taur par add kar diya hai.'}]}}]});
    try{
      const mod=loadTs('src/lib/company-ai-agent.ts',{'./db':{db},'./agent-memory':{buildAgentMemoryContext:async()=>'',getRecentCompanyUpdates:async()=>[],rememberCompanyInformation:async()=>({}),rememberUrlSource:async()=>({})}});
      const out=await mod.runCompanyAiAgent('Ali Khan ko Web Development mein new employee add karo');
      assert.strictEqual(out.tools[0].name,'create_team_member'); assert.strictEqual(createdData.name,'Ali Khan'); assert.strictEqual(createdData.departmentCode,'WEB'); assert.ok(createdData.passwordHash); assert.ok(createdData.accessToken);
    } finally { global.fetch=originalFetch; }
  });

  await test('Dashboard Agent desktop queue targets an online Windows bridge', async () => {
    let created=null;
    const now=new Date();
    const db={companyAgentRun:{
      findMany:async({where})=>where.model==='desktop-operator-heartbeat'?[{input:'DELL-PC',completedAt:now}]:[],
      create:async({data})=>{created={id:'cmd1',createdAt:now,...data};return created;},
    }};
    const mod=loadTs('src/lib/operator-queue.ts',{'./db':{db}});
    const out=await mod.queueDesktopOperatorCommand('Chrome kholo');
    assert.strictEqual(out.ok,true); assert.strictEqual(out.device,'DELL-PC'); assert.strictEqual(created.status,'OPERATOR_PENDING'); assert.strictEqual(created.model,'desktop-operator-command');
  });

  await test('Dashboard Agent desktop queue refuses to pretend when bridge is offline', async () => {
    const db={companyAgentRun:{findMany:async()=>[]}};
    const mod=loadTs('src/lib/operator-queue.ts',{'./db':{db}});
    const out=await mod.queueDesktopOperatorCommand('Chrome kholo');
    assert.match(out.error,/offline/i);
  });

  await test('Company Agent dispatches explicit browser command to connected desktop bridge', async () => {
    process.env.GEMINI_API_KEY='test-key'; let queued=null;
    const originalFetch=global.fetch; let calls=0;
    global.fetch=async()=>jsonResponse(++calls===1?{candidates:[{content:{role:'model',parts:[{functionCall:{name:'control_desktop',args:{command:'Chrome kholo'}}}]}}]}:{candidates:[{content:{role:'model',parts:[{text:'Chrome aap ke PC par open kar raha hoon.'}]}}]});
    try{
      const mod=loadTs('src/lib/company-ai-agent.ts',{
        './db':{db:{}},
        './agent-memory':{buildAgentMemoryContext:async()=>'',getRecentCompanyUpdates:async()=>[],rememberCompanyInformation:async()=>({}),rememberUrlSource:async()=>({})},
        './operator-queue':{queueDesktopOperatorCommand:async(command)=>{queued=command;return {ok:true,commandId:'cmd1',device:'DELL-PC',status:'QUEUED'}}},
      });
      const out=await mod.runCompanyAiAgent('Chrome kholo');
      assert.strictEqual(out.tools[0].name,'control_desktop'); assert.strictEqual(queued,'Chrome kholo'); assert.match(out.text,/Chrome/i);
    } finally { global.fetch=originalFetch; }
  });

  await test('Company Agent exposes secure desktop-control tool separately from dashboard actions', () => {
    const source=fs.readFileSync(path.join(root,'src/lib/company-ai-agent.ts'),'utf8');
    assert.ok(source.includes('name: "control_desktop"'));
    assert.match(source,/local Windows PC\/browser/i);
    assert.match(source,/Never use control_desktop for company dashboard\/database actions/i);
  });

  await test('Dashboard automation toolset includes department message, task, sharing and profile-open actions', () => {
    const source=fs.readFileSync(path.join(root,'src/lib/company-ai-agent.ts'),'utf8');
    for(const tool of ['send_department_message','assign_employee_task','share_document_with_employee','open_employee_profile','resolve_leave_request','publish_announcement','create_team_member']) assert.ok(source.includes(`name: "${tool}"`),tool);
    assert.match(source,/Ask only for the missing required field/);
  });

  await test('Final Prisma schema contains company hierarchy, knowledge, projects, CRM and finance models', () => {
    const schema=fs.readFileSync(path.join(root,'prisma/schema.prisma'),'utf8');
    for(const token of ['enum CompanyRole','model CompanyProfile {','model CompanyKnowledgeItem {','model Project {','model ProjectMilestone {','model ProjectTask {','model TaskSubmission {','model SalesLead {','model Invoice {','model CompanyNotification {','model TrackerToken {','model WorkSession {','model WorkScreenshot {','model CompanyAgentRun {']) assert.ok(schema.includes(token),token);
  });

  await test("Gemini 3 streaming preserves thoughtSignature on tool-call parts", async()=>{
    const source=fs.readFileSync(path.join(root,'src/lib/company-ai-agent.ts'),'utf8');
    assert(source.includes('thoughtSignature?: string'));
    assert(source.includes('modelParts.push({ ...part })'));
    assert(!source.includes('modelParts.push({ functionCall: part.functionCall })'));
  });

  console.log(`\nRESULT ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
