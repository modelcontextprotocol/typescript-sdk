export * from './auth/errors';
export * from './errors/crossBundleBrand';
export * from './errors/sdkErrors';
export * from './shared/auth';
export * from './shared/authUtils';
export * from './shared/clientCapabilityRequirements';
export * from './shared/envelope';
export * from './shared/inboundClassification';
export * from './shared/inputRequired';
export * from './shared/inputRequiredDriver';
export * from './shared/inputRequiredEngine';
export * from './shared/mcpParamHeaders';
export * from './shared/metadataUtils';
export * from './shared/protocol';
export * from './shared/protocolEras';
export * from './shared/resultCacheHints';
export * from './shared/stdio';
export * from './shared/toolNameValidation';
export * from './shared/transport';
export * from './shared/uriTemplate';
export * from './types/index';
export * from './util/inMemory';
// Wire-codec internals: the version→codec resolver the sibling packages need
// (era state itself lives on Protocol and is written through the
// package-internal write hook exported by shared/protocol.ts), plus the
// internal modern-revision literal so sibling packages can name the era a
// 2026-only seam runs in. NOTHING per-revision (registries, codec objects,
// per-revision schemas) is ever exported on this barrel — sibling packages
// reach the wire layer ONLY through `codecForVersion`'s function-only
// `WireCodec` surface.
export * from './util/schema';
export * from './util/standardSchema';
export * from './util/zodCompat';
export { codecForVersion, MODERN_WIRE_REVISION } from './wire/codec';

// Validator provider classes stay subpath-only. Re-exporting them here, even as
// `type`, can make generated client/server root declarations advertise
// runtime-shaped root exports that the package root does not provide.
export * from './validators/fromJsonSchema';
export type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from './validators/types';
