# CS2203 Week 1 Task

Hi, my name is Humair Riaz. I am a student interested in software development, web development, artificial intelligence, and modern technologies.

I am currently learning Git and GitHub to improve my version control and software development skills.

This repository contains my CS2203 Week 1 homework and a working DeepCiphers AI Agent Dashboard project.

---


# DeepCiphers V17 — Full Working Company AI Agent Dashboard

This package turns the original **V17 Gemini thought-signature patch** into a complete runnable dashboard project.

## What is working

- Founder/Admin dashboard with live overview cards
- DeepCiphers Agent chat with tool traces and dashboard navigation actions
- Team availability and employee workload
- Projects and project status
- Tasks with live status updates
- HR leave approvals/rejections
- Sales pipeline
- Finance/invoice overview
- Company knowledge search and persistent memory
- Reports
- Desktop Operator **queue** (safe queue only; it does not execute OS commands)
- Persistent local JSON data
- Optional Gemini enhancement when `GEMINI_API_KEY` is configured
- Local fallback agent works without any API key
- Health endpoint and automated tests
- Original `src/lib/company-ai-agent.ts` V17 patch preserved for reference/integration

## Run on Windows

1. Install Node.js 18+.
2. Open PowerShell in this folder.
3. Run:

```powershell
npm start
```

4. Open:

```text
http://localhost:3000
```

No `npm install` is required because this runnable version uses Node.js built-ins only.

## Optional Gemini mode

Copy `.env.example` to `.env`, add your Gemini API key, then start the app. The app still keeps the local tool-aware fallback so it remains usable if Gemini is unavailable.

## API

- `GET /api/health`
- `GET /api/dashboard`
- `GET /api/team`
- `GET /api/projects`
- `GET /api/tasks`
- `PATCH /api/tasks/:id`
- `GET /api/hr`
- `POST /api/hr/leave/:id`
- `GET /api/sales`
- `GET /api/finance`
- `GET /api/knowledge?q=...`
- `POST /api/knowledge`
- `GET /api/reports`
- `GET /api/settings`
- `POST /api/operator`
- `GET /api/operator`
- `POST /api/agent`

## Original patch

The supplied V17 source is preserved at:

```text
src/lib/company-ai-agent.ts
```

The original regression self-test is preserved as:

```text
scripts/original-self-test.cjs
```

That original self-test expects the larger historical monorepo and is included as reference. The runnable package has its own tests under `tests/`.
