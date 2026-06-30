import type { Transform } from '../../../types';
import { commonjsInteropTransform } from './commonjsInterop';
import { completableNestingTransform } from './completableNesting';
import { contextTypesTransform } from './contextTypes';
import { handlerRegistrationTransform } from './handlerRegistration';
import { importPathsTransform } from './importPaths';
import { mcpServerApiTransform } from './mcpServerApi';
import { mockPathsTransform } from './mockPaths';
import { removedApisTransform } from './removedApis';
import { schemaParamRemovalTransform } from './schemaParamRemoval';
import { symbolRenamesTransform } from './symbolRenames';

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
// 5. handlerRegistration and schemaParamRemoval are independent of each
//    other but both depend on importPaths having run.
//
// 6. completableNesting runs after importPaths (it matches the rewritten
//    completable import) and is independent of the rest.
//
// 7. mockPaths handles test mocks and dynamic imports, independent of the
//    other transforms. It used to run last but no longer does (see item 8).
//
// 8. commonjsInterop MUST run last: it inspects the FINAL v2 package
//    specifiers that importPaths (and every later specifier-rewriting
//    transform) produce, then decides whether ESM-only value imports under
//    CommonJS can be converted to dynamic import() or must be diagnosed.
//    Running it after all other transforms ensures it sees the settled
//    import shape rather than intermediate v1/partially-rewritten specifiers.
export const v1ToV2Transforms: Transform[] = [
    importPathsTransform,
    symbolRenamesTransform,
    removedApisTransform,
    mcpServerApiTransform,
    handlerRegistrationTransform,
    schemaParamRemovalTransform,
    contextTypesTransform,
    completableNestingTransform,
    mockPathsTransform,
    commonjsInteropTransform
];
