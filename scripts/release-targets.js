'use strict'

const TARGETS = new Map([
  [
    'universal-apple-darwin',
    { suffix: 'darwin-universal', os: ['darwin'] },
  ],
  [
    'x86_64-pc-windows-msvc',
    { suffix: 'win32-x64-msvc', os: ['win32'], cpu: ['x64'] },
  ],
  [
    'aarch64-pc-windows-msvc',
    { suffix: 'win32-arm64-msvc', os: ['win32'], cpu: ['arm64'] },
  ],
  [
    'x86_64-unknown-linux-gnu',
    { suffix: 'linux-x64-gnu', os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
  ],
  [
    'aarch64-unknown-linux-gnu',
    { suffix: 'linux-arm64-gnu', os: ['linux'], cpu: ['arm64'], libc: ['glibc'] },
  ],
  [
    'x86_64-unknown-linux-musl',
    { suffix: 'linux-x64-musl', os: ['linux'], cpu: ['x64'], libc: ['musl'] },
  ],
])

function releaseTargets(packageJson) {
  const configured = packageJson.napi?.targets
  const binaryName = packageJson.napi?.binaryName

  if (!Array.isArray(configured) || configured.length === 0) {
    throw new Error('package.json napi.targets must be a non-empty array')
  }
  if (typeof binaryName !== 'string' || binaryName.length === 0) {
    throw new Error('package.json napi.binaryName must be a non-empty string')
  }
  if (new Set(configured).size !== configured.length) {
    throw new Error('package.json napi.targets contains duplicates')
  }

  return configured.map((target) => {
    const metadata = TARGETS.get(target)
    if (!metadata) {
      throw new Error(`Release target ${target} has no packaging contract`)
    }

    return {
      target,
      ...metadata,
      directory: metadata.suffix,
      packageName: `${packageJson.name}-${metadata.suffix}`,
      binaryName: `${binaryName}.${metadata.suffix}.node`,
    }
  })
}

module.exports = { releaseTargets }
