# Auto-update contour for consumers of the Mnemoverse MCP surface

This is the approved way a **consumer** of `@mnemoverse/mcp-memory-server` follows the package's releases, so that no consumer drifts from it. A consumer is anything that exposes or describes the Mnemoverse MCP surface somewhere else: this AI SDK adapter, the hosted connector, the docs site, the plugins and extensions, the marketing and listing texts.

The page is a template. `@mnemoverse/ai-sdk` is the reference implementation, and the sections marked **In this repository** say how it does each step. Another consumer copies the mechanism and replaces only those parts; the table in [Consumers](#consumers-what-each-step-means) says what each step means for it.

## The rule this contour serves

The package defines the whole MCP surface: tool descriptions, schemas, annotations and response wording. They live in the package and nowhere else. A consumer:

1. **Never rewrites any of it by hand.** Code runs the package's own `registerMemoryTools` (and, if it needs them, `registerMemoryResources` and `registerMemoryPrompts`) from `@mnemoverse/mcp-memory-server/shared`. Text quotes the package's canon (`src/configs/source.json`) or links to it.
2. **Supplies only an `apiFetch` bound to the caller's identity** (code consumers). It rejects exactly with the three error classes that `./shared` exports: `ApiError`, `NetworkError` and `UnreadableBodyError`.
3. **Depends on the package by EXACT version** (`"x.y.z"`, never a range), so each consumer release exposes exactly one surface version.
4. **Has its own version, and shows the package version next to it as the surface version.**

Drift is then never something a person has to watch for. At every moment, either the consumer is on the latest surface, or a check is red, an issue is open, and both say why.

## The contour

```
MCP release, served by npm, tagged on main, with its GitHub Release
      │  workflow_dispatch surface-bump.yml {version}                     schedule (every 6 h): the fallback
      ▼                                                                   │
plan ── npm latest vs the pin ── nothing to do? green, stop ◄─────────────┘
      │  cool-down: 6 h while upstream provenance is advisory, none once required ── too young? wait
      │  source: tag vX.Y.Z on the package's main + its GitHub Release: required
      │  upstream provenance: advisory until the package attests, then required
      │  registry signatures (npm audit signatures) on a clean install of the new version
      ▼
bump ── pin x.y.z → X.Y.Z, lockfile, own semver, CHANGELOG "Surface: X.Y.Z", surface line in the README
      ▼
checks ── gate + contract tests + compatibility matrix + install legs, on the bumped tree
      │
      ├── any red ──► nothing committed, tagged or published; ONE issue "surface bump blocked: X.Y.Z"; the run stays red
      ▼ all green
commit to main + tag vX.Y.Z (one atomic push)
      ▼
release: the consumer's release workflow, dispatched ON the tag
      │  build job (no credential): checks, gate, pack ── publish job (OIDC only): that tarball, nothing else
      ▼
      ▼
verify: npm serves the version, with the bytes built and provenance from the release workflow at the tag

lag guard (daily, in CI): red when the pin has been behind npm's latest for more than 24 h
```

All of it runs in one concurrency group, so a dispatch and a scheduled run can never race each other into two tags.

## Consumers: what each step means

| Consumer | Trigger | Bump | Checks | Release |
|---|---|---|---|---|
| **Adapter package** (`@mnemoverse/ai-sdk`) | dispatch + schedule | exact pin, lockfile, own semver, CHANGELOG, README surface line | contract tests 1-4, gate, matrix | publish to npm from `release.yml` on the tag |
| **Hosted connector** (`mnemoverse-mcp-remote`) | dispatch + schedule | exact pin, lockfile, own version | contract tests 1-3 against its own `tools/list`, its gate | deploy (replaces publish); the rest is identical |
| **Plugins and extensions** (Claude plugin, VS Code) | dispatch + schedule | the pinned server version they install or bundle | the tool list they show equals the package's; their own tests | their marketplace release, from a tag |
| **Docs site** (`mnemoverse-docs`) | dispatch + daily poll (today a `repository_dispatch` `mcp-release`, whose token needs Contents: write there; to move to a workflow dispatch like the others) | version facts in its data files | the docs build; every tool name and count equals the package's | deploy |
| **Marketing and listing texts** (kept privately) | dispatch + schedule | the version and description copied from the canon | a private text check; tool count equals the canon's | the listing's own update path; a person where a form needs one |

A consumer that deploys instead of publishing replaces the release step with its deploy, and keeps everything before it, the provenance gate included: it runs the package in production.

### 1. Trigger

The trigger is a new `@mnemoverse/mcp-memory-server` version on npm. Two sources, the same two for every consumer:

- **Push.** The package's release job starts each registered consumer's contour workflow with a **workflow dispatch**, on the consumer's default branch, with `inputs.version`, and only after npm actually serves the new version and the GitHub Release exists:

  ```sh
  gh api -X POST repos/<owner>/<consumer>/actions/workflows/<contour>.yml/dispatches -f ref=main -f 'inputs[version]=X.Y.Z'
  ```

  The input is a hint: the target is always npm's `latest`, read by the consumer itself.
- **Poll.** A scheduled run of the same workflow, the fallback for a lost dispatch, the retry after a red run, and the pickup after a cool-down.

**Never `repository_dispatch` for a consumer.** Its endpoint needs a token with **Contents: write** on the consumer's repository, and that permission also pushes commits and tags there. A tag pushed with a personal token starts the consumer's release workflow, so the upstream token would become a publish credential for every consumer it reaches. A workflow dispatch needs only **Actions: write**. That permission can start, re-run or cancel workflow runs; it cannot write a commit, a branch or a tag. Because a dispatch runs the workflow file of the ref it names, the contour refuses to run from anything but the default branch (a stale branch's older copy could lack a check).

Registering a consumer is one line in the package's `release.yml` (its consumer list: repository and contour workflow file) and access for the package's **consumer dispatch token** to the consumer's repository: a fine-grained token (or GitHub App) with **Actions: read and write** on the consumer repositories only. It is not the token the package uses for the docs site's `repository_dispatch`. Without the token, the poll alone keeps the consumer current, a few hours later.

**In this repository:** `.github/workflows/surface-bump.yml` has a `workflow_dispatch` trigger with a `version` input, runs every six hours, and can be run by hand. It has no `repository_dispatch` trigger, its plan refuses any ref but `main`, and `test/workflows.test.ts` keeps both that way.

### 2. Plan

The plan decides from facts it reads, never from state it keeps:

| Plan | When | What happens |
|---|---|---|
| `bump` | npm's latest is newer than the pin, and the consumer's current version is released | the rest of the contour |
| `release` | the consumer's current version is tagged but not published (an earlier release did not finish) | the release step alone, on that tag |
| `wait` | a bump is due, but the new upstream release is younger than the cool-down (6 h by default while upstream provenance is advisory) | nothing; a later scheduled run bumps it |
| `blocked` | a bump is due, but the consumer's current version is not released (a person is preparing one) | red, and the issue names the release to finish |
| `none` | the pin is current | nothing |

**In this repository:** `scripts/surface-plan.mjs` (`test/surface-plan.test.ts` pins every row). Released means a dated CHANGELOG section and a version npm serves. The cool-down is 6 hours while upstream provenance is advisory and none once it is required (`cooldownFor`); the repository variable `SURFACE_BUMP_COOLDOWN_HOURS` overrides both when set. Keep it under the lag guard's 24 hours: with the six-hourly schedule, a 6-hour cool-down bumps a release 6 to 12 hours after npm serves it.

### 3. Bump

One bot commit changes:

- **the pin:** `"@mnemoverse/mcp-memory-server": "X.Y.Z"`, exact;
- **the lockfile;**
- **the consumer's own version,** by the version rule below;
- **a dated CHANGELOG section** naming the new surface version, which takes whatever was unreleased;
- **the surface line** wherever the consumer shows it (for an npm package: the README, which is the npm page).

It changes nothing else, and the contour checks that. There is no code in a bump, because a consumer holds no copy of the surface to update.

**Version rule:** the surface component that changed changes in the consumer too.

| Surface change | Consumer release |
|---|---|
| patch | patch |
| minor | minor |
| major | major |

The package treats any change to a request body as a minor.

**In this repository:** `node scripts/bump-surface.mjs X.Y.Z` edits `package.json`, `CHANGELOG.md` and `README.md`; `pnpm install` refreshes `pnpm-lock.yaml`. When the current version is not released yet (its CHANGELOG section has no date), the script folds the new surface into it instead of cutting a release. `test/version.test.ts` fails when the CHANGELOG or the README does not name the pinned version.

### 4. Checks

These must be green on the bumped tree before anything is committed. Every code consumer implements the same four checks against its own exposure of the surface.

1. **The tool set equals the package's registered set.** The tools the consumer's client actually sees must be exactly the names that `registerMemoryTools` registers:
   - **for an adapter:** what its client's `tools()` or `tools/list` returns;
   - **for a server:** what its `tools/list` answers.

   A tool added, removed or renamed upstream turns this red. If the consumer keeps a security classification per tool name, the classification must also cover exactly the registered set. A new upstream tool then needs a person to classify it, and it is never exposed unreviewed. That is a deliberate stop in an otherwise automatic contour. The other two are a change to the package's zod range (check 4) and, once the package attests, a release without verified provenance (step 5).
2. **The metadata is byte-equal.** Descriptions, input schemas, titles and annotations, as the consumer exposes them, equal the package's own `tools/list`. The only differences allowed are ones the consumer's MCP client adds to every MCP tool, stated in the test.
3. **A real round trip per tool, against a mocked `apiFetch` or `fetch`.** For each tool, and for its error paths, the result the consumer returns equals the package's own answer, compared byte for byte:
   - the text;
   - `isError`;
   - `structuredContent`;
   - the requests sent on the wire.

   The error paths are: a 401, a bare 404, a 429 with `Retry-After`, a 5xx, a network failure, an unreadable 2xx and a 204. The ground truth is the package's own server with its own `apiFetch`, run in a child process with a clean environment. Nothing reaches the network.
4. **Install legs: an unsupported install fails loudly.** Checks 1 to 3 run in the consumer's own repository, with its own lockfile, so they see only the one dependency tree the consumer chose. An application's install can pair things differently. The consumer is therefore packed and installed as an application installs it, with **pnpm and with npm**, next to each dependency resolution it does not support. Each must fail loudly: a refused or warned install, and an error when the surface is built. A surface that is built but degraded is red. One supported install of each package manager is the control.

   The case that makes this check necessary: the package's schemas are zod schemas, and the MCP server that registers them converts them with the zod its own copy of `@modelcontextprotocol/sdk` resolves. In the application's tree that is not necessarily the package's zod. pnpm keeps one SDK copy per zod peer, and the consumer's copy is paired with the application's zod. npm hoists one SDK next to the application's root zod. With an older zod, every description and limit is dropped, and nothing fails.

Checks 1 to 4 prove that the consumer exposes exactly what the installed upstream defines. They cannot prove that the upstream release is authentic: a tampered release that keeps the surface identical passes all four. That is step 5's job, and step 5 runs first, in the plan.

Plus the consumer's usual gate: typecheck, unit tests, build, and its compatibility matrix.

A text consumer (docs, listings) replaces checks 1 to 4 with: every tool name and the tool count it prints equal the package's, and the canon's text rules pass (a private check).

**In this repository:**

- **Contract.** `test/contract.test.ts` covers checks 1 to 3. It runs the package's real stdio entry through `test/helpers/reference-runner.mjs` and compares it against the full pipeline: the AI SDK MCP client, the custom transport, the in-process `McpServer` and this package's `apiFetch`.
- **Install legs.** `node scripts/test-matrix.mjs --legs` covers check 4. The packed package goes into pnpm and npm apps with zod 3.25 and 4.1, and into an ai 5 app next to the latest `@ai-sdk/mcp`. Each must be refused or warned at install and fail at creation. A pnpm app and an npm app with zod 4 are the controls.
  - `zod` is a peer dependency with the package's own range, so npm refuses the conflicting install and pnpm warns. `test/version.test.ts` keeps the peer equal to the package's range. A bump that changes the range turns it red: a person decides, because it changes what applications must install.
  - At creation, `src/fidelity.ts` compares every listed input field with what the package's own zod declares for it, through Standard JSON Schema, and throws `MnemoverseSurfaceError` when anything is lost. `src/compat.ts` refuses an `ai` / `@ai-sdk/mcp` pair outside the matrix.
- **No copies.** `test/no-copies.test.ts` also fails if any 40-character run of the package's text appears in `src/`, including the package's module-private strings.
- **Gate.** `pnpm run gate`, then `node scripts/test-matrix.mjs --ai N` for ai 5, 6 and 7 on Node 22 and 24, each with its own `@ai-sdk/mcp` major, and `scripts/release-check.mjs` on the bumped tree.

### 5. Source and provenance gate

The consumer runs the package in its users' processes, where every request passes through it, API key included. An automatic bump republishes whatever the upstream release contains under the consumer's name, with the consumer's own provenance. So the new upstream version must prove where it came from, in the plan, before anything is bumped:

- **Source (always required).** The tag `vX.Y.Z` exists in the package's public repository, its commit is on the default branch, and a published (not draft) GitHub Release exists for it. An npm credential alone can publish a version but can produce none of these. The package's release workflow creates the Release only after npm serves the version with the bytes that workflow built itself (its publish step compares them), so a version somebody else published first does not get one either.
- **Provenance present.** npm serves `dist.attestations` for the version, with an SLSA v1 provenance.
- **For this tarball.** The provenance statement's subject is the version's package URL **as npm writes it**: `pkg:npm/%40scope/name@x.y.z` for a scoped package (npm encodes the scope's `@`; comparing with `pkg:npm/@scope/...` refuses every real attestation). Its sha512 digest equals the version's `dist.integrity`.
- **From the expected builder.** The predicate names the package's own source repository and its release workflow, and a release tag or the default branch as the ref. The expected values are the consumer's configuration. They are never read from the package, because a tampered release controls its own metadata.
- **Registry signatures.** `npm audit signatures` passes on a clean install of the new version. This checks that the download is what the registry signed. It is **not** an authenticity check: the registry signs every tarball it accepts, whoever published it, and a version published with a leaked token passes it.

**Provenance: advisory, then required, by itself.** The package has so far been published with a token, without attestations (0.1.0 to 0.12.1). While NO version of the package carries attestations, a missing provenance is the known state: the check warns, comments on one standing issue, and the bump goes on, with the source check as the one thing a leaked npm token cannot pass. From the first version that carries attestations, provenance is how the package is released, so a version without it did not come from the release workflow (a mistake, or a stolen token), and the check is required: the run stops red and nothing is published. Nobody flips a setting, and publishing without provenance cannot flip it back: the attested versions stay in the package's history.

**Cool-down.** The bump waits until the upstream release is some hours old, so a bad release can be noticed and deprecated upstream first: **6 hours by default while provenance is advisory**, none once it is required. A repository variable overrides both. This keeps the contour automatic; it only moves the pickup to a later scheduled run.

**Pinned tooling.** Every workflow action is pinned to a full commit SHA. The release workflow restores no cache that other workflows write, because a poisoned cache would reach the published tarball.

**No third-party code next to a publish credential.** GitHub gives the OIDC request token (`ACTIONS_ID_TOKEN_REQUEST_URL` and `_TOKEN`) to every step of a job with `id-token: write`, and every step of a job shares one user, one file system and its background processes. So the job that holds `id-token: write` (and the npm token, while one exists) runs no install from the lockfile, no package script and no repository script: it receives the tarball the build job gated and packed, recomputes its digest, and runs `npm publish <tgz> --ignore-scripts`. Everything that executes the dependency tree, the upstream package included, runs in a build job with no credential, on a separate virtual machine. The provenance still names the release workflow at the tag, because it is the same run.

**Upstream prerequisite for the required mode:** the package publishes with npm trusted publishing (its npmjs.com page: Trusted publishing, and `id-token: write` in its release job). Its first attested version switches every consumer's gate to required.

**In this repository:**

- `node scripts/check-upstream-release.mjs --version X.Y.Z` is the source check; `test/check-upstream-release.test.ts` pins each decision against GitHub's real answers for v0.12.1. The contour runs it on every bump, and CI runs it for the pinned version on every PR and daily.
- `node scripts/check-provenance.mjs --auto --version X.Y.Z --json` is the provenance check; `modeFor` decides advisory or required from the package's history, and `test/check-provenance.test.ts` pins each decision, including one real attestation bundle of a scoped package. The expected builder is `https://github.com/mnemoverse/mcp-memory-server` with `.github/workflows/release.yml`.
- CI also runs the provenance check with `--advisory` on every PR and daily, as a report.
- The standing issue is "upstream provenance: @mnemoverse/mcp-memory-server publishes without attestations"; the contour closes it when a verified, required check passes.

### 6. Green: commit, tag, release

- **Commit and tag.** The bumped files are committed to main and tagged `vX.Y.Z` in one atomic push, only if main has not moved since the plan (otherwise the run is red and the next one bumps from the new main).
- **Release on the tag.** A push made with `GITHUB_TOKEN` starts no other workflow; a `workflow_dispatch` sent with it does (docs.github.com, "GITHUB_TOKEN"). So the contour dispatches the consumer's release workflow **on the tag** and waits for it; the contour's run is green only when the release is.
- **Why dispatch and not `workflow_call`.** For a reusable workflow that runs `npm publish`, npm trusted publishing checks the calling workflow's file name, not the called one (docs.npmjs.com/trusted-publishers, Troubleshooting), and the called workflow runs with the caller's `github.sha` (docs.github.com, Reusing workflow configurations). The contour commits the bump in the same run, so a called release workflow would publish the new commit with provenance naming the commit before it. Dispatched on the tag, the release workflow is the top-level workflow and the tag's commit is `github.sha`: one trusted publisher, and provenance that names the exact commit.
- **The release workflow,** in four jobs:
  - **build** (read-only, no credential): refuses anything but a `vX.Y.Z` tag; checks that the tag is the checked-out commit and an ancestor of main; checks that the tag equals the package version, that the CHANGELOG section is dated and names the surface, and that npm serves the pinned surface; installs with lifecycle scripts off; runs the gate once more; packs, and hands on the tarball and its sha512;
  - **publish** (`id-token: write`, the only job with it and with the npm token): no checkout, no install from the lockfile, no repository script. It installs the pinned npm CLI with scripts off, receives the build job's tarball, recomputes its digest, and publishes it with npm trusted publishing and provenance (a token only for a package's very first publish);
  - **verify** (read-only): npm serves the version with the bytes the build job packed and with provenance from this repository's release workflow at the tag;
  - **github-release:** creates the GitHub Release from the CHANGELOG section.

**npm trusted publishing, as npm documents it** (docs.npmjs.com/trusted-publishers):

- It needs npm CLI 11.5.1 or later and Node 22.14.0 or later, GitHub-hosted runners, and `id-token: write`.
- The trusted publisher names the organization, the repository and the workflow **file name** only (for example `release.yml`), which must be in `.github/workflows/`. The fields are case-sensitive, and npm does not check them when they are saved.
- `repository.url` in package.json must match the GitHub repository.
- Provenance is generated automatically for a public package published from a **public** repository, and never from a private one.
- A package can have up to 10 trusted publishers. One created after 2026-09-03 allows `npm stage publish` by default; allow `npm publish` for an automatic contour.
- With trusted publishing on, the package's publishing access can be set to "Require two-factor authentication and disallow tokens".

**In this repository:** `.github/workflows/release.yml`, and [RELEASING.md](RELEASING.md) for the first release and the switch to trusted publishing.

### 7. Red: stop and say why

- Nothing is committed, tagged or published after the failing step.
- The report job opens ONE issue per blocked version, "surface bump blocked: X.Y.Z", or comments on it when it is already open. It links the run and names the failing jobs. The next run retries, and a green run closes the issue.
- Each check's failure message says what a person has to decide:
  - classify a new tool;
  - read a changed schema;
  - follow a changed request contract;
  - check where an upstream npm version came from when it has no tag on the package's main or no GitHub Release (it may have been published with a leaked token);
  - check an upstream release that has no provenance, once provenance is required;
  - finish a release the plan is blocked on.

### 8. Lag guard

A scheduled check compares the exact pin with npm's `latest` for the package. It is red when the pin is behind and the newer release has been on npm for more than 24 hours: the alarm for a contour that did not land.

The same script also fails, with no network needed, when:

- the dependency is declared with a range;
- the lockfile disagrees with the pin.

It is modelled on `mnemoverse-mcp-remote`'s `scripts/check-package-currency.mjs` (PR #51).

**In this repository:** `node scripts/lag-guard.mjs --grace-hours 24`, daily and on every PR in `.github/workflows/ci.yml`.

## What is built where

| Piece | Status in `@mnemoverse/ai-sdk` |
|---|---|
| Exact pin, own semver, surface version (`SURFACE_VERSION`) | built |
| Contract tests 1-3, no-copies check, ai 5/6/7 matrix | built (`pnpm run gate`, `pnpm run test:matrix`) |
| Install legs (check 4), zod peer, schema check and ai pair check at creation | built (`pnpm run test:legs`, `src/fidelity.ts`, `src/compat.ts`) |
| Lag guard, daily and on every PR | built (`.github/workflows/ci.yml`) |
| Plan, bump, checks, commit + tag, release by dispatch, one issue on red | built (`.github/workflows/surface-bump.yml`, `scripts/surface-plan.mjs`, `scripts/bump-surface.mjs`) |
| Cool-down, 6 h by default while upstream provenance is advisory | built (`scripts/surface-plan.mjs`, `cooldownFor`) |
| Source gate: tag on the package's main and its GitHub Release, always required | built (`scripts/check-upstream-release.mjs`) |
| Provenance gate, advisory until the package attests, then required | built (`scripts/check-provenance.mjs --auto`) |
| Release workflow with trusted publishing and a provenance check of its own publish; the publish job runs no third-party code | built (`.github/workflows/release.yml`, `scripts/release-check.mjs`, `check-provenance.mjs --self`) |
| Actions pinned by SHA; one publishing workflow; no cache in it; no event data in scripts; no `repository_dispatch` | built (`test/workflows.test.ts`) |
| Trusted publishing configured on npmjs.com for `@mnemoverse/ai-sdk` | after the first publish ([RELEASING.md](RELEASING.md)) |
| Upstream dispatch to this repository | a PR to `mcp-memory-server`'s `release.yml` (a workflow dispatch of `surface-bump.yml`), plus a consumer dispatch token with Actions: write on this repository |
| Trusted publishing for `@mnemoverse/mcp-memory-server` itself | not done upstream: 0.11.0 to 0.12.1 carry no provenance, so the gate is advisory |

## Checklist for a new consumer

Copy from this repository and change the constants (package names, repository, workflow file names):

- [ ] `scripts/surface-plan.mjs`, `scripts/bump-surface.mjs` (or the consumer's equivalent of the bump: its pin and its surface line), `scripts/check-upstream-release.mjs`, `scripts/check-provenance.mjs`, `scripts/lag-guard.mjs`, `scripts/release-check.mjs`, each with its tests.
- [ ] `.github/workflows/surface-bump.yml`: its checks jobs replaced by the consumer's own, its release step pointing at the consumer's release (or deploy) workflow, dispatched on the tag. Triggers: `workflow_dispatch` (with a `version` input) and a schedule, never `repository_dispatch`.
- [ ] A release (or deploy) workflow that runs only on a `vX.Y.Z` tag, is never a `workflow_call` target, restores no cache, and verifies what it published. The job that holds `id-token: write` or any deploy or publish credential runs no install from the lockfile and no repository or package script: it takes the artifact a credential-free build job produced and checks its digest.
- [ ] The consumer registered in `@mnemoverse/mcp-memory-server`'s `release.yml` consumer list (repository and contour workflow file), and the consumer dispatch token given **Actions: read and write**, and nothing else, on its repository.
- [ ] Depends on `@mnemoverse/mcp-memory-server` by an exact version, and on `@modelcontextprotocol/sdk` with the same range the package declares. The same range does NOT guarantee one copy: pnpm makes one SDK copy per zod peer, and npm hoists one next to the application's zod.
- [ ] Declares `zod` as a peer dependency with exactly the range the package declares, if the consumer builds the package's schemas into JSON Schema anywhere (an in-process `McpServer` does). At runtime, it checks that the schemas it exposes carry everything the package's own zod declares, and fails loudly when they do not.
- [ ] Refuses, when it is built, any pairing of its own dependencies that the package managers cannot express but that breaks at call time (for an AI SDK adapter: the `ai` / `@ai-sdk/mcp` majors).
- [ ] Imports only from `@mnemoverse/mcp-memory-server/shared`. A deep `dist/*` import is allowed only for a helper that `./shared` does not export yet, and it goes on the list of exports to request upstream (this repository: `refusePlaceholderKey` from `dist/requests.js`).
- [ ] Supplies one `apiFetch` per identity, which rejects only with `ApiError`, `NetworkError` and `UnreadableBodyError`.
- [ ] Refuses configuration errors before any request. Wherever the package exports a refusal, its text is called, never re-typed.
- [ ] Re-exports `SERVER_INSTRUCTIONS`, never copies it.
- [ ] Shows its own version next to the surface version.
- [ ] Has contract tests 1-3, install legs for pnpm and npm (check 4), a no-copies check and the lag guard.
- [ ] Pins workflow actions by commit SHA, and gives each job only the permissions it uses.
