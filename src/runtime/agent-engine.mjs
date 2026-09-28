import { loadData, mutateData, enrich, isOpenTask, todayIso } from './store.mjs';
import { getDashboard, getTeam, getProjects, getTasks, getHr, getSales, getFinance, getKnowledge, getReports } from './dashboard.mjs';

const MODEL = process.env.GEMINI_AGENT_MODEL || 'gemini-3.5-flash-lite';

export function detectLanguage(message='') {
  const s = String(message).toLowerCase();
  const romanUrdu = ['kya','kia','mujhe','mera','meri','ham','hum','aaj','kal','dikhao','batao','kholo','project','kaam','team','kon','kaun','hai','han','kr','karo','karna','wale','walay'];
  return romanUrdu.some(w => new RegExp(`(^|\\s)${w}(\\s|$)`).test(s)) ? 'ur-PK' : 'en-US';
}

function summaryText(data) {
  const s=data.stats;
  return `Company snapshot: ${s.activeProjects} active projects, ${s.teamOnline} active team members, ${s.needsAttention} attention items, ${s.pendingReviews} reviews, ${s.pendingLeave} pending leave requests and ${s.overdueInvoices} overdue invoice items.`;
}

function roman(textEn, key='generic') {
  const map={
    today:'Aaj founder attention ke liye overdue tasks, pending reviews, leave approvals aur invoice follow-ups sab se important hain.',
    team:'Team availability ready hai. Main employee ka current status, project, task aur workload dikha sakta hoon.',
    projects:'Projects overview ready hai. Active, at-risk, planning status, progress aur task blockers available hain.',
    hr:'HR overview ready hai. Pending leave requests aur employee information yahan se manage ho sakti hai.',
    finance:'Finance overview ready hai. Outstanding aur overdue invoices review kar sakte hain.',
    sales:'Sales pipeline ready hai. New, proposal, negotiation aur won leads available hain.',
    tasks:'Tasks overview ready hai. Overdue, blocked, review aur in-progress work filter kar sakte hain.',
    generic:'DeepCiphers company workspace se main projects, team, tasks, HR, sales, finance, reports aur company knowledge ke bare me help kar sakta hoon.'
  };
  return map[key] || textEn;
}

function tool(name, args={}, summary='') { return { name, args, summary }; }

