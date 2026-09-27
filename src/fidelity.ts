/**
 * Schema fidelity: the input schemas the in-process server lists must carry
 * everything the package's own zod says about each field.
 *
 * Why this exists. The package registers zod schemas; the in-process
 * `McpServer` turns them into JSON Schema with the `zod/v4-mini` that
 * @modelcontextprotocol/sdk resolves in the CONSUMER's install, which need not
 * be the zod the package's schemas were built with. pnpm keeps one SDK copy
 * per zod peer (this package's copy is paired with the application's zod);
 * npm hoists one SDK next to the application's root zod. With zod 3.25 or 4.0
 * there, every description and every limit (minLength, maxLength, maxItems,
 * integer, minimum, maximum) is dropped; with 4.1 or 4.2 the limits are.
 * Nothing fails: the model silently gets a poorer surface than the stdio
 * server's, and the handler then rejects input the model was never told was
 * invalid. The `zod` peer dependency makes such an install conflict (npm) or
 * warn (pnpm); this check makes it fail loudly when the tools are created.
 *
 * The reference is what each of the package's field schemas says about itself
 * through Standard JSON Schema (`~standard.jsonSchema.input`), which is
 * computed by the package's own zod. It is only compared, never exposed: what
 * the model sees is still the server's `tools/list`, unchanged. The comparison
 * is one way (everything the reference states must be in the listed schema,
 * with the same value), so a server that adds to a schema is not refused, and
 * one that loses anything is.
 */
import { MnemoverseSurfaceError } from "./errors.js";
import type { ObservedTool } from "./transport.js";
import { SURFACE_VERSION, SURFACE_ZOD_RANGE } from "./version.js";

type Json = Record<string, unknown>;

/** How many lost keywords the error names before it summarises the rest. */
const NAMED = 8;

/**
 * Wrap `server` so that every `registerTool(name, config, …)` call records
 * `config.inputSchema` (the package's zod shape) under `name`, then reaches
 * the real server unchanged. Everything else is forwarded as is.
 */
export function recordInputSchemas<T extends object>(server: T, into: Map<string, unknown>): T {
  return new Proxy(server, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "registerTool") return value.bind(target);
      return (name: unknown, config: unknown, ...rest: unknown[]) => {
        if (typeof name === "string") into.set(name, isObject(config) ? config.inputSchema : undefined);
        return value.call(target, name, config, ...rest);
      };
    },
  });
}

/**
 * Throws MnemoverseSurfaceError unless every tool the server listed carries,
 * for every input field, everything the package's own zod emits for it.
 */
export function checkSchemaFidelity(
  registered: ReadonlyMap<string, unknown>,
  observed: ReadonlyMap<string, ObservedTool>,
): void {
  const lost: string[] = [];
  for (const [name, tool] of observed) {
    if (!registered.has(name)) {
      throw new MnemoverseSurfaceError(
        `The server lists ${name}, which @mnemoverse/mcp-memory-server ${SURFACE_VERSION} did not register ` +
          "through registerTool, so its schema cannot be checked.",
      );
    }
    const fields = fieldsOf(registered.get(name));
    if (fields === undefined) {
      throw new MnemoverseSurfaceError(
        `The input schema @mnemoverse/mcp-memory-server ${SURFACE_VERSION} registers for ${name} is not a zod ` +
          "shape or object, so this package cannot check what the model sees.",
      );
    }
    const target = targetOf(tool.inputSchema);
    const properties = isObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
    for (const [key, field] of Object.entries(fields)) {
      const reference = referenceOf(field, target);
      if (reference === undefined) {
        throw new MnemoverseSurfaceError(
          `${name}.${key} in @mnemoverse/mcp-memory-server ${SURFACE_VERSION} does not describe itself as JSON ` +
            "Schema (Standard JSON Schema), so this package cannot check what the model sees.",
        );
      }
      missing(reference, properties[key], `${name}.${key}`, lost);
    }
  }
  if (lost.length === 0) return;
  const named = lost.slice(0, NAMED).join(", ") + (lost.length > NAMED ? ` and ${lost.length - NAMED} more` : "");
  throw new MnemoverseSurfaceError(
    `The tool schemas the model would see have lost what @mnemoverse/mcp-memory-server ${SURFACE_VERSION} ` +
      `declares: ${named}. @modelcontextprotocol/sdk converts the package's zod schemas with the zod your ` +
      `install resolves for it, and that zod does not match the package's, which needs zod ${SURFACE_ZOD_RANGE}. ` +
      `Install zod ${SURFACE_ZOD_RANGE} in your project (a peer dependency of @mnemoverse/ai-sdk) and reinstall.`,
  );
}

/** The field schemas of a registered input: a raw zod shape, a zod object, or nothing (no input). */
function fieldsOf(input: unknown): Json | undefined {
  if (input === undefined) return {};
  if (!isObject(input)) return undefined;
  if ("_zod" in input || "_def" in input) {
    const shape = (input as { shape?: unknown }).shape;
    return isObject(shape) ? shape : undefined;
  }
  return Object.values(input).every(isObject) ? input : undefined;
}

/** The JSON Schema dialect the server used, so the reference is asked for in the same one. */
function targetOf(schema: Json): "draft-07" | "draft-2020-12" {
  return typeof schema.$schema === "string" && schema.$schema.includes("2020-12") ? "draft-2020-12" : "draft-07";
}

/** What the field's own zod says it is, as JSON Schema, without `$schema`; undefined if it cannot say. */
function referenceOf(field: unknown, target: string): Json | undefined {
  if (!isObject(field)) return undefined;
  const standard = field["~standard"];
  const jsonSchema = isObject(standard) ? standard.jsonSchema : undefined;
  const input = isObject(jsonSchema) ? jsonSchema.input : undefined;
  if (typeof input !== "function") return undefined;
  try {
    const out: unknown = input.call(jsonSchema, { target });
    if (!isObject(out)) return undefined;
    const { $schema: _dialect, ...rest } = out;
    return rest;
  } catch {
    return undefined;
  }
}

/**
 * Push the path of everything `reference` states that `listed` lacks or
 * states differently. Objects are compared one way (extra keys in `listed` are
 * fine); arrays element by element; anything else by value.
 */
function missing(reference: unknown, listed: unknown, path: string, out: string[]): void {
  if (isObject(reference)) {
    if (!isObject(listed)) {
      out.push(path);
      return;
    }
    for (const [key, value] of Object.entries(reference)) {
      if (!(key in listed)) out.push(`${path}.${key}`);
      else missing(value, listed[key], `${path}.${key}`, out);
    }
    return;
  }
  if (Array.isArray(reference)) {
    if (!Array.isArray(listed) || listed.length !== reference.length) {
      out.push(path);
      return;
    }
    reference.forEach((value, i) => missing(value, listed[i], `${path}[${i}]`, out));
    return;
  }
  if (!Object.is(reference, listed)) out.push(path);
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
