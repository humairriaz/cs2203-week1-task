import { loadData, enrich, isOpenTask, todayIso } from './store.mjs';

function money(n, currency='USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(n || 0));
}

export async function getDashboard() {
  const data = await loadData();
  const { employees, projects } = enrich(data);
  const today = todayIso();
  const activeEmployees = data.employees.filter(e => e.isActive);
  const activeProjects = data.projects.filter(p => ['ACTIVE','AT_RISK'].includes(p.status));
  const overdueTasks = data.tasks.filter(t => isOpenTask(t) && t.dueAt < today);
  const blockedTasks = data.tasks.filter(t => t.status === 'BLOCKED');
  const reviewTasks = data.tasks.filter(t => t.status === 'REVIEW');
  const pendingLeave = data.leaveRequests.filter(l => l.status === 'PENDING');
  const overdueInvoices = data.invoices.filter(i => i.status === 'OVERDUE' || (['SENT','DUE'].includes(i.status) && i.dueDate < today));
  const attention = [
    ...overdueTasks.map(t => ({ id:`task-${t.id}`, type:'Overdue task', title:t.title, detail:`${projects.get(t.projectId)?.name ?? 'Project'} · ${employees.get(t.assigneeId)?.name ?? 'Unassigned'}`, target:'tasks', severity:'high' })),
    ...blockedTasks.map(t => ({ id:`blocked-${t.id}`, type:'Blocked', title:t.title, detail:`${projects.get(t.projectId)?.name ?? 'Project'} · needs unblock`, target:'tasks', severity:'high' })),
    ...reviewTasks.map(t => ({ id:`review-${t.id}`, type:'Review', title:t.title, detail:`${projects.get(t.projectId)?.name ?? 'Project'} · waiting review`, target:'tasks', severity:'medium' })),
    ...pendingLeave.map(l => ({ id:`leave-${l.id}`, type:'HR approval', title:`Leave request: ${employees.get(l.employeeId)?.name ?? 'Employee'}`, detail:`${l.from} → ${l.to}`, target:'hr', severity:'medium' })),
    ...overdueInvoices.map(i => ({ id:`invoice-${i.id}`, type:'Finance', title:`Invoice: ${i.client}`, detail:`${money(i.amount, i.currency)} · ${i.status}`, target:'finance', severity:'high' })),
  ].slice(0, 10);

  return {
    company: data.company,
    stats: {
      activeProjects: activeProjects.length,
      teamOnline: activeEmployees.filter(e => ['WORKING','REVIEW','AVAILABLE'].includes(e.currentStatus)).length,
      needsAttention: attention.length,
      pendingReviews: reviewTasks.length,
      pendingLeave: pendingLeave.length,
      overdueInvoices: overdueInvoices.length,
    },
    attention,
    team: activeEmployees.map(e => ({...e})),
    projects: activeProjects,
    notifications: [...data.notifications].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,5),
  };
}

export async function getTeam() {
  const data = await loadData();
  const { projects } = enrich(data);
  const today = todayIso();
  return data.employees.map(e => {
    const tasks = data.tasks.filter(t => t.assigneeId === e.id);
    const open = tasks.filter(isOpenTask);
    return {
      ...e,
      workload: {
        open: open.length,
        blocked: open.filter(t => t.status === 'BLOCKED').length,
        review: open.filter(t => t.status === 'REVIEW').length,
        overdue: open.filter(t => t.dueAt < today).length,
      },
      tasks: open.map(t => ({...t, project: projects.get(t.projectId)?.name ?? null})).slice(0,5),
    };
  });
}

export async function getProjects() {
  const data = await loadData();
  const { employees } = enrich(data);
  return data.projects.map(p => {
    const tasks = data.tasks.filter(t => t.projectId === p.id);
    return {
      ...p,
      taskSummary: {
        total: tasks.length,
        done: tasks.filter(t => t.status === 'DONE').length,
        blocked: tasks.filter(t => t.status === 'BLOCKED').length,
        review: tasks.filter(t => t.status === 'REVIEW').length,
      },
      tasks: tasks.map(t => ({...t, assignee: employees.get(t.assigneeId)?.name ?? 'Unassigned'})),
    };
  });
}

export async function getTasks() {
  const data = await loadData();
  const { employees, projects } = enrich(data);
  return data.tasks.map(t => ({
    ...t,
    assignee: employees.get(t.assigneeId)?.name ?? 'Unassigned',
    project: projects.get(t.projectId)?.name ?? 'Unknown project',
    projectCode: projects.get(t.projectId)?.code ?? '',
  }));
}

export async function getHr() {
  const data = await loadData();
  const { employees } = enrich(data);
  return {
    employees: data.employees,
    leaveRequests: data.leaveRequests.map(l => ({...l, employee: employees.get(l.employeeId)?.name ?? 'Employee'})),
    pending: data.leaveRequests.filter(l => l.status === 'PENDING').length,
  };
}

export async function getSales() {
  const data = await loadData();
  const { employees } = enrich(data);
  const leads = data.salesLeads.map(l => ({...l, owner: employees.get(l.ownerId)?.name ?? 'Unassigned'}));
  return {
    leads,
    pipelineValue: leads.filter(l => l.stage !== 'WON').reduce((s,l)=>s+Number(l.value||0),0),
    wonValue: leads.filter(l => l.stage === 'WON').reduce((s,l)=>s+Number(l.value||0),0),
    counts: Object.fromEntries(['NEW','PROPOSAL','NEGOTIATION','WON'].map(stage => [stage, leads.filter(l=>l.stage===stage).length])),
  };
}

export async function getFinance() {
  const data = await loadData();
  const { projects } = enrich(data);
  const invoices = data.invoices.map(i => ({...i, project: projects.get(i.projectId)?.name ?? 'Project'}));
  return {
    invoices,
    outstanding: invoices.filter(i=>!['PAID','DRAFT'].includes(i.status)).reduce((s,i)=>s+Number(i.amount||0),0),
    overdue: invoices.filter(i=>i.status==='OVERDUE').reduce((s,i)=>s+Number(i.amount||0),0),
    paid: invoices.filter(i=>i.status==='PAID').reduce((s,i)=>s+Number(i.amount||0),0),
  };
}

export async function getKnowledge(q='') {
  const data = await loadData();
  const query = String(q||'').trim().toLowerCase();
  const all = [
    ...data.knowledge.map(k => ({...k, source:'knowledge'})),
    ...data.memories.map(k => ({...k, source:'memory'})),
  ];
  return query ? all.filter(k => `${k.category} ${k.title} ${k.content}`.toLowerCase().includes(query)) : all;
}

export async function getReports() {
  const [dashboard, team, projects, sales, finance] = await Promise.all([getDashboard(), getTeam(), getProjects(), getSales(), getFinance()]);
  return {
    generatedAt: new Date().toISOString(),
    summary: dashboard.stats,
    departmentLoad: team.reduce((acc,e)=>{acc[e.department]=(acc[e.department]||0)+e.workload.open;return acc;},{}),
    projectHealth: projects.map(p=>({code:p.code,name:p.name,status:p.status,progress:p.progress,blocked:p.taskSummary.blocked,review:p.taskSummary.review})),
    sales: { pipelineValue: sales.pipelineValue, wonValue: sales.wonValue, counts: sales.counts },
    finance: { outstanding: finance.outstanding, overdue: finance.overdue, paid: finance.paid },
  };
}
