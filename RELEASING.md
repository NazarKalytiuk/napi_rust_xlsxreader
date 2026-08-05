# Release runbook

This package publishes one root npm package and six platform packages through `.github/workflows/release.yml`. npm publication is not atomic: never replace artifacts or rebuild already-published platform packages for the same version.

## One-time setup

1. Create the public GitHub repository with the exact identity used by npm provenance:
   - owner: `NazarKalytiuk`
   - repository: `napi_rust_xlsxreader`
   - URL: `https://github.com/NazarKalytiuk/napi_rust_xlsxreader`
2. Push this repository and make `main` the default protected branch.
3. In GitHub, create an environment named `npm`. Add required reviewers if releases should require manual approval.
4. Create an npm granular automation token that can publish public packages under `@nazarkalytiuk`. The first release needs token access because the root and platform packages do not exist yet.
5. Store that token as the `NPM_TOKEN` secret in the GitHub `npm` environment. Never commit an npm token or write it to workflow logs.
6. Enable GitHub Actions for the repository. The release matrix uses GitHub-hosted x64 and ARM64 runners.

The release job has `id-token: write` for npm provenance and `contents: write` for the GitHub release. No additional GitHub token is required; Actions supplies `GITHUB_TOKEN`.

## Published package set

A release is complete only when all seven packages exist at the same exact version:

- `@nazarkalytiuk/rusc-xlsx-reader`
- `@nazarkalytiuk/rusc-xlsx-reader-darwin-universal`
- `@nazarkalytiuk/rusc-xlsx-reader-win32-x64-msvc`
- `@nazarkalytiuk/rusc-xlsx-reader-win32-arm64-msvc`
- `@nazarkalytiuk/rusc-xlsx-reader-linux-x64-gnu`
- `@nazarkalytiuk/rusc-xlsx-reader-linux-arm64-gnu`
- `@nazarkalytiuk/rusc-xlsx-reader-linux-x64-musl`

## Preflight

Run from the intended release commit:

```bash
npm ci
npm run build
npm run release:check
npm run check
npm test
npm pack --dry-run --ignore-scripts
```

Before tagging, confirm the branch CI workflow is green. `package.json`, `package-lock.json`, `Cargo.toml`, and the generated native loader must contain the same version.

## Create a release

For releases after 1.0.0, let npm update the package and lockfile, and let the `version` lifecycle run `napi version` to synchronize Rust metadata and generated bindings:

```bash
npm version patch -m "%s"
git push origin main --follow-tags
```

Use `minor` or `major` instead of `patch` as appropriate. For a prerelease:

```bash
npm version prerelease --preid next -m "%s"
git push origin main --follow-tags
```

The release workflow accepts only an existing tag exactly equal to `v<package.json version>`. Stable versions publish with the `latest` npm dist-tag; prereleases publish with `next`.

For the initial 1.0.0 release, the files are already versioned `1.0.0`. After committing and pushing the repository, create and push `v1.0.0` without running `npm version` again.

## Release gates

The workflow performs these steps before publishing the root package:

1. Validates tag, package metadata, synchronized versions, target list, and npm version availability.
2. Runs Rust formatting, Clippy with warnings denied, Rust tests, and TypeScript checks.
3. Builds every configured native target.
4. Combines and tests both slices of the universal macOS binary.
5. Runs the JavaScript suite on Node.js 22 and 24 for Windows x64/ARM64, Linux glibc x64/ARM64, Linux musl x64, and macOS universal x64/ARM64.
6. Assembles NAPI platform packages and rejects missing, extra, mismatched, or empty artifacts.
7. Publishes platform packages first and the root package last with SLSA provenance.
8. Creates the GitHub release, uploads all six native binaries plus `SHA256SUMS`, and verifies npm metadata, dist-tags, provenance, and GitHub assets.

A green build job alone is not a release; the final `Verify published release` step must pass.

## Trusted publishing after the first release

After all seven npm packages exist, each package can be configured with the same npm trusted publisher:

- provider: GitHub Actions
- owner: `NazarKalytiuk`
- repository: `napi_rust_xlsxreader`
- workflow filename: `release.yml`
- environment: `npm`
- allowed action: `npm publish`

Configure the root and all six platform packages before removing `NPM_TOKEN`. Test one release end to end before deleting the token secret.

## Partial failure recovery

Do not create a new version immediately and do not rebuild different binaries under a partially published version.

1. Inspect the failed workflow and npm metadata for the root plus all six platform packages.
2. If the publish job failed but its build artifacts are still retained, use GitHub's **Re-run failed jobs** so the same artifacts are reused.
3. Do not use a fresh manual workflow dispatch after any platform package has published; that would rebuild artifacts for an immutable npm version.
4. If every platform package exists and only the root failed, follow the NAPI-RS partial-release procedure and publish the unchanged root tarball with lifecycle scripts disabled.
5. If the root exists with a missing platform package, publish the missing unchanged platform artifact immediately or deprecate the broken root version.

Never use `npm publish --dry-run` in this repository: npm lifecycle scripts can invoke `napi prepublish` and publish real platform packages. Use `npm pack --dry-run --ignore-scripts` and `napi prepublish -t npm --dry-run` instead.
