'use strict'

const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
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
const maxFetchAttempts = 120
const fetchRetryDelayMilliseconds = 5000
// Upper bound for a native binary read from a tarball. Larger output fails the
// read instead of being truncated.
const maxPackedFileBytes = 512 * 1024 * 1024

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

// npm serves a new version's document and its tarball before the release is
// installable everywhere: either can answer 404 for several minutes after the
// publish. Retry those and server errors for up to ten minutes.
async function fetchWithRetry(url, label, read, options = {}) {
  let lastFailure
  for (let attempt = 1; attempt <= maxFetchAttempts; attempt += 1) {
    try {
      const response = await fetch(url, options)
      if (response.ok) return await read(response)
      lastFailure = `HTTP ${response.status}`
      if (response.status !== 404 && response.status < 500) break
    } catch (error) {
      lastFailure = error.message
    }
    if (attempt < maxFetchAttempts) await sleep(fetchRetryDelayMilliseconds)
  }
  throw new Error(`Unable to read ${label}: ${lastFailure}`)
}

function fetchJson(url, label, options) {
  return fetchWithRetry(url, label, (response) => response.json(), options)
}

function fetchBuffer(url, label, options) {
  return fetchWithRetry(
    url,
    label,
    async (response) => Buffer.from(await response.arrayBuffer()),
    options
  )
}

function registryVersionUrl(name) {
  return `${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
}

function hasProvenance(metadata) {
  return metadata.dist?.attestations?.provenance?.predicateType === 'https://slsa.dev/provenance/v1'
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

// `dist.integrity` is a Subresource Integrity string. npm records a sha512
// digest of the tarball it serves.
function matchesIntegrity(buffer, integrity) {
  const expected = String(integrity ?? '')
    .split(/\s+/)
    .filter((entry) => entry.startsWith('sha512-'))
    .map((entry) => entry.slice('sha512-'.length).split('?')[0])
  const actual = crypto.createHash('sha512').update(buffer).digest('base64')
  return expected.length > 0 && expected.includes(actual)
}

// npm tarballs keep the package contents under `package/`.
function packedFile(tarball, filename) {
  return execFileSync('tar', ['-xzOf', '-', `package/${filename}`], {
    input: tarball,
    maxBuffer: maxPackedFileBytes,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function parseChecksums(text) {
  const checksums = new Map()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line)
    if (match === null) {
      errors.push(`SHA256SUMS contains a malformed line: ${JSON.stringify(line)}`)
      continue
    }
    check(!checksums.has(match[2]), `SHA256SUMS lists ${match[2]} more than once`)
    checksums.set(match[2], match[1])
  }
  return checksums
}

// Downloads the tarball npm serves for `metadata` and checks it against the
// recorded integrity. Returns the tarball, or null after recording an error.
async function verifiedTarball(metadata, name) {
  const tarballUrl = metadata.dist?.tarball
  if (typeof tarballUrl !== 'string') {
    errors.push(`${name}@${version} has no tarball URL`)
    return null
  }
  try {
    const tarball = await fetchBuffer(tarballUrl, `${name}@${version} tarball`)
    if (!matchesIntegrity(tarball, metadata.dist.integrity)) {
      errors.push(`${name}@${version} tarball does not match its published integrity`)
      return null
    }
    return tarball
  } catch (error) {
    errors.push(error.message)
    return null
  }
}

async function main() {
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

  const assets = new Map((release.assets || []).map((asset) => [asset.name, asset]))
  for (const target of targets) {
    check(assets.has(target.binaryName), `GitHub release is missing ${target.binaryName}`)
  }
  check(assets.has('SHA256SUMS'), 'GitHub release is missing SHA256SUMS')

  // The published SHA256SUMS is the reference for every binary users can
  // download, from npm and from the GitHub release.
  let checksums = new Map()
  if (assets.has('SHA256SUMS')) {
    const manifest = await fetchBuffer(
      assets.get('SHA256SUMS').browser_download_url,
      `SHA256SUMS of GitHub release v${version}`
    )
    checksums = parseChecksums(manifest.toString('utf8'))
    check(
      equalValues([...checksums.keys()].sort(), targets.map((target) => target.binaryName).sort()),
      'SHA256SUMS must list exactly the binaries of the release targets'
    )
  }

  const rootMetadata = await fetchJson(
    registryVersionUrl(packageJson.name),
    `${packageJson.name}@${version}`
  )
  check(rootMetadata.name === packageJson.name, 'Published root package name is incorrect')
  check(rootMetadata.version === version, 'Published root package version is incorrect')
  check(hasProvenance(rootMetadata), 'Published root package has no SLSA provenance attestation')
  await verifiedTarball(rootMetadata, packageJson.name)

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
    check(metadata.main === target.main, `${target.packageName} published with the wrong main file`)
    check(equalValues(metadata.os, target.os), `${target.packageName} published with invalid os constraints`)
    check(equalValues(metadata.cpu, target.cpu), `${target.packageName} published with invalid cpu constraints`)
    check(equalValues(metadata.libc, target.libc), `${target.packageName} published with invalid libc constraints`)
    check(hasProvenance(metadata), `${target.packageName} has no SLSA provenance attestation`)

    const expectedChecksum = checksums.get(target.binaryName)
    const tarball = await verifiedTarball(metadata, target.packageName)
    if (tarball !== null && expectedChecksum !== undefined) {
      try {
        check(
          sha256(packedFile(tarball, target.binaryName)) === expectedChecksum,
          `${target.packageName}@${version} contains a ${target.binaryName} that does not match SHA256SUMS`
        )
      } catch (error) {
        errors.push(`${target.packageName}@${version} tarball has no readable ${target.binaryName}: ${error.message}`)
      }
    }

    const asset = assets.get(target.binaryName)
    if (asset !== undefined && expectedChecksum !== undefined) {
      try {
        const binary = await fetchBuffer(asset.browser_download_url, `GitHub release asset ${target.binaryName}`)
        check(
          sha256(binary) === expectedChecksum,
          `GitHub release asset ${target.binaryName} does not match SHA256SUMS`
        )
      } catch (error) {
        errors.push(error.message)
      }
    }
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

  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }

  console.log(
    `Verified npm metadata, provenance, dist-tag, tarballs, and native binaries against SHA256SUMS for ${packageJson.name}@${version}`
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
