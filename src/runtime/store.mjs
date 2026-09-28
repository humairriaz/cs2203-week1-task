import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(here, '../../data/company.json');

export async function loadData() {
  const raw = await readFile(DATA_FILE, 'utf8');
  return JSON.parse(raw);
}

export async function saveData(data) {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return data;
}

export async function mutateData(mutator) {
  const data = await loadData();
  const result = await mutator(data);
  await saveData(data);
  return result;
}

export function enrich(data) {
  const employees = new Map(data.employees.map(x => [x.id, x]));
  const projects = new Map(data.projects.map(x => [x.id, x]));
  return { employees, projects };
}

export function isOpenTask(task) {
  return !['DONE', 'APPROVED'].includes(task.status);
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