async function localAgent(message, history=[]) {
  const q=String(message||'').trim();
  const s=q.toLowerCase();
  const lang=detectLanguage(q);
  const tools=[];
  let text='';
  let uiAction=null;
  let focus=null;
  const navTargets=[
    ['knowledge',['knowledge','policy','company info']],['projects',['project']],['tasks',['task']],['hr',['hr','leave']],['sales',['sales','lead']],['finance',['finance','invoice']],['reports',['report']],['settings',['setting']],['agent',['agent']],['overview',['dashboard','overview','home']]
  ];

  const openIntent=/\b(open|show|go to|kholo|dikhao|le chalo)\b/i.test(q);
  if(openIntent){
    for(const [target,words] of navTargets){if(words.some(w=>s.includes(w))){uiAction={type:'navigate',target};tools.push(tool('open_dashboard_section',{target},`Open ${target}`));break;}}
  }

  if(/today|priority|attention|aaj|kya kar|kia kar/.test(s)){
    const d=await getDashboard();
    tools.push(tool('get_today_plan',{},'Built live founder priority plan'),tool('get_attention_queue',{limit:8},`Found ${d.attention.length} attention items`));
    const first=d.attention.slice(0,4).map((x,i)=>`${i+1}. ${x.title} — ${x.detail}`).join('\n');
    text=lang==='ur-PK'?`${roman('', 'today')}\n\n${first||'Abhi koi urgent item nahi hai.'}`:`Today's founder priorities:\n${first||'No urgent items right now.'}`;
    uiAction ||= {type:'navigate',target:'overview'};
  } else if(/team|employee|staff|availability|kon online|kaun online/.test(s)){
    const team=await getTeam();
    tools.push(tool('get_team_availability',{},`Loaded ${team.length} team members`));
    const named=team.find(e=>s.includes(e.name.toLowerCase())||s.includes(e.employeeCode.toLowerCase()));
    if(named){
      focus=named;
      tools.push(tool('get_employee_profile',{employee_query:named.name},`Focused ${named.name}`),tool('get_employee_workload',{employee_query:named.name},`${named.workload.open} open tasks`));
      text=`${named.name} — ${named.role}, ${named.department}. Status: ${named.currentStatus}. Current project: ${named.currentProject}. Current task: ${named.currentTask}. Open tasks: ${named.workload.open}; blocked: ${named.workload.blocked}; review: ${named.workload.review}; overdue: ${named.workload.overdue}.`;
    }else{
      const active=team.filter(e=>e.isActive).map(e=>`${e.name}: ${e.currentStatus} · ${e.currentProject}`).join('\n');
      text=lang==='ur-PK'?`${roman('', 'team')}\n\n${active}`:`Team availability:\n${active}`;
    }
    uiAction ||= {type:'navigate',target:'overview'};
  } else if(/project|milestone|client portal|agent project/.test(s)){
    const projects=await getProjects();
    tools.push(tool('get_project_status',{query:q},`Loaded ${projects.length} projects`));
    const found=projects.find(p=>s.includes(p.code.toLowerCase())||s.includes(p.name.toLowerCase())||s.includes(p.clientName.toLowerCase()));
    if(found){
      text=`${found.code} — ${found.name}: ${found.status}, ${found.progress}% complete. Lead: ${found.lead}; deadline: ${found.deadline}. Tasks: ${found.taskSummary.total} total, ${found.taskSummary.done} done, ${found.taskSummary.blocked} blocked, ${found.taskSummary.review} in review.`;
    } else {
      text=(lang==='ur-PK'?roman('', 'projects'):'Project overview:')+'\n'+projects.map(p=>`${p.code} · ${p.name} · ${p.status} · ${p.progress}%`).join('\n');
    }
    uiAction ||= {type:'navigate',target:'projects'};
  } else if(/task|overdue|blocked|review/.test(s)){
    const tasks=await getTasks(); const today=todayIso();
    tools.push(tool('get_attention_queue',{limit:20},`Loaded ${tasks.length} tasks`));
    let rows=tasks;
    if(s.includes('overdue')) rows=rows.filter(t=>isOpenTask(t)&&t.dueAt<today);
    if(s.includes('blocked')) rows=rows.filter(t=>t.status==='BLOCKED');
    if(s.includes('review')) rows=rows.filter(t=>t.status==='REVIEW');
    text=(lang==='ur-PK'?roman('', 'tasks'):'Task overview:')+'\n'+rows.slice(0,8).map(t=>`${t.title} · ${t.status} · ${t.assignee} · ${t.dueAt}`).join('\n');
    uiAction ||= {type:'navigate',target:'tasks'};
  } else if(/hr|leave|department|role/.test(s)){
    const hr=await getHr(); tools.push(tool('get_hr_overview',{},`${hr.pending} pending leave requests`));
    text=(lang==='ur-PK'?roman('', 'hr'):'HR overview:')+`\nActive team: ${hr.employees.filter(e=>e.isActive).length}. Pending leave requests: ${hr.pending}.`;
    uiAction ||= {type:'navigate',target:'hr'};
  } else if(/sales|lead|pipeline|proposal/.test(s)){
    const x=await getSales(); tools.push(tool('get_sales_overview',{},`Pipeline value $${x.pipelineValue}`));
    text=(lang==='ur-PK'?roman('', 'sales'):'Sales overview:')+`\nOpen pipeline: $${x.pipelineValue}. Won: $${x.wonValue}. New ${x.counts.NEW||0}, proposal ${x.counts.PROPOSAL||0}, negotiation ${x.counts.NEGOTIATION||0}.`;
    uiAction ||= {type:'navigate',target:'sales'};
  } else if(/finance|invoice|payment|outstanding/.test(s)){
    const x=await getFinance(); tools.push(tool('get_finance_overview',{},`Outstanding $${x.outstanding}`));
    text=(lang==='ur-PK'?roman('', 'finance'):'Finance overview:')+`\nOutstanding: $${x.outstanding}. Overdue: $${x.overdue}. Invoices: ${x.invoices.length}.`;
    uiAction ||= {type:'navigate',target:'finance'};
  } else if(/report/.test(s)){
    const r=await getReports(); tools.push(tool('get_company_snapshot',{},'Compiled company report'));
    text=`Report generated ${r.generatedAt}. Active projects: ${r.summary.activeProjects}; team online: ${r.summary.teamOnline}; attention items: ${r.summary.needsAttention}; sales pipeline: $${r.sales.pipelineValue}; outstanding invoices: $${r.finance.outstanding}.`;
    uiAction ||= {type:'navigate',target:'reports'};
  } else if(/remember|save this|yaad|memory/.test(s)){
    const content=q.replace(/^(remember|save this|yaad rakhna|yaad rakho)[:\s-]*/i,'').trim();
    if(content){
      const item=await mutateData(data=>{const m={id:`m${Date.now()}`,category:'Agent Memory',title:content.slice(0,60),content,createdAt:new Date().toISOString()};data.memories.push(m);return m;});
      tools.push(tool('remember_company_information',{title:item.title,content:item.content},'Saved to persistent local memory'));
      text=lang==='ur-PK'?'Theek hai, yeh information local Agent memory me save kar di gayi hai.':'Saved. I added that information to the persistent local Agent memory.';
      uiAction ||= {type:'navigate',target:'knowledge'};
    }
  } else if(/knowledge|policy|service|deepciphers/.test(s)){
    const k=await getKnowledge(q.replace(/knowledge|policy|search|deepciphers/gi,'').trim());
    tools.push(tool('search_company_knowledge',{query:q},`Found ${k.length} knowledge items`));
    if(k.length) text=k.slice(0,4).map(x=>`${x.title}: ${x.content}`).join('\n\n');
    else { const d=await getDashboard(); text=`${d.company.name}: ${d.company.mission} Services include ${d.company.services.join(', ')}.`; }
    uiAction ||= {type:'navigate',target:'knowledge'};
  } else {
    const d=await getDashboard(); tools.push(tool('get_company_snapshot',{},'Loaded live company snapshot'));
    text=lang==='ur-PK'?`${roman('', 'generic')}\n\n${summaryText(d)}`:`${summaryText(d)}\n\nAsk me about today's priorities, team availability, a project, tasks, HR, sales, finance, reports, or company knowledge.`;
  }

  return { text, model:'local-deepciphers-v17', tools, focus, uiAction, responseLanguage:lang };
}

