'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { releaseTargets } = require('./release-targets.js')

const root = path.join(__dirname, '..')
const npmDirectory = path.join(root, 'npm')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const targets = releaseTargets(packageJson)
const errors = []
const checksums = []
const manifestIndex = process.argv.indexOf('--manifest')
const manifestPath = manifestIndex === -1 ? null : process.argv[manifestIndex + 1]

function check(condition, message) {
  if (!condition) errors.push(message)
}

function equalValues(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function hashFile(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}

check(fs.existsSync(npmDirectory), 'npm package directory does not exist')

if (fs.existsSync(npmDirectory)) {
  const actualDirectories = fs
    .readdirSync(npmDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const expectedDirectories = targets.map((target) => target.directory).sort()
  check(
    equalValues(actualDirectories, expectedDirectories),
    `npm directories ${actualDirectories.join(', ')} must equal ${expectedDirectories.join(', ')}`
  )
}

for (const target of targets) {
  const targetDirectory = path.join(npmDirectory, target.directory)
  const targetManifestPath = path.join(targetDirectory, 'package.json')
  const packagedBinary = path.join(targetDirectory, target.binaryName)
  const rootBinary = path.join(root, target.binaryName)

  check(fs.existsSync(targetManifestPath), `${target.packageName} is missing package.json`)
  check(fs.existsSync(packagedBinary), `${target.packageName} is missing ${target.binaryName}`)
  check(fs.existsSync(rootBinary), `Root workspace is missing ${target.binaryName}`)

  if (!fs.existsSync(targetManifestPath)) continue
  const targetManifest = JSON.parse(fs.readFileSync(targetManifestPath, 'utf8'))
  check(targetManifest.name === target.packageName, `${target.directory} has package name ${targetManifest.name}`)
  check(targetManifest.version === packageJson.version, `${target.packageName} version must be ${packageJson.version}`)
  check(targetManifest.main === target.binaryName, `${target.packageName} main must be ${target.binaryName}`)
  check(equalValues(targetManifest.files, [target.binaryName]), `${target.packageName} files must contain only its binary`)
  check(equalValues(targetManifest.os, target.os), `${target.packageName} has invalid os constraints`)
  check(equalValues(targetManifest.cpu, target.cpu), `${target.packageName} has invalid cpu constraints`)
  check(equalValues(targetManifest.libc, target.libc), `${target.packageName} has invalid libc constraints`)

  if (!fs.existsSync(packagedBinary) || !fs.existsSync(rootBinary)) continue
  const packagedSize = fs.statSync(packagedBinary).size
  const rootSize = fs.statSync(rootBinary).size
  check(packagedSize > 1024, `${target.binaryName} is unexpectedly small (${packagedSize} bytes)`)
  check(rootSize === packagedSize, `Root and packaged ${target.binaryName} sizes differ`)

  const packagedHash = hashFile(packagedBinary)
  const rootHash = hashFile(rootBinary)
  check(rootHash === packagedHash, `Root and packaged ${target.binaryName} checksums differ`)
  checksums.push(`${packagedHash}  ${target.binaryName}`)

  const nodeFiles = fs.readdirSync(targetDirectory).filter((filename) => filename.endsWith('.node'))
  check(
    equalValues(nodeFiles, [target.binaryName]),
    `${target.packageName} must contain exactly ${target.binaryName}`
  )
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  if (manifestPath) {
    const output = path.resolve(root, manifestPath)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, `${checksums.sort().join('\n')}\n`)
  }
  console.log(`Verified ${targets.length} native packages for ${packageJson.name}@${packageJson.version}`)
}
