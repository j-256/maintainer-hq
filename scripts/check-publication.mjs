import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const SOURCE_REPOSITORY_URL = 'https://github.com/j-256/maintainer-hq'
const REQUIRED_PUBLICATION_FILES = Object.freeze(['CONTRIBUTING.md', 'LICENSE', 'README.md', 'SECURITY.md'])
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const privatePatterns = [
  /\/(?:Users|c|z)\//,
  /\/x\/(?:sec|cfg)\//,
  /\b(?:ghp|gho|ghu|ghs)_[a-zA-Z0-9]{20,}\b/,
  /\bhq[pa]_[a-f0-9]{64}\b/,
  /\bhkr_[A-Za-z0-9_-]{43}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
]

async function readFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const contents = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? readFiles(path) : readFile(path, 'utf8')
  }))
  return contents.flat()
}

const failures = []
for (const file of REQUIRED_PUBLICATION_FILES)
  if (!files.includes(file)) failures.push(file + ': required publication file is missing')
for (const file of files) {
  if (!/\.(?:tsx?|mjs|jsonc?|css|html|md|sql)$/.test(file) || file === 'package-lock.json') continue
  const content = await readFile(file, 'utf8')
  if (privatePatterns.some(pattern => pattern.test(content))) failures.push(file + ': private context or credential material')
  if (/[\u2014\u2018\u2019\u201c\u201d]/.test(content)) failures.push(file + ': non-portable punctuation')
}
const workerBundle = await readFile('dist/maintainer_hq/index.js', 'utf8')
const clientBundle = (await readFiles('dist/client')).join('\n')
if (workerBundle.includes('development-owner')) failures.push('Production build includes the development identity')
if (!clientBundle.includes(SOURCE_REPOSITORY_URL)) failures.push('Production build does not expose the public source repository')
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
else console.log('Publication checks passed: no detected private context, credentials, or development identity in the production bundle')