async function geminiEnhance(message, localResult) {
  const key=process.env.GEMINI_API_KEY;
  if(!key) return localResult;
  const model=MODEL;
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const system=`You are DeepCiphers Company AI Agent. Give concise founder-level operational answers. Never invent company data. Use the supplied local tool result as authoritative. Answer in the same language style as the user.\nLOCAL RESULT:\n${localResult.text}`;
  try{
    const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:`${system}\n\nUSER: ${message}`}]}],generationConfig:{temperature:0.2,maxOutputTokens:500}})});
    if(!res.ok) throw new Error(`Gemini ${res.status}`);
    const json=await res.json();
    const text=json?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('').trim();
    if(text) return {...localResult,text,model,tools:[...localResult.tools,tool('gemini_response',{model},'Gemini enhanced the local tool-grounded answer')]};
  }catch(err){
    return {...localResult,tools:[...localResult.tools,tool('gemini_fallback',{model},`Gemini unavailable; local response used (${String(err.message||err)})`)]};
  }
  return localResult;
}

export async function runAgent(message, history=[]) {
  const local=await localAgent(message,history);
  return geminiEnhance(message,local);
}

export function agentStatus(){
  return {configured:Boolean(process.env.GEMINI_API_KEY),model:process.env.GEMINI_API_KEY?MODEL:'local-deepciphers-v17',fallbackModel:'local-deepciphers-v17',maxToolRounds:4,thoughtSignaturePatch:'preserved-source-v17'};
}
