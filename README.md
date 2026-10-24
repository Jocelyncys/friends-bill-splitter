# Friends Bill Splitter

Bilingual (English / 简体中文), mobile-first PWA for splitting bills and trip expenses with friends:
receipts read by in-browser OCR, item claims, optimized settlement and payment tracking.
React + TypeScript + Vite, backed by Supabase, deployed to GitHub Pages.

## Local development

1. `npm ci`
2. `npx supabase start` (needs Docker), then copy `.env.example` to `.env.local` and fill in the
   local API URL and publishable key it prints. Never put a `service_role`/secret key in a `VITE_*` variable.
3. `npm run fetch:ocr` once, to download the OCR models and runtime into `public/ocr-models/`.
4. `npm run dev`

## Scripts

| Script | Does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm test -- --run` | Unit and component tests (Vitest) |
| `npx supabase test db` | Database / RLS tests (pgTAP) against the local Supabase |
| `npm run build` | Downloads OCR assets if missing (`prebuild`), type-checks and builds to `dist/` |
| `npm run check:sw` | Asserts the built service worker never touches Supabase and does not precache OCR files |
| `npm run lint` | ESLint |
| `npm run fetch:ocr` | Downloads PP-OCRv5 models + onnxruntime-web wasm, verifying pinned SHA-256 hashes |
| `npm run icons` | Regenerates the PWA icons in `public/icons/` |

## OCR assets

Nothing is loaded from a third-party origin at runtime. `scripts/fetch-ocr-models.mjs` downloads the
PaddleOCR PP-OCRv5 mobile detection/recognition models and the onnxruntime-web 1.24.3 wasm (the version
the PaddleOCR SDK's worker is built against) and fails the build if any SHA-256 differs. The files are
served from `./ocr-models/` and are not committed. The SDK runs inside a dedicated worker
(`src/features/ocr/ocr.worker.ts`), so it never loads on the main thread.

## Offline / PWA

The service worker precaches the app shell (HTML, JS, CSS, icons, manifest). OCR scripts, models and wasm
are cached on first use (`ocr-assets-v1`, bump the name when the pinned files change). Supabase requests are
never routed through the service worker cache, so no payment data is stored by it.

## Content-Security-Policy

Production builds get a CSP `<meta>` tag (`src/lib/csp.ts`, injected by `vite.config.ts`):
`default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`, `connect-src`/`img-src` limited to `'self'` plus
the Supabase origin from `VITE_SUPABASE_URL` (and its `ws`/`wss` realtime origin), `worker-src 'self' blob:`,
`object-src 'none'`, `base-uri 'self'`. The OCR SDK's opencv build needs `Function()`, which this policy
forbids on the page; that is why the SDK is only ever imported inside the OCR worker, which loads from its
own URL and is not governed by the page's `<meta>` policy. The dev server has no CSP.

## Deployment (GitHub Pages)

`.github/workflows/pages.yml` builds and deploys `main`. Set the Pages source to GitHub Actions and add the
repository **variables** (not secrets; both are public by design) `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY`. The app uses relative paths and a hash router, so it works under the
`/<repo>/` sub-path. `.github/workflows/ci.yml` runs lint, unit tests, build, the service-worker check and the
Supabase database tests on every push and pull request.

## Release checklist

- Production Supabase project created; migrations applied with `npx supabase db push`.
- Anonymous sign-ins enabled with CAPTCHA / rate limiting.
- Private `payment-qr` Storage bucket created and its policies verified.
- Scheduled cleanup for `payment_details.delete_after` and the associated Storage objects.
- Repository variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` set; Pages source = GitHub Actions.
- No `service_role` key, bank account, receipt image or real invite token anywhere in Git history.
- Final schema and RLS test output exported and archived.
- Publish only after the full release gate passes (unit, database, build, end-to-end).
