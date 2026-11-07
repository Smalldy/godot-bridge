import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const version = pkg.version
assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'package version is semver')

for (const name of ['CHANGELOG.md', 'CHANGELOG.zh-CN.md']) {
  const changelog = readFileSync(new URL('../../' + name, import.meta.url), 'utf8')
  const headings = changelog.match(/^## \[[^\]]+\]/gm) || []
  assert.ok(headings.includes('## [Unreleased]'), name + ' has an Unreleased section')
  const versionHeading = '## [' + version + ']'
  assert.equal(headings.filter((heading) => heading === versionHeading).length, 1, name + ' documents exactly one ' + version + ' release')
  assert.ok(changelog.includes('[' + version + ']:'), name + ' has a ' + version + ' link reference')
}

console.log('PASS  package version and both changelogs agree');
