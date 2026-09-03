import { spawn, spawnSync } from 'node:child_process'

const databaseUrl = process.env.MOXSCORE_TEST_DATABASE_URL?.trim()
const psql = process.env.MOXSCORE_TEST_PSQL_BIN?.trim() || 'psql'
if (!databaseUrl) {
  process.stderr.write('MOXSCORE_TEST_DATABASE_URL is required and must target a disposable local database.\n')
  process.exit(2)
}

function run(sql) {
  const result = spawnSync(psql, [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'psql failed')
  return result.stdout.trim()
}

function start(sql) {
  const child = spawn(psql, [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  return {
    child,
    result: new Promise((resolve, reject) => child.on('close', (code) => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(stderr.trim() || `psql exited ${code}`)))),
  }
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const owners = [
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000202',
  '00000000-0000-4000-8000-000000000203',
]
const requests = [
  '123e4567-e89b-42d3-a456-426614174201',
  '123e4567-e89b-42d3-a456-426614174202',
  '123e4567-e89b-42d3-a456-426614174203',
]

function claim(owner, request, monthlyLimit = 50) {
  return `select decision from public.moxscore_claim_ai_explanation('${owner}', '${request}', repeat('a',64), 'request-v1', 'prompt-v1', ${monthlyLimit}, 10, 5, 90);`
}

try {
  run(`delete from auth.users where id in (${owners.map((id) => `'${id}'`).join(',')}); insert into auth.users(id,email) values ${owners.map((id, index) => `('${id}','concurrency-${index + 1}@example.invalid')`).join(',')};`)

  const quotaFirst = start(`begin; ${claim(owners[0], requests[0], 1)} select pg_sleep(1.2); commit;`)
  await pause(200)
  const quotaSecond = start(`begin; ${claim(owners[0], '123e4567-e89b-42d3-a456-426614174204', 1)} commit;`)
  const [quotaFirstOutput, quotaSecondOutput] = await Promise.all([quotaFirst.result, quotaSecond.result])
  if (!quotaFirstOutput.includes('acquired') || !quotaSecondOutput.includes('monthly_limit')) {
    throw new Error(`quota race failed: first=${quotaFirstOutput} second=${quotaSecondOutput}`)
  }

  run(`${claim(owners[1], requests[1])} ${claim(owners[2], requests[2])}`)
  const capacitySql = (request) => `select reason from public.moxscore_reserve_ai_provider_capacity('${request}', 1000000, 10000000, 1, 10000, 60);`
  const capacityFirst = start(`begin; ${capacitySql(requests[1])} select pg_sleep(1.2); commit;`)
  await pause(200)
  const capacitySecond = start(`begin; ${capacitySql(requests[2])} commit;`)
  const [capacityFirstOutput, capacitySecondOutput] = await Promise.all([capacityFirst.result, capacitySecond.result])
  if (!capacityFirstOutput.includes('granted') || !capacitySecondOutput.includes('concurrency')) {
    throw new Error(`capacity race failed: first=${capacityFirstOutput} second=${capacitySecondOutput}`)
  }

  process.stdout.write('PASS: concurrent quota admitted exactly one request and concurrent capacity admitted exactly one provider lease.\n')
} finally {
  try {
    run(`delete from auth.users where id in (${owners.map((id) => `'${id}'`).join(',')});`)
  } catch {
    // The caller owns the disposable database and can discard it after failure.
  }
}
