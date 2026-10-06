# @mnemoverse/ai-sdk

[![npm](https://img.shields.io/npm/v/@mnemoverse/ai-sdk?color=0b7285&label=npm)](https://www.npmjs.com/package/@mnemoverse/ai-sdk)
[![license: MIT](https://img.shields.io/badge/license-MIT-0b7285)](LICENSE)
[![Vercel AI SDK 5, 6 and 7](https://img.shields.io/badge/ai-5%20%C2%B7%206%20%C2%B7%207-000000)](https://ai-sdk.dev)

**Long-term memory for agents built with the [Vercel AI SDK](https://ai-sdk.dev).** Your agent keeps what users tell it across sessions, and across every tool connected to the same [Mnemoverse](https://mnemoverse.com) account. Memories that helped rank higher the next time, and shared rooms let several people's agents work from one memory.

- **Drop-in tools.** `createMnemoverseTools()` returns tools for `generateText` and `streamText` on `ai` 5, 6 and 7, from ESM or CommonJS.
- **The real MCP surface, in process.** The tools are `@mnemoverse/mcp-memory-server`'s own, run inside your process: the same descriptions, schemas and answers as its stdio server and the hosted connector, and nothing copied or converted.
- **Safe by default.** The API key never reaches the model, writes into a shared room need approval on ai 6 and 7, and a tool that a new MCP release adds stays hidden until this package classifies it.
- **Kept current.** Every MCP release is picked up by an automated bump, tested against ai 5, 6 and 7, and published with npm provenance. A release that adds, removes or renames a tool waits until a person classifies it.

Surface: `@mnemoverse/mcp-memory-server` 0.15.0. [What the surface version means](#versions-own-semver-plus-the-surface-version).

## Install

```sh
pnpm add @mnemoverse/ai-sdk ai@^7 @ai-sdk/mcp@^2 zod@^4.6.5
```

On ai 6 use `ai@ai-v6 @ai-sdk/mcp@ai-v6`, on ai 5 `ai@ai-v5 @ai-sdk/mcp@ai-v5` ([supported versions](#supported-versions)). Requires Node.js 22.12 or later, ESM or CommonJS. Get an API key (`mk_live_…`) in the [Mnemoverse console](https://console.mnemoverse.com).

## Quick start

```ts
import { generateText, stepCountIs } from 'ai';
import { createMnemoverseTools, SERVER_INSTRUCTIONS } from '@mnemoverse/ai-sdk';

const memory = await createMnemoverseTools({ apiKey: process.env.MNEMOVERSE_API_KEY });
const { text } = await generateText({
  model, // any AI SDK language model
  system: SERVER_INSTRUCTIONS, tools: memory.tools, stopWhen: stepCountIs(5),
  prompt: 'I switched to Neovim. Remember that.',
});
await memory.close();
```

`stepCountIs` works on ai 5, 6 and 7 (ai 7 also calls it `isStepCount`). `SERVER_INSTRUCTIONS` is the text the MCP server gives every MCP client for its system prompt, re-exported from the package, not copied. Call `close()` in a `finally` in real code ([lifecycle](#lifecycle)).

## Per-user keys

Give each end user their own API key, and create the tools per request with it:

```ts
const memory = await createMnemoverseTools({ apiKey: await keyFor(user) });
```

A `domain` pin scopes what the model reads and writes. **It is not an access boundary**: the key can reach every domain in its account. See [Many users](#many-users-per-user-keys-first).

## Security at a glance

- The key lives only in its instance's `apiFetch` closure. It is never put in a tool, a message or an error text, and it is never re-sent to a redirect target (`redirect: 'error'`).
- Configuration that cannot work (a missing, placeholder or unsendable key, a base URL that is not https outside loopback, a URL with a password in it) is refused before any request.
- The tool set is enforced in the transport. Room-changing tools are opt-in by name, and a tool added by a new upstream release is never exposed before this package classifies it.
- Shared-room content is written by every member of the room, so it is untrusted input. On ai 6 and 7, calls that act on a shared room need tool approval by default (`roomApproval`).
- Creating the tools in a browser is refused, because the key would be readable by anyone using the page.

The full list is in [Security notes](#security-notes).

## Supported versions

The AI SDK's MCP client ships in `@ai-sdk/mcp`, and its major must match your `ai` major:

```sh
# ai 7
pnpm add @mnemoverse/ai-sdk ai@^7 @ai-sdk/mcp@^2 zod@^4.6.5
# ai 6
pnpm add @mnemoverse/ai-sdk ai@ai-v6 @ai-sdk/mcp@ai-v6 zod@^4.6.5
# ai 5
pnpm add @mnemoverse/ai-sdk ai@ai-v5 @ai-sdk/mcp@ai-v5 zod@^4.6.5
```

| `ai` | `@ai-sdk/mcp` | npm dist-tag | tested with |
|---|---|---|---|
| 5.x | 0.0.x | `@ai-sdk/mcp@ai-v5` | ai 5.0.265, @ai-sdk/mcp 0.0.35 |
| 6.x | 1.0.x | `@ai-sdk/mcp@ai-v6` | ai 6.0.290, @ai-sdk/mcp 1.0.85 |
| 7.x | 2.0.x | `@ai-sdk/mcp@latest` | ai 7.0.113, @ai-sdk/mcp 2.0.57 |

Two requirements are checked when the tools are created, because the package managers cannot enforce them:

- **The `ai` / `@ai-sdk/mcp` pair.** A bare `pnpm add @ai-sdk/mcp` installs 2.x even in an ai 5 or ai 6 project, without a peer warning. With ai 5, every tool call would then fail inside the AI SDK and never reach Mnemoverse. Any pair outside the table is refused with `MnemoverseConfigError` (`incompatible_ai_versions`), and the message names the install that fixes it.
- **zod `^4.6.5`,** the range `@mnemoverse/mcp-memory-server` declares for its tool schemas. The MCP server that runs in your process converts those schemas to JSON Schema with the zod your install gives `@modelcontextprotocol/sdk`. An older zod (3.25, 4.0, 4.1, 4.2) silently drops the descriptions or the limits the model should see. `zod` is therefore a peer dependency: npm refuses a conflicting install, and pnpm warns about it. If the schemas are degraded anyway, creating the tools fails with `MnemoverseSurfaceError`.

It works from ESM and from CommonJS (`require(esm)`). `SERVER_INSTRUCTIONS` names every tool, including the room tools that are exposed only on request.

## How it works

```
@mnemoverse/mcp-memory-server/shared         @ai-sdk/mcp (the AI SDK's MCP client)
registerMemoryTools(server, { apiFetch })            │ client.tools()
          │                                          ▼
   McpServer (in process) ◄── InMemoryTransport ──► custom transport
                               (no network hop)      (policy + domain pin)
```

`createMnemoverseTools` builds one `apiFetch` for your key. It then creates an in-process `McpServer` with the package's `registerMemoryTools`, and connects the AI SDK's own MCP client to it through a custom transport over `InMemoryTransport.createLinkedPair()`. `memory.tools` is what `client.tools()` returns, so every description, JSON schema, title and annotation comes from the server's `tools/list`.

The transport serialises every message, exactly as a wire would. It also enforces the tool policy, and that is the only place the policy is enforced.

Before the tools are returned, the schemas the server listed are checked against the package's own: every field must carry everything the package's zod declares for it, as that zod reports it through Standard JSON Schema. The check only compares. What the model sees is still the server's `tools/list`, unchanged.

`apiFetch` is the only piece this package supplies to the package's MCP surface.

The server registers only the tools. `client.tools()` uses neither the package's prompts nor its resources, so they are not registered.

### What a tool returns

`execute` resolves with the MCP `CallToolResult`, unchanged:

```ts
{ content: [{ type: 'text', text }], structuredContent?: {...}, isError?: true }
```

The model reads only the text, which is the package's text verbatim:

- **Success:** the text is sent as `text`.
- **`isError: true`:** the text is sent as `error-text`. A refusal, an API error or an input validation error is an answer the model reads, and the loop continues. Providers with a tool-error flag, such as Anthropic's `is_error`, set it.
- **Structured data:** your code reads `structuredContent` from the step's tool results, for example `steps[0].toolResults[0].output.structuredContent`.

## Options

Each option below: its default, then what it does.

- **`apiKey`**, default `MNEMOVERSE_API_KEY`. The environment is read only when the property is absent, at call time and never at import. A present `apiKey` that is `undefined` or `''` is refused. It never falls back to a shared key.
- **`baseUrl`**, default `MNEMOVERSE_API_URL`, then `https://core.mnemoverse.com/api/v1`. Must be https. Plain http is allowed only for `localhost`, `127.0.0.1` and `[::1]`. A user name or password in the URL is refused.
- **`domain`**, default none. Pins the domain tools. See [Tools and the domain pin](#tools-and-the-domain-pin).
- **`tools`**, default `'all'`. `'all'`, or a list of tool names.
- **`fetch`**, default `globalThis.fetch`. Used for every API request.
- **`timeoutMs`**, default `10000`. Per HTTP request, in whole milliseconds from 1 to 2147483647 (about 24.8 days, the longest a timer can wait). Anything else is refused.
- **`headers`**, default none. Sent with every request. `X-Api-Key` and `Authorization` are dropped in any letter case.
- **`dangerouslyAllowBrowser`**, default `false`. See the [security notes](#security-notes).
- **`roomApproval`**, default `true`. ai 6 and 7: the calls that act on a shared room need tool approval. `false` turns it off. ai 5 has no tool approval, so there nothing is set and `true` is refused. See the [security notes](#security-notes).

`createMnemoverseTools` rejects with `MnemoverseConfigError`, whose `code` says why, when the options cannot work. It does so before anything is sent:

- a missing, placeholder or unsendable key;
- an insecure base URL, or one with a user name or password in it;
- an unknown or disallowed tool;
- an empty or invalid domain;
- a `timeoutMs` outside 1 to 2147483647, or not a whole number;
- a malformed header;
- an `ai` / `@ai-sdk/mcp` pair outside the tested matrix.

### Tools and the domain pin

Every tool has one of four classes. The class decides whether `'all'` includes it and what a pinned `domain` does to it.

- **domain**: `memory_write`, `memory_read`, `memory_list_recent`.
  - In `'all'`: yes.
  - Under any pin, `xroom:` or not: the pin replaces the model's `domain`.
- **room-routed**: `memory_feedback`, `memory_graph`.
  - In `'all'`: yes.
  - Under an `xroom:` pin: the pin replaces the model's `domain`.
  - Under any other pin: excluded; naming one throws.
- **account-wide**: `memory_stats`, `memory_list_rooms`, `vault_list`.
  - In `'all'`: yes, when nothing is pinned.
  - Under any pin: excluded; naming one throws.
- **room-changing**: `memory_create_room`, `memory_invite_to_room`, `memory_join_room`.
  - In `'all'`: no; opt in by name.
  - Under any pin: naming one throws.

"Naming it throws" means `MnemoverseConfigError` with code `tool_not_allowed_with_domain`.

The descriptions are the package's. Read them in `memory.tools[name].description`, or in the package's README.

A pin replaces `domain` in the arguments before the package's handler runs. So the tool call works on the pinned store, and a `domain` the model makes up can neither widen the scope nor fail the call.

`memory_feedback` and `memory_graph` use their `domain` only to route a call to a shared room, so only an `xroom:` pin scopes them. Under any other pin `memory_feedback` would rate memories by id anywhere in the key's own store, and `memory_graph` would read the association graph of the key's whole account, both outside the pinned domain, so they are left out of `'all'` and naming one throws. The room test is the API's own: the pin must start with exactly `xroom:`, with no leading space and in lower case.

**The pin scopes the tool calls, not the package's diagnostic text.** When `memory_read` or `memory_list_recent` finds nothing, the package explains the empty result. That explanation is the package's behaviour, not this package's: for a plain domain it looks up the account-wide domain list, and for an `xroom:` address the account's room list. Its text can name a store outside the pin, for example a domain whose name differs from a plain-domain pin only in letter case. If the model must not learn that such a store exists, a pin is not enough: give each end user their own key.

## Many users: per-user keys first

A domain pin scopes what the model reads and writes. **It is not an access boundary.** Every request is made with the key, and the key can reach every domain in its account.

- **Isolate users with their own API key each.** Create the tools per request with that user's key:

  ```ts
  const memory = await createMnemoverseTools({ apiKey: await keyFor(user) });
  ```

- **A shared key plus a domain per user** is for cooperating agents of one account, not for separating strangers:

  ```ts
  const memory = await createMnemoverseTools({ apiKey: process.env.MNEMOVERSE_API_KEY, domain: `user:${user.id}` });
  ```

  Under a pin, the account-wide tools are left out because they would show the model data outside the pinned domain. `memory_feedback` and `memory_graph` are left out too, unless the pin is a room address, because one would rate memories outside the pin and the other would read the whole account's association graph.

## Lifecycle

Each `createMnemoverseTools` call builds its own server, transports and client. They share no state with any other instance, so parallel instances with different keys or domains never see each other's requests or results (tested).

- **Create per request.** This is the simplest and the safest choice when the key or domain depends on the user. It costs about 1 ms and about 200 KiB of heap per instance, measured on Node 22, including the schema check. Creating sends nothing to the API.
- **Reuse per key.** An instance can serve any number of `generateText` calls, sequential or concurrent. Keep it for as long as its key and domain are right.
- **`close()`** shuts the MCP client and the in-process server, both transport ends. It is idempotent. After it, calling a tool rejects.
  - Call it in `finally`, or when the request ends.
  - Nothing here holds a socket, a timer or a process. An instance you forget to close is ordinary garbage.
- **Aborting.** Aborting a tool call through the AI SDK's `abortSignal` stops the wait on every major. On ai 6 and 7, `@ai-sdk/mcp` does this itself. On ai 5, this package adds it, because `@ai-sdk/mcp` 0.x would otherwise wait for the server's answer. The package's handlers do not receive the signal, though, so an HTTP request already in flight still runs until it answers or `timeoutMs` expires, and its result is discarded.

## Security notes

- **The key stays in one place.** It lives only in the `apiFetch` closure of its instance. It is never put in a tool, a message or an error text.
- **Configuration refusals.** They happen before any request, and they never repeat a key, a header value or a URL:
  - A malformed `headers` option is refused by position. A header name is repeated only when it is a plain one (letters, digits and hyphens), because a credential pasted in whole as a name (`"Authorization: Bearer …"`) would otherwise land in the error and in your logs.
  - An empty key and a key that an HTTP header cannot carry are refused. A header would otherwise quote the whole value in its error.
  - The documentation placeholder key is refused with the package's own text.
  - A non-https base URL is refused, except for loopback.
  - A base URL with a user name or password in it is refused. fetch cannot send such a URL, and its error would quote the password into every tool result the model reads.
- **Requests:**
  - `redirect: 'error'` is always set, so the key is never re-sent to a redirect target.
  - Caller headers cannot set or add `X-Api-Key` or `Authorization`, in any letter case.
  - There is a default 10-second timeout.
- **The tool set is enforced in the transport.** A call to a tool outside the set never reaches the server.
  - **Room-changing tools** are opt-in by name.
  - **A new tool from an upstream release** is never exposed until this package classifies it, so the policy fails closed.
  - **The policy tables are frozen.** `TOOL_CLASSES` and `MEMORY_TOOL_NAMES` are exported read-only: writing to them throws, and nothing a pin enforces can change after import.
- **Shared-room content is untrusted.** Every member of a room can write to it. So whatever `memory_read` or `memory_list_recent` returns from an `xroom:` address is text from other people, and it can carry instructions aimed at your model: to copy private facts into the room, where every member reads them, or to change who is in a room. Treat it like any other untrusted input.
  - **On ai 6 and 7, room calls need approval by default.** This package sets the AI SDK's `needsApproval` on `memory_write` when it writes to an `xroom:` address, and on the room-changing tools. Under a pin, the pin decides, since it replaces the model's `domain`. `generateText` and `streamText` then stop at a `tool-approval-request` instead of running the call. Your application approves or denies it (see the AI SDK's tool approval docs). The room test for approval is deliberately looser than the API's: leading whitespace and any letter case still count as a room.
  - **`roomApproval: false`** turns this off, for example when your application already gates tool calls itself. On ai 7, a `toolApproval` you pass to `generateText` or `streamText` decides first for the tools it covers, which is the AI SDK's own order.
  - **ai 5 has no tool approval.** There, nothing is set, the calls run without asking, and `roomApproval: true` is refused rather than silently ignored. On ai 5, keep room writes out of reach in another way: pin a domain that is not a room, leave the room-changing tools out of `tools`, or check `domain` in your own wrapper before calling `execute`.
- **Browsers.** The factory refuses to run in a browser, where the key would be readable by anyone using the page. That includes Web Workers (dedicated, shared and service workers), which have no `window` or `document`. Pass `dangerouslyAllowBrowser: true` only with a key that belongs to that one user.

## Versions: own semver, plus the surface version

This package has its own semver: `VERSION`, or `memory.version`. It pins `@mnemoverse/mcp-memory-server` to one exact version, the **surface version**, available as `SURFACE_VERSION` and `memory.surfaceVersion`.

Every release note names its surface version. A new MCP release reaches this package through an automated bump, which is tested against ai 5, 6 and 7 and published only when everything is green; see [docs/AUTO-UPDATE-CONTOUR.md](docs/AUTO-UPDATE-CONTOUR.md). A lag guard (`pnpm run lag-guard`) turns red when the pin falls behind npm's latest.

Every version is published by this repository's release workflow, from its release tag, with npm provenance. `npm audit signatures` in your project verifies it.

```ts
import { VERSION, SURFACE_VERSION } from '@mnemoverse/ai-sdk';
console.log(`@mnemoverse/ai-sdk ${VERSION} (surface ${SURFACE_VERSION})`);
```

## Errors

| Class | When |
|---|---|
| `MnemoverseConfigError` | `createMnemoverseTools` refused the options or the installed AI SDK. `code` is one of `missing_key`, `placeholder_key`, `unsendable_key`, `insecure_base_url`, `invalid_option`, `invalid_domain`, `unknown_tool`, `empty_tools`, `tool_not_allowed_with_domain`, `browser_runtime` or `incompatible_ai_versions`. |
| `MnemoverseSurfaceError` | The tools the model would see are not the package's. Either the listed schemas lost descriptions or limits (the install paired `@modelcontextprotocol/sdk` with a zod outside `^4.6.5`), or the installed MCP package does not expose what the policy expects. The exact pin and the zod peer make both unreachable in a normal install. |
| `ApiError`, `NetworkError`, `UnreadableBodyError` | The package's own classes, re-exported. Tools never throw them at you: the package turns them into `isError` results with its own text. |

## Development

```sh
pnpm install
pnpm run gate          # typecheck, tests, build, publint + pack check, CJS and ESM smoke
pnpm run test:matrix   # the gate against ai 5, 6 and 7 (each with its @ai-sdk/mcp), then the consumer legs
pnpm run test:legs     # only the consumer legs: unsupported pnpm and npm installs must fail loudly
pnpm run lag-guard     # red when the pinned surface is behind npm
pnpm run provenance    # does the pinned surface carry SLSA provenance from its release workflow?
```

Releasing, and the one-time switch to npm trusted publishing: [docs/RELEASING.md](docs/RELEASING.md).

## License

MIT
