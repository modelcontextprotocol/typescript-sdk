/**
 * Runtime-aware wrapper of {@linkcode coreFromJsonSchema | fromJsonSchema} from core.
 *
 * Uses the `_shims` pattern to select the default validator:
 * - Node.js: {@linkcode index.AjvJsonSchemaValidator | AjvJsonSchemaValidator}
 * - Cloudflare Workers: {@linkcode index.CfWorkerJsonSchemaValidator | CfWorkerJsonSchemaValidator}
 */
import type { JsonSchemaType, jsonSchemaValidator, StandardSchemaWithJSON } from '@modelcontextprotocol/core';
import { fromJsonSchema as coreFromJsonSchema } from '@modelcontextprotocol/core';
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/_shims';

let _defaultValidator: jsonSchemaValidator | undefined;

/**
 * Wrap a raw JSON Schema object as a {@linkcode StandardSchemaWithJSON} so it can be
 * passed to `registerTool` / `registerPrompt`. Use this when you already have JSON
 * Schema (e.g. from TypeBox, or hand-written) and want to register it without going
 * through a Standard Schema library.
 *
 * The callback arguments will be typed `unknown` (raw JSON Schema has no TypeScript
 * types attached). Cast at the call site, or use the generic `fromJsonSchema<MyType>(...)`.
 *
 * @param schema - A JSON Schema object describing the expected shape
 * @param validator - Optional validator provider. Defaults to the runtime-appropriate
 *   validator ({@linkcode index.AjvJsonSchemaValidator | AjvJsonSchemaValidator} on Node.js,
 *   {@linkcode index.CfWorkerJsonSchemaValidator | CfWorkerJsonSchemaValidator} on edge runtimes).
 */
export function fromJsonSchema<T = unknown>(schema: JsonSchemaType, validator?: jsonSchemaValidator): StandardSchemaWithJSON<T, T> {
    return coreFromJsonSchema<T>(schema, validator ?? (_defaultValidator ??= new DefaultJsonSchemaValidator()));
}
