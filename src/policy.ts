/**
 * Which of the package's tools a caller gets, and what a pinned `domain` means.
 *
 * This is behaviour ON TOP of the package's tools, not a copy of anything in
 * them: no description, schema, annotation or text is restated here, only a
 * security class per tool NAME. Every tool the package registers must be
 * classified; test/contract.test.ts compares this table with the package's
 * registered set, so a bump that adds, removes or renames a tool turns CI red
 * until a human classifies it. At runtime an unclassified tool is never
 * exposed (fail closed).
 *
 *   domain       reads or writes one store, chosen by its `domain` input.
 *                Under a pin, the pinned value replaces whatever the model
 *                sends, before the call reaches the package's handler, so the
 *                text the handler writes describes the scope it really used.
 *   room-routed  its `domain` input only routes the call to a shared room's
 *                store (an `xroom:` address); any other value is ignored and
 *                the call acts on the key's whole own store: memory_feedback
 *                rates memories by id anywhere in it, and memory_graph (0.13)
 *                reads the account's whole association graph, which has no
 *                domain column. A pin scopes it only when the pin is an
 *                `xroom:` address, so under any other pin it is excluded from
 *                'all' and naming it throws (fail closed).
 *   account      answers for the whole account and ignores `domain`
 *                (memory_stats lists every domain; room and vault lists are
 *                account-wide). Excluded from 'all' under a pin; naming one
 *                under a pin throws.
 *   room-admin   changes room membership. Opt-in only: never part of 'all';
 *                refused under a pin. On ai 6 and 7 they need tool approval
 *                by default (src/approval.ts).
 *
 * Both tables are frozen: the transport reads TOOL_CLASSES on every call, so
 * a write to the exported object must not be able to change what a pin
 * enforces.
 */
import { MnemoverseConfigError } from "./errors.js";

export type ToolClass = "domain" | "room-routed" | "account" | "room-admin";

export const TOOL_CLASSES = Object.freeze({
  memory_write: "domain",
  memory_read: "domain",
  memory_list_recent: "domain",
  memory_feedback: "room-routed",
  memory_graph: "room-routed",
  memory_stats: "account",
  memory_list_rooms: "account",
  vault_list: "account",
  memory_create_room: "room-admin",
  memory_invite_to_room: "room-admin",
  memory_join_room: "room-admin",
} as const satisfies Record<string, ToolClass>);

/** A tool name this package has classified. */
export type MemoryToolName = keyof typeof TOOL_CLASSES;

/** Every classified tool name. */
export const MEMORY_TOOL_NAMES: readonly MemoryToolName[] = Object.freeze(
  Object.keys(TOOL_CLASSES) as MemoryToolName[],
);

/** What the `tools` option accepts. */
export type ToolsOption = "all" | readonly MemoryToolName[];

function isClassified(name: string): name is MemoryToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_CLASSES, name);
}

/**
 * A shared-room address, by the same plain prefix test the API applies: no
 * trimming and no case folding, so a padded or re-cased value is NOT a room
 * here either, and a room-routed tool stays excluded under it (fail closed).
 */
export function isRoomAddress(domain: string): boolean {
  return domain.startsWith("xroom:");
}

/**
 * Whether the pin scopes a tool of this class: its `domain` argument is
 * replaced by the pin, and the pin then decides which store the call touches.
 */
export function scopedByPin(cls: ToolClass, domain: string): boolean {
  return cls === "domain" || (cls === "room-routed" && isRoomAddress(domain));
}

/**
 * Resolve the `tools` option to the set of names to expose. Throws
 * MnemoverseConfigError for anything malformed, unknown or not allowed under
 * the pin.
 *
 *   'all' (the default)  every classified tool except room-admin; under a pin,
 *                        only the tools the pin scopes.
 *   a list of names      exactly those; room-admin tools only this way, and
 *                        never under a pin; under a pin, only tools it scopes.
 */
export function selectTools(requested: unknown, domain: string | undefined): Set<MemoryToolName> {
  if (requested === undefined || requested === "all") {
    return new Set(
      MEMORY_TOOL_NAMES.filter((name) => {
        const cls = TOOL_CLASSES[name];
        return domain !== undefined ? scopedByPin(cls, domain) : cls !== "room-admin";
      }),
    );
  }
  if (!Array.isArray(requested)) {
    throw new MnemoverseConfigError("invalid_option", "`tools` must be 'all' or an array of tool names.");
  }
  if (requested.length === 0) {
    throw new MnemoverseConfigError(
      "empty_tools",
      "`tools` is an empty list. Omit it (or pass 'all') for every tool that fits the options.",
    );
  }
  const names = new Set<MemoryToolName>();
  for (const name of requested as unknown[]) {
    if (typeof name !== "string" || !isClassified(name)) {
      throw new MnemoverseConfigError(
        "unknown_tool",
        `Unknown Mnemoverse tool ${JSON.stringify(name)}. Known tools: ${MEMORY_TOOL_NAMES.join(", ")}.`,
      );
    }
    const cls = TOOL_CLASSES[name];
    if (domain !== undefined && !scopedByPin(cls, domain)) {
      throw new MnemoverseConfigError(
        "tool_not_allowed_with_domain",
        `${name} cannot be used with ` +
          (cls === "room-routed"
            ? "a pinned `domain` that is not a shared-room (xroom:) address: its `domain` input only selects " +
              "a room, so under this pin it would " +
              (name === "memory_graph"
                ? "read the association graph of the key's whole account, not only the pinned domain."
                : "rate memories by id across the key's own store, not only in the pinned domain.")
            : "a pinned `domain`: it " +
              (cls === "account"
                ? "answers for the whole account and ignores the domain, so it would show the model data outside the pinned one."
                : "changes room membership for the whole account.")) +
          " Remove it from `tools`, or give each end user their own API key instead of pinning a domain.",
      );
    }
    names.add(name);
  }
  return names;
}

/**
 * Validate the `domain` option. `undefined` (property absent) means no pin.
 * A present-but-undefined or empty domain throws: `{ domain: pinFor(user) }`
 * that resolves to nothing must not silently create UNPINNED tools, and the
 * package treats an empty domain as none (it searches every domain).
 */
export function resolveDomain(options: object): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(options, "domain")) return undefined;
  const domain = (options as { domain?: unknown }).domain;
  if (domain === undefined) {
    throw new MnemoverseConfigError(
      "invalid_domain",
      "`domain` is present but undefined, so there is nothing to pin. Omit the property for unpinned " +
        "tools, or pass the domain to pin.",
    );
  }
  if (typeof domain !== "string" || domain.trim().length === 0) {
    throw new MnemoverseConfigError("invalid_domain", "`domain` must be a non-empty string, or omitted.");
  }
  return domain;
}
