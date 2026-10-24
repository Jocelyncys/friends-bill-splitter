// Restarts the local Supabase stack with the anonymous sign-in limit raised for the e2e suite, then puts
// supabase/config.toml back exactly as it was. The running stack keeps the raised limit until its next restart;
// git never sees the change, so it cannot be committed or `supabase config push`ed by accident.
//   npm run e2e:supabase      (then: npm run e2e)
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const CONFIG = 'supabase/config.toml'
const LINE = /^anonymous_users = \d+$/m
const original = readFileSync(CONFIG, 'utf8')
if (!LINE.test(original)) throw new Error(`${CONFIG}: no "anonymous_users = N" line to override`)

const run = command => execSync(command, { stdio: 'inherit' })
try {
  writeFileSync(CONFIG, original.replace(LINE, 'anonymous_users = 1000'))
  run('npx supabase stop')
  run('npx supabase start')
} finally {
  writeFileSync(CONFIG, original)
}
