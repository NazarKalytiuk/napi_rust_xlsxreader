# Release runbook

This package publishes one root npm package and seven platform packages through `.github/workflows/release.yml`. npm publication is not atomic: never replace artifacts or rebuild already-published platform packages for the same version.

## One-time setup

1. Create the public GitHub repository with the exact identity used by npm provenance:
   - owner: `NazarKalytiuk`
   - repository: `napi_rust_xlsxreader`
   - URL: `https://github.com/NazarKalytiuk/napi_rust_xlsxreader`
2. Push this repository and make `main` the default protected branch.
3. In GitHub, create an environment named `npm`. Add required reviewers if releases should require manual approval.
4. Configure npm trusted publishing for the root and all seven platform packages, as described in [npm authentication](#npm-authentication).
5. Enable GitHub Actions for the repository. The release matrix uses GitHub-hosted x64 and ARM64 runners.

The release job has `id-token: write` for npm trusted publishing and provenance, and `contents: write` for the GitHub release. It needs no repository or environment secrets: npm credentials come from OIDC, and Actions supplies `GITHUB_TOKEN`.

## Published package set

A release is complete only when all eight packages exist at the same exact version:

- `@nazarkalytiuk/rusc-xlsx-reader`
- `@nazarkalytiuk/rusc-xlsx-reader-darwin-universal`
- `@nazarkalytiuk/rusc-xlsx-reader-win32-x64-msvc`
- `@nazarkalytiuk/rusc-xlsx-reader-win32-arm64-msvc`
- `@nazarkalytiuk/rusc-xlsx-reader-linux-x64-gnu`
- `@nazarkalytiuk/rusc-xlsx-reader-linux-arm64-gnu`
- `@nazarkalytiuk/rusc-xlsx-reader-linux-x64-musl`
- `@nazarkalytiuk/rusc-xlsx-reader-linux-arm64-musl`

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

`main` is protected, so the version bump reaches it through a pull request like any other change; only the tag is pushed directly.

On a release branch, bump the npm version without tagging:

```bash
npm version patch --no-git-tag-version
```

Use `minor`, `major`, or `prerelease --preid next` instead of `patch` as appropriate. This updates `package.json` and `package-lock.json`. Its `version` lifecycle runs `napi version`, which only updates the generated `npm/` platform directories, so synchronize the Rust crate and the generated loader yourself:

1. Set `version` in `Cargo.toml` to the new version.
2. Run `npm run build` to refresh `Cargo.lock` and regenerate `index.js`.
3. Run `npm run release:check` and the preflight above.

Commit the result with the bare version as its message, open a pull request, and merge it once CI is green. Then tag the merged commit on `main` and push only the tag:

```bash
git switch main
git pull --ff-only
git tag -a vX.Y.Z -m vX.Y.Z
git push origin vX.Y.Z
```

The release workflow accepts only an existing tag exactly equal to `v<package.json version>`. Stable versions publish with the `latest` npm dist-tag; prereleases publish with `next`.

For the initial 1.0.0 release, the files are already versioned `1.0.0`. After committing and pushing the repository, create and push `v1.0.0` without running `npm version` again.

## Release gates

The workflow performs these steps before publishing the root package:

1. Validates tag, package metadata, synchronized versions, and target list, and checks that every package already exists on npm without this version.
2. Runs Rust formatting, Clippy with warnings denied, Rust tests, and TypeScript checks.
3. Builds every configured native target.
4. Combines and tests both slices of the universal macOS binary.
5. Runs the JavaScript suite on Node.js 22, 24, and 26 for Windows x64/ARM64, Linux glibc x64/ARM64, Linux musl x64/ARM64, and macOS universal x64/ARM64.
6. Assembles NAPI platform packages and rejects missing, extra, mismatched, or empty artifacts.
7. Publishes platform packages first and the root package last with SLSA provenance, creates the GitHub release, and uploads all seven native binaries.
8. Uploads `SHA256SUMS` in a separate idempotent finalization job, then verifies npm metadata, dist-tags, and provenance. It also downloads every npm tarball and checks it against its published integrity, and checks that the native binary in each platform tarball and in the GitHub release matches `SHA256SUMS`.

A green build or publish job alone is not a release; the final `Finalize and verify published release` job must pass. npm processes publishes asynchronously: a new version document, or its tarball, can answer 404 for several minutes after the publish, and `npm install` silently skips an optional platform package whose tarball it cannot fetch. The verifier therefore retries 404 and server errors for up to ten minutes per request, and passes only once every package is installable.

## npm authentication

Releases publish through npm trusted publishing (OIDC). Every `npm publish` in the publish job, including the platform publishes started by `napi prepublish`, exchanges the job's GitHub OIDC token for a short-lived token scoped to that one package. Each of the eight packages therefore needs its own trusted publisher with exactly these fields, which are case-sensitive:

- provider: GitHub Actions
- repository: `NazarKalytiuk/napi_rust_xlsxreader`
- workflow filename: `release.yml`
- environment: `npm`
- permission: publish

Configure them from a terminal signed in with `npm login`. npm asks for a 2FA confirmation per package and rejects the change with E401 without an interactive login:

```bash
for suffix in "" -darwin-universal -win32-x64-msvc -win32-arm64-msvc -linux-x64-gnu -linux-arm64-gnu -linux-x64-musl -linux-arm64-musl; do
  npm trust github "@nazarkalytiuk/rusc-xlsx-reader$suffix" \
    --repo NazarKalytiuk/napi_rust_xlsxreader --file release.yml --env npm \
    --allow-publish --yes
done
```

Check each package with `npm trust list <package>`. npm does not validate a configuration when it is saved, only when a publish uses it, and a new configuration expires if no publish uses it within two days. Create configurations shortly before the release that first needs them.

### Adding a platform package

Adding a NAPI target adds a platform package. npm configures trusted publishers only for packages that already exist, and `npm trust github` fails for a new name, so trusted publishing cannot publish its first version. The release preflight therefore rejects a release while any package is missing, before anything is built; without that check the publish would fail partway through and leave a partial release. Before tagging the first release that includes the target:

1. From a terminal signed in with `npm login`, publish a placeholder `0.0.0` of the new package. It has no binary, and the root package never depends on it because the root pins exact versions:

   ```bash
   suffix=linux-arm64-musl # the new package's suffix
   mkdir "placeholder-$suffix" && cd "placeholder-$suffix"
   cat > package.json <<JSON
   {
     "name": "@nazarkalytiuk/rusc-xlsx-reader-$suffix",
     "version": "0.0.0",
     "description": "Placeholder that reserves the package for trusted publishing; releases publish the native binding.",
     "license": "MIT",
     "repository": { "type": "git", "url": "git+https://github.com/NazarKalytiuk/napi_rust_xlsxreader.git" }
   }
   JSON
   npm publish --access public
   ```

2. Configure its trusted publisher with the loop above, and push the release tag within two days.

Once a release has published through trusted publishing, restrict token publishing on every package: **Settings → Publishing access → Require two-factor authentication and disallow tokens**, or `npm access set mfa=publish <package>` from a 2FA login. Trusted publishing does not use traditional tokens, so it keeps working.

## Partial failure recovery

Do not create a new version immediately and do not rebuild different binaries under a partially published version.

1. Inspect the failed workflow and npm metadata for the root plus all seven platform packages.
2. If the publish job failed before all packages exist and its build artifacts are still retained, use GitHub's **Re-run failed jobs** so the same artifacts are reused. An authentication error on a package (E401, E404, or ENEEDAUTH) means its trusted publisher is missing, expired, or does not match: fix it as described in [npm authentication](#npm-authentication) before re-running.
3. If publishing succeeded but `Finalize and verify published release` failed with `Unable to read` errors, wait for npm registry propagation and re-run failed jobs. The finalization job never republishes an immutable package version. An integrity or `SHA256SUMS` mismatch is not a propagation delay: the published package differs from the release binaries, so treat that version as broken and deprecate it.
4. Do not use a fresh manual workflow dispatch after any platform package has published; that would rebuild artifacts for an immutable npm version.
5. If every platform package exists and only the root failed, follow the NAPI-RS partial-release procedure and publish the unchanged root tarball with lifecycle scripts disabled.
6. If the root exists with a missing platform package, publish the missing unchanged platform artifact immediately or deprecate the broken root version.

Never use `npm publish --dry-run` in this repository: npm lifecycle scripts can invoke `napi prepublish` and publish real platform packages. Use `npm pack --dry-run --ignore-scripts` and `napi prepublish -t npm --dry-run` instead.
