export * from './auth/errors.js';
export * from './errors/sdkErrors.js';
export * from './shared/auth.js';
export * from './shared/authUtils.js';
export * from './shared/envelope.js';
export * from './shared/inboundClassification.js';
export * from './shared/metadataUtils.js';
export * from './shared/protocol.js';
export * from './shared/protocolEras.js';
export * from './shared/stdio.js';
export * from './shared/toolNameValidation.js';
export * from './shared/transport.js';
export * from './shared/uriTemplate.js';
export * from './types/index.js';
export * from './util/inMemory.js';
// Wire-codec internals: ONLY the version→codec resolver the sibling packages
// need (era state itself lives on Protocol and is written through the
// package-internal write hook exported by shared/protocol.ts). Nothing
// per-revision (schemas, registries, codec objects) is ever exported — not
// even on this internal barrel — so per-era vocabulary cannot leak toward the
// public surface.
export * from './util/schema.js';
export * from './util/standardSchema.js';
export * from './util/zodCompat.js';
export { codecForVersion } from './wire/codec.js';

// Validator providers are type-only here — import the runtime classes from the explicit
// `@modelcontextprotocol/{core,client,server}/validators/{ajv,cf-worker}` subpaths to customise.
export type { AjvJsonSchemaValidator } from './validators/ajvProvider.js';
export type { CfWorkerJsonSchemaValidator, CfWorkerSchemaDraft } from './validators/cfWorkerProvider.js';
export * from './validators/fromJsonSchema.js';
export type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from './validators/types.js';
