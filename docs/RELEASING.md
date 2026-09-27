# Releasing @mnemoverse/ai-sdk

Releases are made by `.github/workflows/release.yml`, from a `vX.Y.Z` tag on main, with npm provenance. After the first release, a person releases nothing by hand: the surface-bump contour (`.github/workflows/surface-bump.yml`, [AUTO-UPDATE-CONTOUR.md](AUTO-UPDATE-CONTOUR.md)) tags and publishes every surface bump, and a person tags only releases of this package's own changes.

## Every release

1. **Date the section.** On a branch, change `## [X.Y.Z]` in CHANGELOG.md to `## [X.Y.Z] - YYYY-MM-DD` (the release day, UTC), and make sure package.json's `version` is X.Y.Z. Merge it through a PR with CI green. An undated section is the placeholder for a version that is not released, and release.yml refuses it.
2. **Tag that commit on main, and push the tag:**

   ```sh
   git fetch origin
   git tag -a vX.Y.Z -m "@mnemoverse/ai-sdk X.Y.Z" origin/main
   git push origin vX.Y.Z
   ```

3. **Watch release.yml** (`gh run watch --repo mnemoverse/ai-sdk`). Its **build** job checks the tag and the tree, runs the gate and packs, with no publish credential. Its **publish** job, the only one with `id-token: write` and the npm token, runs no repository code and no dependency: it checks the tarball's digest and publishes it. Its **verify** job insists that npm serves the version with the build job's bytes and with provenance from `release.yml` at the tag. Then it creates the GitHub Release from the section.
4. **If it failed after npm accepted the publish,** run it again on the tag: `gh workflow run release.yml --repo mnemoverse/ai-sdk --ref vX.Y.Z`. It skips the publish when npm already serves the same bytes, and it stops when npm serves different ones. The contour also re-runs a tagged version that npm does not serve.

## The first release, 0.1.0, and the switch to trusted publishing

npm trusted publishing is configured on the package's settings page, which exists only once the package does. So 0.1.0 is published once with a short-lived token, and every later version without one.

Before: this repository is **public** (npm does not generate provenance for a private repository, and release.yml publishes only with provenance), and the `NPM_TOKEN` repository secret holds a granular token with read and write access to the `@mnemoverse` scope that can publish without an interactive 2FA prompt.

1. Date `## [0.1.0]` (step 1 above), merge, tag `v0.1.0`, push the tag, watch release.yml.
2. Check what npm serves:

   ```sh
   npm view @mnemoverse/ai-sdk@0.1.0 version dist.attestations.provenance.predicateType
   # 0.1.0, https://slsa.dev/provenance/v1
   ```

3. On npmjs.com, **@mnemoverse/ai-sdk → Settings → Trusted publishing → GitHub Actions**:
   - Organization or user: `mnemoverse`
   - Repository: `ai-sdk`
   - Workflow filename: `release.yml` (only the file name; it is the only workflow that publishes, and the contour reaches it by dispatch, so it is always the top-level workflow npm checks)
   - Environment name: empty
   - Allowed actions: allow **`npm publish`**. A trusted publisher created after 2026-09-03 allows only `npm stage publish` unless you select it, and a staged publish waits for a maintainer's 2FA approval, which an automatic contour cannot give.
4. **Settings → Publishing access:** "Require two-factor authentication and disallow tokens".
5. **Remove the token:** `gh secret delete NPM_TOKEN --repo mnemoverse/ai-sdk`, and revoke the token on npmjs.com (Access Tokens). From now on release.yml finds no token and uses trusted publishing alone.

The next release proves the OIDC path; nothing can test it earlier without publishing a version. If that publish is refused, release.yml fails before anything is published, the contour opens its issue, and the fix is the trusted-publisher entry above (the file name is case-sensitive and includes `.yml`).

## What the workflows need from the repository

- **Actions permissions:** the defaults. Each workflow asks for its own permissions per job: `release.yml` for `id-token: write` (publish job only) and `contents: write` (GitHub Release job); `surface-bump.yml` for `contents: write` (the commit job only), `actions: write` (to dispatch release.yml) and `issues: write` (the report).
- **No required pull request on main for the contour's push.** The contour commits the bump to main with `GITHUB_TOKEN` after its checks are green. A ruleset that requires pull requests on main refuses that push; the run is then red and says so. Keep main's rules compatible, or give the contour a GitHub App token on the ruleset's bypass list.
- **Tag rules,** if added, must let the owner and the contour create `v*` tags.
- **Optional variable** `SURFACE_BUMP_COOLDOWN_HOURS`: wait that many hours after an upstream release before bumping. Unset, the contour waits 6 hours while upstream provenance is advisory and not at all once it is required.
- **Upstream dispatch:** `@mnemoverse/mcp-memory-server`'s release job starts `surface-bump.yml` here with a workflow dispatch (`ref: main`, `inputs.version`) once npm serves a new version and its GitHub Release exists. Its token is a fine-grained token (or GitHub App) with **Actions: read and write** on this repository and nothing else: never Contents, which could push commits and `v*` tags here, and a tag pushed with a personal token starts release.yml. Without it, the contour's schedule (every six hours) picks the release up.
- **Branches:** the contour runs only from `main`, but a workflow dispatch runs the file of the ref it names, so delete merged branches (Settings → General → "Automatically delete head branches").
- **Once the repository is public (rulesets become available):** a tag ruleset on `v*` that only the owner and the contour may create, and a ruleset on `main`. Both must leave the contour's `GITHUB_TOKEN` push of the bump commit and tag working, or the contour must push with a GitHub App token on the bypass list; decide before enabling them.
