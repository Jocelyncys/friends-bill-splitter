# Friends Bill Splitter — Claude Code Handoff

**Status:** Paused intentionally on 24 October 2026 at the user's request. The product design and implementation plan are complete, but implementation Task 1 is only partially started.

## Read These First

1. Product architecture and UX specification: `D:\Joc project\friends-bill-splitter-architecture.md`
2. Complete implementation plan: `D:\Joc project\docs\superpowers\plans\2026-10-24-friends-bill-splitter.md`
3. This handoff: `D:\Joc project\friends-bill-splitter\docs\CLAUDE_CODE_HANDOFF.md`

The implementation plan is the source of truth. It contains 11 tasks and 47 checkbox steps. Execute the tasks in order and do not skip their tests or review gates.

## Repository State

- Intended final repository: `D:\Joc project\friends-bill-splitter`
- Branch: `feature/friends-bill-splitter`
- Initial commit: `0ffb71b chore: initialize friends bill splitter repository`
- Interrupted scaffold checkpoint: `6c22b44 chore: checkpoint interrupted Vite scaffold`
- This handoff is committed after that checkpoint.
- No GitHub remote has been configured.
- No Supabase project, environment file, migration, or deployment has been configured.

## What Has Been Completed

- A React + TypeScript Vite project was generated in the repository root.
- Runtime and development dependencies from Task 1 were installed and locked in `package-lock.json`.
- `@paddleocr/paddleocr-js` is pinned through the lockfile from the requested `0.4.2` package range.
- `package.json` contains `dev`, `test`, `build`, `lint`, and `preview` scripts.
- `vite.config.ts` uses `base: './'` for GitHub Pages-safe assets and contains the planned Vitest jsdom configuration.
- A fresh `npm run build` passed before this handoff. It built Vite 8.3.5 successfully with 20 transformed modules.

## Task 1 Is Not Complete

The generated Vite starter UI is still present. Do not treat the checkpoint as a completed feature.

Still required by Task 1:

- Create `src/app/App.test.tsx` first and run it to capture the expected RED failure.
- Create `src/test/setup.ts`.
- Create `src/app/App.tsx` with the bilingual mode-selection shell.
- Create `src/i18n/index.ts`, `src/i18n/en.json`, and `src/i18n/zh-CN.json`.
- Create `src/styles/tokens.css` with the approved Plum & Blush tokens.
- Update `src/main.tsx` to render the new named `App` and initialize i18n.
- Remove the unused Vite starter UI, styles, and assets after the failing test is confirmed.
- Run the focused test, full test suite, and production build.
- Commit Task 1 as `feat: scaffold bilingual PWA shell` only after all Task 1 checks pass.
- Perform the task-scoped specification and code-quality review before starting Task 2.

## Resume Commands

Open a terminal in the final repository, then run:

```powershell
cd 'D:\Joc project\friends-bill-splitter'
git status --short --branch
npm install
npm run build
```

Then ask Claude Code to continue from Task 1 using this prompt:

```text
Read D:\Joc project\friends-bill-splitter-architecture.md,
D:\Joc project\docs\superpowers\plans\2026-10-24-friends-bill-splitter.md,
and D:\Joc project\friends-bill-splitter\docs\CLAUDE_CODE_HANDOFF.md.

Resume the Friends Bill Splitter implementation from incomplete Task 1 on branch
feature/friends-bill-splitter. Follow the implementation plan task-by-task using TDD:
write and run the failing test before feature code, implement the smallest complete
change, run the required tests/build, commit, and perform spec plus code-quality review
before moving to the next task. Do not recreate the repository or mark Task 1 complete
until the bilingual shell, i18n files, Plum & Blush tokens, tests, and build all pass.
```

## Binding Product Decisions

- One app with **Single Bill** and **Trip/Event** modes.
- Anonymous joining; preferred name and reusable receiving details remain local to the user's device.
- Roles are owner, co-host, and participant. Co-hosts may manage expenses, claiming, settlement, and receiving details, but cannot delete the bill/event, promote co-hosts, or transfer ownership.
- Trip/Event mode supports multiple expenses and different payers.
- Settlement methods appear in this order: Pay original payers; Optimized direct settlement (Recommended); Settlement coordinator selected at the end.
- One final settlement initially; users may choose Settle now, Later, or Cancel.
- One currency initially, defaulting to MYR.
- A receiver may provide a bank account, payment QR, or both.
- English and Simplified Chinese are required from the first release.
- UI direction is Combined Guided Actions + Task-first with Plum & Blush colors, not blue or green.
- Frontend/PWA is deployed to GitHub Pages; Supabase provides anonymous Auth, PostgreSQL, Realtime, private Storage, and Row Level Security.
- OCR runs locally in the browser. Live collaboration and settlement require internet; local expense drafts may wait to sync.

## Known Constraints and Risks

- Supabase's free plan may pause inactive projects or change limits; check current official terms before production use.
- GitHub Pages hosts only the static frontend. Supabase is still required for cross-device sync and realtime collaboration.
- Never expose a Supabase `service_role` key in the frontend.
- Receipt OCR output must remain editable and must not be synchronized until the user confirms it.
- All monetary values must use integer cents, never floating-point storage or calculation.
- Generated Vite dependencies are current as of the checkpoint and should not be upgraded merely because newer versions exist.

## Verification Evidence at Pause

Command run:

```text
npm run build
```

Result:

```text
vite v8.3.5 building client environment for production...
20 modules transformed
dist/index.html generated
build completed successfully
```

No feature tests were completed. The passing build proves only that the generated scaffold compiles; it does not prove Task 1 or the application is complete.
