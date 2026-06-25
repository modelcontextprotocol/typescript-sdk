// Shared per-symbol routing logic for v1→v2 import/export/mock rewrites. Centralized here so the
// import-path transform (static imports/re-exports) and the mock-path transform (vi.mock/jest.mock
// factories, dynamic import() destructurings) route a given symbol to exactly the same v2 package.
import { AUTH_SCHEMA_NAMES } from './authSchemaNames';
import type { ImportMapping } from './importMap';
import { SPEC_SCHEMA_NAMES } from './specSchemaNames';
import { SIMPLE_RENAMES } from './symbolMap';

/** The v2 name a symbol resolves to after renames (per-mapping override, then global SIMPLE_RENAMES). */
export function resolveRenamedName(name: string, mapping: ImportMapping): string {
    return mapping.renamedSymbols?.[name] ?? SIMPLE_RENAMES[name] ?? name;
}

/**
 * True when `name` (after renames) is a Zod schema CONSTANT that core re-exports — either a spec
 * schema (`SPEC_SCHEMA_NAMES`) or an OAuth/OpenID schema (`AUTH_SCHEMA_NAMES`). Membership (not a
 * `*Schema` suffix) is what keeps TYPES whose name ends in `Schema` — e.g. `BooleanSchema` — out.
 */
export function isSharedSchemaConst(name: string, mapping: ImportMapping): boolean {
    const resolved = resolveRenamedName(name, mapping);
    return SPEC_SCHEMA_NAMES.has(resolved) || AUTH_SCHEMA_NAMES.has(resolved);
}

/**
 * The per-symbol target package for a symbol imported/re-exported/mocked from `mapping`'s module, or
 * `undefined` when the symbol should use the mapping's resolved `target`. Exact-name
 * `symbolTargetOverrides` win over `schemaSymbolTarget`, which routes a symbol to the shared-schemas
 * package only when its rename-resolved name is a schema constant re-exported by core (see
 * `isSharedSchemaConst`).
 */
export function symbolTargetOverride(name: string, mapping: ImportMapping): string | undefined {
    if (mapping.symbolTargetOverrides && name in mapping.symbolTargetOverrides) {
        return mapping.symbolTargetOverrides[name];
    }
    if (mapping.schemaSymbolTarget && isSharedSchemaConst(name, mapping)) {
        return mapping.schemaSymbolTarget;
    }
    return undefined;
}
