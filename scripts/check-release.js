'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { releaseTargets } = require('./release-targets.js')

const root = path.join(__dirname, '..')
const packageJson = readJson('package.json')
const packageLock = readJson('package-lock.json')
const cargoToml = fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8')
const arguments_ = process.argv.slice(2)
const checkRegistry = arguments_.includes('--registry')
const releaseTag = arguments_.find((argument) => !argument.startsWith('--')) || process.env.RELEASE_TAG
const errors = []

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
}

function check(condition, message) {
  if (!condition) errors.push(message)
}

function equalValues(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

// Returns the versions published under `name`, null when the package does not
// exist, or undefined after recording a registry error.
async function publishedVersions(name) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (response.status === 404) return null
  if (!response.ok) {
    errors.push(`npm registry preflight for ${name} returned HTTP ${response.status}`)
    return undefined
  }
  const document = await response.json()
  return new Set(Object.keys(document.versions ?? {}))
}

async function main() {
  const version = packageJson.version
  const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  check(typeof version === 'string' && semverPattern.test(version), `Invalid release version: ${version}`)

  if (releaseTag) {
    check(releaseTag === `v${version}`, `Release tag ${releaseTag} must equal v${version}`)
  }

  const packageBlock = cargoToml.split(/\n(?=\[)/).find((block) => block.startsWith('[package]')) || ''
  const cargoVersion = packageBlock.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  check(cargoVersion === version, `Cargo.toml version ${cargoVersion} must equal ${version}`)
  check(packageLock.version === version, `package-lock.json version ${packageLock.version} must equal ${version}`)
  check(
    packageLock.packages?.['']?.version === version,
    `package-lock.json root version ${packageLock.packages?.['']?.version} must equal ${version}`
  )

  const expectedRepository = 'git+https://github.com/NazarKalytiuk/napi_rust_xlsxreader.git'
  check(packageJson.private !== true, 'Release package must not be private')
  check(packageJson.repository?.url === expectedRepository, `repository.url must equal ${expectedRepository}`)
  check(
    packageJson.homepage === 'https://github.com/NazarKalytiuk/napi_rust_xlsxreader#readme',
    'homepage must point to the release repository README'
  )
  check(
    packageJson.bugs?.url === 'https://github.com/NazarKalytiuk/napi_rust_xlsxreader/issues',
    'bugs.url must point to the release repository issues'
  )
  check(packageJson.license === 'MIT', 'license must be MIT')
  check(packageJson.publishConfig?.access === 'public', 'publishConfig.access must be public')
  check(packageJson.publishConfig?.provenance === true, 'publishConfig.provenance must be true')
  check(packageJson.scripts?.prepublishOnly === 'napi prepublish -t npm', 'prepublishOnly must use npm tag style')

  const requiredFiles = [
    'index.js',
    'index.d.ts',
    'browser.js',
    'reader.js',
    'wrapper.js',
    'wrapper.mjs',
    'wrapper.browser.mjs',
    'wrapper.d.ts',
    'README.md',
    'LICENSE',
  ]
  for (const filename of requiredFiles) {
    check(packageJson.files?.includes(filename), `package.json files is missing ${filename}`)
    check(fs.existsSync(path.join(root, filename)), `Release file ${filename} does not exist`)
  }

  check(packageJson.main === 'wrapper.js', 'main must point to wrapper.js')
  check(packageJson.module === 'wrapper.mjs', 'module must point to wrapper.mjs')
  check(packageJson.types === 'wrapper.d.ts', 'types must point to wrapper.d.ts')
  check(packageJson.exports?.['.']?.require === './wrapper.js', 'CommonJS export must point to wrapper.js')
  check(packageJson.exports?.['.']?.import === './wrapper.mjs', 'ESM export must point to wrapper.mjs')
  check(packageJson.exports?.['.']?.types === './wrapper.d.ts', 'types export must point to wrapper.d.ts')
  check(
    packageJson.exports?.['.']?.browser === './wrapper.browser.mjs',
    'browser export must point to wrapper.browser.mjs'
  )
  check(packageJson.napi?.wasm?.cpu === false, 'napi.wasm.cpu must be false so the WebAssembly package installs everywhere')

  let targets = []
  try {
    targets = releaseTargets(packageJson)
  } catch (error) {
    errors.push(error.message)
  }
  check(targets.length === 8, `Expected 8 release targets, found ${targets.length}`)
  check(
    equalValues(packageJson.napi?.darwin?.universal?.targets, [
      'x86_64-apple-darwin',
      'aarch64-apple-darwin',
    ]),
    'Universal macOS target must contain x64 and arm64 slices'
  )

  const optionalDependencies = packageJson.optionalDependencies || {}
  const expectedPlatformNames = new Set(targets.map((target) => target.packageName))
  for (const [name, dependencyVersion] of Object.entries(optionalDependencies)) {
    if (name.startsWith(`${packageJson.name}-`)) {
      check(expectedPlatformNames.has(name), `Obsolete platform dependency ${name} must be removed`)
      check(dependencyVersion === version, `${name} must use exact version ${version}`)
    }
  }

  if (fs.existsSync(path.join(root, 'index.js'))) {
    const loader = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
    const generatedVersions = new Set(
      [...loader.matchAll(/bindingPackageVersion !== '([^']+)'/g)].map((match) => match[1])
    )
    check(generatedVersions.size > 0, 'Generated loader contains no package version checks')
    check(
      generatedVersions.size === 1 && generatedVersions.has(version),
      `Generated loader versions ${[...generatedVersions].join(', ')} must equal ${version}`
    )
  }

  if (process.env.GITHUB_REPOSITORY) {
    const expectedSlug = 'NazarKalytiuk/napi_rust_xlsxreader'
    check(
      process.env.GITHUB_REPOSITORY.toLowerCase() === expectedSlug.toLowerCase(),
      `Workflow repository ${process.env.GITHUB_REPOSITORY} must equal ${expectedSlug}`
    )
  }

  if (checkRegistry && errors.length === 0) {
    // npm configures trusted publishers only for packages that already exist,
    // so trusted publishing cannot publish a package's first version, and
    // published versions are immutable. Checking
    // every package before anything is built keeps a release from failing
    // partway through publishing and leaving a partial release behind.
    for (const name of [packageJson.name, ...targets.map((target) => target.packageName)]) {
      const versions = await publishedVersions(name)
      if (versions === null) {
        errors.push(
          `${name} does not exist on npm: publish its first version and configure its trusted publisher (RELEASING.md)`
        )
      } else if (versions?.has(version)) {
        errors.push(`${name}@${version} is already published`)
      }
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }

  const npmTag = version.includes('-') ? 'next' : 'latest'
  const output = process.env.GITHUB_OUTPUT
  if (output) {
    fs.appendFileSync(output, `version=${version}\nnpm-tag=${npmTag}\nrelease-tag=v${version}\n`)
  }
  console.log(`Release preflight passed for ${packageJson.name}@${version} (${npmTag})`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
