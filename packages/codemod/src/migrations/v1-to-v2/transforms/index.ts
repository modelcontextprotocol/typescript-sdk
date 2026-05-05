import type { Transform } from '../../../types.js';
import { contextTypesTransform } from './contextTypes.js';
import { expressMiddlewareTransform } from './expressMiddleware.js';
import { handlerRegistrationTransform } from './handlerRegistration.js';
import { importPathsTransform } from './importPaths.js';
import { mcpServerApiTransform } from './mcpServerApi.js';
import { mockPathsTransform } from './mockPaths.js';
import { removedApisTransform } from './removedApis.js';
import { schemaParamRemovalTransform } from './schemaParamRemoval.js';
import { specSchemaAccessTransform } from './specSchemaAccess.js';
import { symbolRenamesTransform } from './symbolRenames.js';

// Ordering matters — do not reorder without understanding dependencies:
//
// 1. importPaths MUST run first: rewrites import specifiers from v1 paths
//    (e.g., @modelcontextprotocol/sdk/types.js) to v2 packages. Later
//    transforms depend on the rewritten import declarations.
//
// 2. symbolRenames runs early: renames imported symbols (e.g., McpError →
//    ProtocolError) and rewrites type references (e.g., SchemaInput<T> →
//    StandardSchemaWithJSON.InferInput<T>).
//
// 3. removedApis runs after symbolRenames: handles removed Zod helpers,
//    IsomorphicHeaders, and StreamableHTTPError. Conceptually different
//    from renames — these are removals with diagnostic guidance.
//
// 4. mcpServerApi SHOULD run before contextTypes: it rewrites .tool() etc.
//    to .registerTool() etc. contextTypes handles both old and new names,
//    but running mcpServerApi first ensures consistent argument structure.
//
// 5. handlerRegistration, schemaParamRemoval, and expressMiddleware are
//    independent of each other but all depend on importPaths having run.
//
// 6. specSchemaAccess runs after handlerRegistration and schemaParamRemoval:
//    those transforms remove spec schema references they handle. specSchemaAccess
//    then processes remaining standalone usages (safeParse, parse, z.infer, etc.).
//
// 7. mockPaths runs last: handles test mocks and dynamic imports,
//    independent of the other transforms.
export const v1ToV2Transforms: Transform[] = [
    importPathsTransform,
    symbolRenamesTransform,
    removedApisTransform,
    mcpServerApiTransform,
    handlerRegistrationTransform,
    schemaParamRemovalTransform,
    specSchemaAccessTransform,
    expressMiddlewareTransform,
    contextTypesTransform,
    mockPathsTransform
];
