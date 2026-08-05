'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { releaseTargets } = require('./release-targets.js')

const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
)
const version = process.argv[2] || packageJson.version
const targets = releaseTargets(packageJson)
const errors = []
const registry = 'https://registry.npmjs.org'

function check(condition, message) {
  if (!condition) errors.push(message)
}

function equalValues(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function equalRecords(actual, expected) {
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right))
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right))
  return equalValues(actualEntries, expectedEntries)
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function fetchJson(url, label, options = {}) {
  let lastFailure
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const response = await fetch(url, options)
      if (response.ok) return await response.json()
      lastFailure = `HTTP ${response.status}`
      if (response.status !== 404 && response.status < 500) break
    } catch (error) {
      lastFailure = error.message
    }
    if (attempt < 12) await sleep(5000)
  }
  throw new Error(`Unable to read ${label}: ${lastFailure}`)
}

function registryVersionUrl(name) {
  return `${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
}

function hasProvenance(metadata) {
  return metadata.dist?.attestations?.provenance?.predicateType === 'https://slsa.dev/provenance/v1'
}

async function main() {
  const rootMetadata = await fetchJson(
    registryVersionUrl(packageJson.name),
    `${packageJson.name}@${version}`
  )
  check(rootMetadata.name === packageJson.name, 'Published root package name is incorrect')
  check(rootMetadata.version === version, 'Published root package version is incorrect')
  check(hasProvenance(rootMetadata), 'Published root package has no SLSA provenance attestation')

  const expectedOptionalDependencies = Object.fromEntries(
    targets.map((target) => [target.packageName, version])
  )
  const actualPlatformDependencies = Object.fromEntries(
    Object.entries(rootMetadata.optionalDependencies || {}).filter(([name]) =>
      name.startsWith(`${packageJson.name}-`)
    )
  )
  check(
    equalRecords(actualPlatformDependencies, expectedOptionalDependencies),
    'Published root optionalDependencies do not match the release target set'
  )

  for (const target of targets) {
    const metadata = await fetchJson(
      registryVersionUrl(target.packageName),
      `${target.packageName}@${version}`
    )
    check(metadata.name === target.packageName, `${target.packageName} published with the wrong name`)
    check(metadata.version === version, `${target.packageName} published with the wrong version`)
    check(metadata.main === target.binaryName, `${target.packageName} published with the wrong main file`)
    check(equalValues(metadata.os, target.os), `${target.packageName} published with invalid os constraints`)
    check(equalValues(metadata.cpu, target.cpu), `${target.packageName} published with invalid cpu constraints`)
    check(equalValues(metadata.libc, target.libc), `${target.packageName} published with invalid libc constraints`)
    check(hasProvenance(metadata), `${target.packageName} has no SLSA provenance attestation`)
  }

  const packageDocument = await fetchJson(
    `${registry}/${encodeURIComponent(packageJson.name)}`,
    `${packageJson.name} dist-tags`
  )
  const expectedDistTag = version.includes('-') ? 'next' : 'latest'
  check(
    packageDocument['dist-tags']?.[expectedDistTag] === version,
    `npm dist-tag ${expectedDistTag} does not point to ${version}`
  )

  const repository = process.env.GITHUB_REPOSITORY || 'NazarKalytiuk/napi_rust_xlsxreader'
  const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  const githubHeaders = {
    accept: 'application/vnd.github+json',
    'user-agent': 'rusc-xlsx-reader-release-verifier',
    'x-github-api-version': '2022-11-28',
  }
  if (githubToken) githubHeaders.authorization = `Bearer ${githubToken}`

  const release = await fetchJson(
    `https://api.github.com/repos/${repository}/releases/tags/v${encodeURIComponent(version)}`,
    `GitHub release v${version}`,
    { headers: githubHeaders }
  )
  check(release.tag_name === `v${version}`, 'GitHub release has the wrong tag')
  check(release.draft === false, 'GitHub release is still a draft')

  const assetNames = new Set((release.assets || []).map((asset) => asset.name))
  for (const target of targets) {
    check(assetNames.has(target.binaryName), `GitHub release is missing ${target.binaryName}`)
  }
  check(assetNames.has('SHA256SUMS'), 'GitHub release is missing SHA256SUMS')

  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }

  console.log(
    `Verified npm packages, provenance, dist-tag, and GitHub assets for ${packageJson.name}@${version}`
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
