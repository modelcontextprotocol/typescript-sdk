import type { JsonSchemaType, jsonSchemaValidator, StandardSchemaWithJSON } from '@modelcontextprotocol/core-internal';
import { fromJsonSchema as coreFromJsonSchema } from '@modelcontextprotocol/core-internal';
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/_shims';

let _defaultValidator: jsonSchemaValidator | undefined;

export function fromJsonSchema<T = unknown>(schema: JsonSchemaType, validator?: jsonSchemaValidator): StandardSchemaWithJSON<T, T> {
    return coreFromJsonSchema<T>(schema, validator ?? (_defaultValidator ??= new DefaultJsonSchemaValidator()));
}
