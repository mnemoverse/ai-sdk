# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package
uses [Semantic Versioning](https://semver.org/) for its own version. Each
release exposes exactly one version of `@mnemoverse/mcp-memory-server`, its
surface version.

## [Unreleased]

## [0.2.1] - 2026-09-29

Surface: `@mnemoverse/mcp-memory-server` 0.14.1.

### Changed

- Exposes the MCP surface of `@mnemoverse/mcp-memory-server` 0.14.1 (was 0.14.0). See that release's notes for what changed in the tools.

## [0.2.0] - 2026-09-29

Surface: `@mnemoverse/mcp-memory-server` 0.14.0.

### Changed

- Exposes the MCP surface of `@mnemoverse/mcp-memory-server` 0.14.0 (was 0.13.1). See that release's notes for what changed in the tools.

## [0.1.2] - 2026-09-28

Surface: `@mnemoverse/mcp-memory-server` 0.13.1.

### Changed

- Exposes the MCP surface of `@mnemoverse/mcp-memory-server` 0.13.1 (was 0.13.0). See that release's notes for what changed in the tools.

## [0.1.1] - 2026-09-28

Surface: `@mnemoverse/mcp-memory-server` 0.13.0.

The first version published through npm trusted publishing, with no token.

### Changed

- README: the options and the tool classes are lists instead of wide tables, so they read the same on npm, which cuts off a table wider than its column. No code change.

## [0.1.0] - 2026-09-27

Surface: `@mnemoverse/mcp-memory-server` 0.13.0.

The first release.

### Added

- `createMnemoverseTools(options)` resolves to `{ tools, close(), surfaceVersion, version }`.
  - It runs the package's MCP server in process: `McpServer` with `registerMemoryTools` from `@mnemoverse/mcp-memory-server/shared`.
  - The Vercel AI SDK's own MCP client (`@ai-sdk/mcp`) connects to that server over `InMemoryTransport.createLinkedPair()`, through a custom transport.
  - Each tool's name, description, input schema, title and annotations come from the server's `tools/list`. Each result is the package's `CallToolResult`, `structuredContent` included. This package converts no schema and restates no text.
- Supports ai 5, 6 and 7, each with its own `@ai-sdk/mcp` major (0.x, 1.x and 2.x).
  - Any other pair is refused when the tools are created, with `MnemoverseConfigError` code `incompatible_ai_versions` and the install that fixes it. The peer ranges cannot express the pairing, and with ai 5 plus `@ai-sdk/mcp` 1.x or 2.x every tool call would fail inside the AI SDK without reaching the API.
- `zod` `^4.6.5` is a peer dependency, the range the MCP package declares for its schemas. The in-process server converts those schemas with the zod the application's install resolves; with zod 3.25 to 4.2 it would silently drop descriptions and limits. npm refuses such an install and pnpm warns.
- A schema check at creation: every field the server lists must carry everything the package's own zod declares for it (read through Standard JSON Schema, compared and never exposed). Anything lost fails with `MnemoverseSurfaceError`, which also keeps the domain-pin check reading the package's real limits.
- On every major, aborting a tool call stops the wait. `@ai-sdk/mcp` 0.x (ai 5) would otherwise wait for the server's answer.
- One `toModelOutput` for every major. The model reads the package's text verbatim, as `text` on success and as `error-text` when the result has `isError`.
- Tool policy:
  - `'all'` (the default) exposes every tool except the room-changing ones. Those are opt-in by name.
  - `domain` pins every domain tool: the pin replaces the model's `domain` before the handler runs.
  - Under a pin, `'all'` leaves out `memory_stats`, `memory_list_rooms` and `vault_list`. Naming one of them, or a room-changing tool, throws `tool_not_allowed_with_domain`.
  - `memory_feedback` and `memory_graph` have their own class, `room-routed`: their `domain` only routes a call to a room (a rating, or a read of that room's association graph). Under an `xroom:` pin they are kept, and the pin replaces their `domain`. Under any other pin they are left out of `'all'`, and naming one throws `tool_not_allowed_with_domain`, because such a pin would not scope it: `memory_feedback` would rate by id across the key's store, and `memory_graph` would read the whole account's graph.
  - The policy is enforced in the transport. A call to any other tool never reaches the server.
  - `TOOL_CLASSES` and `MEMORY_TOOL_NAMES` are frozen, so a write after import cannot change what a pin enforces. `MEMORY_TOOL_NAMES` is typed `readonly`.
- `roomApproval` (default `true`). Shared-room content is written by every member, so it is untrusted input to the model. On ai 6 and 7, `memory_write` into an `xroom:` address (the pin's, or else the model's `domain`) and the room-changing tools carry the AI SDK's `needsApproval`. `false` turns it off. ai 5 has no tool approval: nothing is set there, and `roomApproval: true` is refused with `invalid_option`.
- An identity-bound `apiFetch`, the only thing this package supplies to the package's surface:
  - `X-Api-Key` and `Content-Type` on every request.
  - Caller headers are normalised with `Headers`. `x-api-key` and `authorization` are dropped in any letter case.
  - `redirect: 'error'` is set last.
  - A 10-second default timeout, merged with the handler's own signal.
  - A 204 or `content-length: 0` resolves to `{}`.
  - It rejects only with the package's `ApiError`, `NetworkError` and `UnreadableBodyError`.
- Configuration refusals, thrown as `MnemoverseConfigError` before any request:
  - a missing key, a key that cannot be sent, a base URL that is not https (except loopback), and a base URL with a user name or password in it (fetch cannot send it, and its error would quote the password into every tool result), each with this package's own wording;
  - the documentation placeholder key, decided and worded by the package's exported `refusePlaceholderKey`;
  - a `timeoutMs` that is not a whole number of milliseconds from 1 to 2147483647 (`invalid_option`), `Infinity` included;
  - a malformed `headers` option, reported by position. A header name is repeated only when it is a plain one, so a credential pasted in whole as a name never reaches the error.
- A browser guard, in pages and in Web Workers (dedicated, shared and service), which `dangerouslyAllowBrowser` overrides.
- `SERVER_INSTRUCTIONS`, `ApiError`, `NetworkError` and `UnreadableBodyError`, re-exported from the package.
- `SURFACE_VERSION` and `VERSION`.
- README security notes: shared-room content is untrusted, and a domain pin scopes the tool calls, not the package's diagnostic text (the empty-result explanation of `memory_read` and `memory_list_recent` looks up account-wide lists and can name a store outside the pin).
- `scripts/lag-guard.mjs` goes red when the exact pin is behind npm's latest. It takes an optional grace period.
- `scripts/check-provenance.mjs` verifies that a version of the MCP package carries SLSA provenance from its own repository and release workflow, for this exact tarball. It compares the subject with the package URL as npm writes it (`pkg:npm/%40scope/name@x.y.z`). CI runs it as an advisory check: 0.11.0 to 0.12.1 were published without provenance. With `--auto` it is advisory while no version of the package has ever carried attestations, and required from the first attested version on. With `--self` it checks this package's own publish.
- `scripts/check-upstream-release.mjs` verifies that a version of the MCP package was released from its repository: the tag `vX.Y.Z` is on its main and its release workflow created the GitHub Release. An npm credential alone cannot produce either. CI runs it for the pinned version, and the contour requires it for every bump.
- `scripts/bump-surface.mjs` moves the exact pin, the own version (by the version rule), the CHANGELOG and the README's surface line in one step. A bump into a version that is not released yet folds into it instead of cutting a release.
- Release workflow (`.github/workflows/release.yml`): a `vX.Y.Z` tag, pushed or dispatched on the tag, is checked (tag, version, dated CHANGELOG section, surface, commit on main), gated and packed in a job with no publish credential, with dependency install scripts off. A separate job, the only one with `id-token: write` and the npm token, runs no repository code and no dependency: it checks the tarball's digest and publishes it to npm with provenance, through npm trusted publishing (a token only for the first publish). Afterwards npm must serve the version with the packed bytes and with SLSA provenance from this repository's `release.yml` at the tag. The GitHub Release is made from the CHANGELOG section.
- Self-updating contour (`.github/workflows/surface-bump.yml`): a new `@mnemoverse/mcp-memory-server` on npm (started by its release job with a workflow dispatch, or found by a schedule every six hours) is checked for its tag on the package's main and its GitHub Release, bumped, gated, run through the ai 5/6/7 × Node 22/24 matrix and the consumer legs, committed to main, tagged and published through the release workflow in one run. While upstream provenance is advisory, a new version waits 6 hours first. A red step publishes nothing and opens or updates one issue, "surface bump blocked: X.Y.Z". The contour runs from main only and has no `repository_dispatch` trigger, so the upstream token needs Actions: write here, never Contents.
- CI pins every action to a commit SHA. Only `release.yml` may publish or ask for an OIDC token, only its publish job holds either, that job installs and runs nothing from the repository or the lockfile, it restores no cache, and no workflow interpolates event data into a script (`test/workflows.test.ts`).
- Tests:
  - contract tests against the package's real stdio entry: the tool set, byte-equal metadata, and a round trip per tool;
  - a no-copies check;
  - parallel-instance isolation;
  - an ai 5, 6 and 7 matrix;
  - consumer legs: the packed package in pnpm and npm apps with zod 3.25 and 4.1, and with ai 5 next to the latest `@ai-sdk/mcp`, must each fail loudly at install and at creation, next to a supported pnpm and npm install;
  - CJS and ESM smoke tests.

[Unreleased]: https://github.com/mnemoverse/ai-sdk/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/mnemoverse/ai-sdk/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/mnemoverse/ai-sdk/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/mnemoverse/ai-sdk/compare/v0.1.1...v0.1.2
[0.1.0]: https://github.com/mnemoverse/ai-sdk/releases/tag/v0.1.0
