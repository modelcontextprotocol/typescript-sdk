export * from './auth/errors.js';
export * from './errors/sdkErrors.js';
export * from './shared/auth.js';
export * from './shared/authUtils.js';
export * from './shared/clientCapabilityRequirements.js';
export * from './shared/envelope.js';
export * from './shared/inboundClassification.js';
export * from './shared/inputRequired.js';
export * from './shared/inputRequiredDriver.js';
export * from './shared/inputRequiredEngine.js';
export * from './shared/mcpParamHeaders.js';
export * from './shared/metadataUtils.js';
export * from './shared/protocol.js';
export * from './shared/protocolEras.js';
export * from './shared/resultCacheHints.js';
export * from './shared/stdio.js';
export * from './shared/toolNameValidation.js';
export * from './shared/transport.js';
export * from './shared/uriTemplate.js';
export * from './types/index.js';
export * from './util/inMemory.js';
// Wire-codec internals: the version→codec resolver the sibling packages need
// (era state itself lives on Protocol and is written through the
// package-internal write hook exported by shared/protocol.ts), plus the
// internal modern-revision literal so sibling packages can name the era a
// 2026-only seam runs in. NOTHING per-revision (registries, codec objects,
// per-revision schemas) is ever exported on this barrel — sibling packages
// reach the wire layer ONLY through `codecForVersion`'s function-only
// `WireCodec` surface.
export * from './util/schema.js';
export * from './util/standardSchema.js';
export * from './util/zodCompat.js';
export { codecForVersion, MODERN_WIRE_REVISION } from './wire/codec.js';

// Validator providers are type-only here — import the runtime classes from the explicit
// `@modelcontextprotocol/{core,client,server}/validators/{ajv,cf-worker}` subpaths to customise.
export type { AjvJsonSchemaValidator } from './validators/ajvProvider.js';
export type { CfWorkerJsonSchemaValidator, CfWorkerSchemaDraft } from './validators/cfWorkerProvider.js';
export * from './validators/fromJsonSchema.js';
export type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from './validators/types.js';
