import type { Transform } from '../../../types.js';
import { contextTypesTransform } from './contextTypes.js';
import { handlerRegistrationTransform } from './handlerRegistration.js';
import { importPathsTransform } from './importPaths.js';
import { mcpServerApiTransform } from './mcpServerApi.js';
import { mockPathsTransform } from './mockPaths.js';
import { schemaParamRemovalTransform } from './schemaParamRemoval.js';
import { symbolRenamesTransform } from './symbolRenames.js';

// Ordering matters — do not reorder without understanding dependencies:
//
// 1. importPaths MUST run first: rewrites import specifiers from v1 paths
//    (e.g., @modelcontextprotocol/sdk/types.js) to v2 packages. Later
//    transforms depend on the rewritten import declarations.
//
// 2. symbolRenames runs early: renames imported symbols (e.g., McpError →
//    ProtocolError) that later transforms may reference.
//
// 3. mcpServerApi SHOULD run before contextTypes: it rewrites .tool() etc.
//    to .registerTool() etc. contextTypes handles both old and new names,
//    but running mcpServerApi first ensures consistent argument structure.
//
// 4. handlerRegistration and schemaParamRemoval are independent of each
//    other but both depend on importPaths having run.
//
// 5. mockPaths runs last: handles test mocks and dynamic imports,
//    independent of the other transforms.
export const v1ToV2Transforms: Transform[] = [
    importPathsTransform,
    symbolRenamesTransform,
    mcpServerApiTransform,
    handlerRegistrationTransform,
    schemaParamRemovalTransform,
    contextTypesTransform,
    mockPathsTransform
];
