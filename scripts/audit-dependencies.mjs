import { spawnSync } from 'node:child_process'

const ALLOWED_ADVISORY_URL =
  'https://github.com/advisories/GHSA-qwww-vcr4-c8h2'
const ALLOWED_PACKAGE = 'react-router'
const supportedArguments = new Set(['--omit=dev'])

const auditArguments = process.argv.slice(2)
const unsupportedArgument = auditArguments.find(
  (argument) => !supportedArguments.has(argument),
)

if (unsupportedArgument) {
  console.error(`Unsupported audit argument: ${unsupportedArgument}`)
  process.exit(2)
}

const audit = spawnSync('npm', ['audit', '--json', ...auditArguments], {
  encoding: 'utf8',
  env: {
    ...process.env,
    npm_config_allow_scripts: undefined,
  },
})

if (audit.error) {
  console.error(`Unable to run npm audit: ${audit.error.message}`)
  process.exit(2)
}

if (audit.stderr) {
  process.stderr.write(audit.stderr)
}

let report

try {
  report = JSON.parse(audit.stdout)
} catch {
  console.error('npm audit did not return valid JSON.')
  process.exit(2)
}

if (
  report.auditReportVersion !== 2 ||
  !report.vulnerabilities ||
  typeof report.vulnerabilities !== 'object'
) {
  console.error('npm audit returned an unexpected report shape.')
  process.exit(2)
}

if (audit.status !== 0 && audit.status !== 1) {
  console.error(`npm audit failed with exit code ${audit.status}.`)
  process.exit(audit.status ?? 2)
}

const vulnerabilities = report.vulnerabilities
const allowedByPackage = new Map()
const resolving = new Set()

function isAllowed(packageName) {
  if (allowedByPackage.has(packageName)) {
    return allowedByPackage.get(packageName)
  }

  if (resolving.has(packageName)) {
    return false
  }

  const vulnerability = vulnerabilities[packageName]

  if (!vulnerability || !Array.isArray(vulnerability.via)) {
    return false
  }

  resolving.add(packageName)

  const allowed =
    vulnerability.via.length > 0 &&
    vulnerability.via.every((via) => {
      if (typeof via === 'string') {
        return isAllowed(via)
      }

      return (
        via?.name === ALLOWED_PACKAGE &&
        via?.dependency === ALLOWED_PACKAGE &&
        via?.url === ALLOWED_ADVISORY_URL
      )
    })

  resolving.delete(packageName)
  allowedByPackage.set(packageName, allowed)
  return allowed
}

const packageNames = Object.keys(vulnerabilities)
const disallowedPackages = packageNames.filter(
  (packageName) => !isAllowed(packageName),
)

if (disallowedPackages.length > 0) {
  console.error(audit.stdout.trim())
  console.error(
    `Dependency audit failed for: ${disallowedPackages.join(', ')}`,
  )
  process.exit(1)
}

if (packageNames.length > 0) {
  console.warn(
    `Accepted temporary non-applicable advisory: ${ALLOWED_ADVISORY_URL}`,
  )
  console.warn(
    'Moxscore uses client-side BrowserRouter and does not enable React Router RSC mode.',
  )
}

console.log(
  `Dependency audit passed (${auditArguments.includes('--omit=dev') ? 'production' : 'all'} dependencies).`,
)
