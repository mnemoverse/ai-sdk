/**
 * Tool approval where shared rooms make a call risky.
 *
 * A shared room is written by all of its members, so whatever memory_read or
 * memory_list_recent returns from a room is untrusted input to the model. Text
 * planted there can ask the model to copy private facts into the room, where
 * every member reads them, or to change who is in a room. So on the majors
 * whose tools can carry `needsApproval` (ai 6 and 7), these calls wait for the
 * application's approval by default:
 *
 *   memory_write      when the store it writes to is a room: the pin when one
 *                     is set (the transport replaces the model's `domain` with
 *                     it), otherwise the `domain` the model sent;
 *   room-admin tools  always (they are opt-in by name and refused under a pin).
 *
 * The room test here is looser than the API's own prefix test (leading
 * whitespace and invisible characters skipped, any letter case): a false
 * positive costs one approval prompt, a false negative would skip one.
 *
 * `roomApproval: false` turns the default off. ai 5 has no tool approval: the
 * property would be ignored there, so it is never set, and an explicit
 * `roomApproval: true` is refused instead of silently doing nothing. On ai 7, a
 * `toolApproval` passed to generateText or streamText decides first for the
 * tools it covers (the AI SDK's own precedence).
 */
import { MnemoverseConfigError } from "./errors.js";
import { TOOL_CLASSES, type MemoryToolName } from "./policy.js";

/** The first ai major whose tools can carry `needsApproval`. */
export const FIRST_APPROVAL_MAJOR = 6;

/** What a tool's `needsApproval` is set to: a constant, or a test of the call's input. */
export type NeedsApproval = boolean | ((input: unknown) => boolean);

/** Loosely, whether `domain` addresses a shared room. */
export function mayBeRoomAddress(domain: unknown): boolean {
  return typeof domain === "string" && /^[\s\p{Cf}]*xroom:/iu.test(domain);
}

/**
 * Whether to set `needsApproval` at all, from the `roomApproval` option and
 * the installed ai major. Throws MnemoverseConfigError for a non-boolean, and
 * for `true` where the AI SDK has no tool approval.
 */
export function resolveRoomApproval(option: unknown, aiMajor: number): boolean {
  if (option !== undefined && typeof option !== "boolean") {
    throw new MnemoverseConfigError("invalid_option", "`roomApproval` must be a boolean, or omitted.");
  }
  if (aiMajor < FIRST_APPROVAL_MAJOR) {
    if (option === true) {
      throw new MnemoverseConfigError(
        "invalid_option",
        `\`roomApproval: true\` needs tool approval (\`needsApproval\`), which ai ${aiMajor} does not have; it ` +
          `arrived in ai ${FIRST_APPROVAL_MAJOR}. Upgrade ai, or omit the option and keep room writes and the ` +
          "room-changing tools out of reach another way (see the security notes in the README).",
      );
    }
    return false;
  }
  return option !== false;
}

/** The `needsApproval` for one exposed tool under the given pin, or undefined for none. */
export function needsApprovalFor(name: MemoryToolName, domain: string | undefined): NeedsApproval | undefined {
  if (TOOL_CLASSES[name] === "room-admin") return true;
  if (name !== "memory_write") return undefined;
  if (domain !== undefined) return mayBeRoomAddress(domain) ? true : undefined;
  return (input) =>
    input !== null && typeof input === "object" && mayBeRoomAddress((input as { domain?: unknown }).domain);
}
