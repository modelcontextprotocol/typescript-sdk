# Codemod: Replace Manual AST Walking with `findReferencesAsNodes()`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify codemod transforms by replacing manual `forEachDescendant` + parent-kind-guard patterns with ts-morph's `findReferencesAsNodes()`, eliminating ~12 parent-kind guards, ~4 duplicate scope checks, and ~5 manual AST walk functions.

**Architecture:** ts-morph's TypeScript language service already resolves symbol bindings in the current syntax-only Project mode (no tsconfig needed). `findReferencesAsNodes()` returns precisely the references to a given symbol — correctly scoped, excluding property-name positions, and handling aliases. We refactor transforms to collect references via this API *before* mutating the AST, then apply changes in reverse-position order (a pattern the codemod already uses). A second phase optionally loads the user's tsconfig for receiver-type checking.

**Tech Stack:** ts-morph v28, vitest

**Key invariant:** `findReferencesAsNodes()` must be called *before* the symbol binding is modified (e.g., before an import specifier is renamed or removed). After mutation, collected Node objects remain valid but the language service can no longer resolve the original binding.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/codemod/src/utils/astUtils.ts` | Modify | Replace `renameAllReferences` internals with `findReferencesAsNodes()` |
| `packages/codemod/src/utils/importUtils.ts` | Modify | Add `findImportSpecifierByName`, simplify `removeUnusedImport` |
| `packages/codemod/src/migrations/v1-to-v2/transforms/symbolRenames.ts` | Modify | Collect refs before import mutation; use `findReferencesAsNodes()` in ErrorCode/RHE handlers |
| `packages/codemod/src/migrations/v1-to-v2/transforms/contextTypes.ts` | Modify | Use `findReferencesAsNodes()` on `extra` param; eliminate parent-kind guards and manual scope check |
| `packages/codemod/src/migrations/v1-to-v2/transforms/specSchemaAccess.ts` | Modify | Use `findReferencesAsNodes()` for schema refs; eliminate `findNonImportReferences()` |
| `packages/codemod/src/migrations/v1-to-v2/transforms/importPaths.ts` | Modify | Collect refs before import removal for renamed symbols |
| `packages/codemod/src/migrations/v1-to-v2/transforms/removedApis.ts` | Modify | Collect refs before import removal |
| `packages/codemod/src/types.ts` | Modify | Add optional `project` to `TransformContext` (Phase 2) |
| `packages/codemod/src/runner.ts` | Modify | Optionally resolve tsconfig; pass Project via context (Phase 2) |
| `packages/codemod/src/utils/projectAnalyzer.ts` | Modify | Add `findTsConfig()` (Phase 2) |
| All test files under `packages/codemod/test/v1-to-v2/transforms/` | Verify | Existing tests must pass unchanged — this is a refactor under green |

---

## Phase 1: `findReferencesAsNodes()` Refactor (no tsconfig needed)

### Task 1: Rewrite `renameAllReferences` in astUtils.ts

The current function (33 lines, 12 parent-kind guards) manually walks all identifiers and filters by parent kind. `findReferencesAsNodes()` eliminates 10 of those 12 guards — only `ShorthandPropertyAssignment` and `ExportSpecifier` need special handling since they require AST expansion (not just text replacement).

**Files:**
- Modify: `packages/codemod/src/utils/astUtils.ts`
- Verify: `packages/codemod/test/v1-to-v2/transforms/symbolRenames.test.ts` (primary consumer)

- [ ] **Step 1: Read the current implementation**

Read `packages/codemod/src/utils/astUtils.ts` — the entire file is the `renameAllReferences` function.

Current implementation walks all identifiers with matching text and checks 12 parent kinds:
```
ImportSpecifier, ExportSpecifier, PropertyAssignment (name), PropertyAccessExpression (name),
PropertySignature (name), MethodDeclaration (name), MethodSignature (name),
PropertyDeclaration (name), EnumMember (name), BindingElement (propertyName),
GetAccessorDeclaration (name), SetAccessorDeclaration (name), ShorthandPropertyAssignment
```

- [ ] **Step 2: Rewrite using `findReferencesAsNodes()`**

Replace the body of `renameAllReferences` with:

```typescript
import type { SourceFile } from 'ts-morph';
import { Node } from 'ts-morph';

export function renameAllReferences(sourceFile: SourceFile, oldName: string, newName: string): void {
    // Find the first identifier with this name to use as the findReferences anchor.
    // Must be called BEFORE the symbol's import specifier is renamed/removed.
    let anchor: import('ts-morph').Node | undefined;
    sourceFile.forEachDescendant(node => {
        if (anchor) return;
        if (Node.isIdentifier(node) && node.getText() === oldName) {
            anchor = node;
        }
    });
    if (!anchor) return;

    const refs = anchor.findReferencesAsNodes();

    // Apply in reverse position order to avoid invalidating earlier nodes
    const sorted = refs.toSorted((a, b) => b.getStart() - a.getStart());
    for (const ref of sorted) {
        if (ref.wasForgotten()) continue;
        const parent = ref.getParent();
        if (!parent) continue;

        // Skip import specifiers — caller manages those
        if (Node.isImportSpecifier(parent)) continue;

        // ExportSpecifier: preserve public name by adding alias
        if (Node.isExportSpecifier(parent)) {
            if (parent.getAliasNode() === ref) continue;
            if (!parent.getAliasNode()) parent.setAlias(oldName);
            parent.getNameNode().replaceWithText(newName);
            continue;
        }

        // ShorthandPropertyAssignment: expand { McpError } → { McpError: ProtocolError }
        if (Node.isShorthandPropertyAssignment(parent)) {
            parent.replaceWithText(`${oldName}: ${newName}`);
            continue;
        }

        ref.replaceWithText(newName);
    }
}
```

The 10 parent-kind guards (PropertyAssignment name, PropertyAccessExpression name, PropertySignature name, MethodDeclaration name, MethodSignature name, PropertyDeclaration name, EnumMember name, BindingElement propertyName, GetAccessor name, SetAccessor name) are all handled automatically by `findReferencesAsNodes()` — it never returns identifier nodes in property-name positions.

- [ ] **Step 3: Run all transform tests to verify**

Run: `pnpm --filter @modelcontextprotocol/codemod test`

Expected: all tests pass. The `renameAllReferences` function is called by `symbolRenames`, `importPaths`, and `removedApis` transforms — all their tests exercise it.

- [ ] **Step 4: Suggest commit**

```
feat(codemod): rewrite renameAllReferences using findReferencesAsNodes

Replace manual 12-case parent-kind guard with ts-morph's
findReferencesAsNodes() which handles scope and position
classification automatically. Only ShorthandPropertyAssignment
and ExportSpecifier need explicit handling for AST expansion.
```

---

### Task 2: Refactor `symbolRenames.ts` — collect refs before import mutation

The SIMPLE_RENAMES loop currently modifies the import specifier first, then calls `renameAllReferences`. But `findReferencesAsNodes()` must be called *before* the binding is modified. This task reorders the operations.

The three `forEachDescendant` walks in `handleErrorCodeSplit` and `handleRequestHandlerExtra` are also replaced.

**Files:**
- Modify: `packages/codemod/src/migrations/v1-to-v2/transforms/symbolRenames.ts`
- Verify: `packages/codemod/test/v1-to-v2/transforms/symbolRenames.test.ts`

- [ ] **Step 1: Read current file**

Read `packages/codemod/src/migrations/v1-to-v2/transforms/symbolRenames.ts` (352 lines).

The SIMPLE_RENAMES loop (lines 23-37):
```typescript
for (const namedImport of imp.getNamedImports()) {
    const name = namedImport.getName();
    const newName = SIMPLE_RENAMES[name];
    if (newName) {
        namedImport.setName(newName);      // modifies binding FIRST
        const alias = namedImport.getAliasNode();
        if (!alias) {
            renameAllReferences(sourceFile, name, newName);  // then renames body
        }
        changesCount++;
    }
}
```

- [ ] **Step 2: Reorder SIMPLE_RENAMES to collect-before-mutate**

```typescript
for (const namedImport of imp.getNamedImports()) {
    const name = namedImport.getName();
    const newName = SIMPLE_RENAMES[name];
    if (newName) {
        const alias = namedImport.getAliasNode();
        if (!alias) {
            // Collect refs while binding is still intact
            renameAllReferences(sourceFile, name, newName);
        }
        namedImport.setName(newName);      // modify binding AFTER refs are renamed
        changesCount++;
    }
}
```

Note: this is just reordering the two operations. `renameAllReferences` (from Task 1) now uses `findReferencesAsNodes()` internally, which requires the binding to still exist. Moving `setName` after `renameAllReferences` satisfies this requirement.

- [ ] **Step 3: Refactor `handleErrorCodeSplit` to use `findReferencesAsNodes()`**

Current code (lines 71-85) does a manual `forEachDescendant` looking for `Node.isPropertyAccessExpression` where the expression is `ErrorCode`. Replace with:

```typescript
function handleErrorCodeSplit(sourceFile: SourceFile, diagnostics: Diagnostic[]): number {
    let changesCount = 0;

    const imports = sourceFile.getImportDeclarations();
    let errorCodeImport: ReturnType<(typeof imports)[0]['getNamedImports']>[0] | undefined;

    for (const imp of imports) {
        if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
        for (const namedImport of imp.getNamedImports()) {
            if (namedImport.getName() === 'ErrorCode') {
                errorCodeImport = namedImport;
                break;
            }
        }
        if (errorCodeImport) break;
    }

    if (!errorCodeImport) return 0;

    // Collect ALL references while binding exists
    const refs = errorCodeImport.getNameNode().findReferencesAsNodes()
        .filter(n => !Node.isImportSpecifier(n.getParent()));

    let needsProtocolErrorCode = false;
    let needsSdkErrorCode = false;

    // Classify each reference
    const replacements: { node: import('ts-morph').Node; newText: string }[] = [];
    for (const ref of refs) {
        const parent = ref.getParent();
        if (!parent || !Node.isPropertyAccessExpression(parent)) continue;
        if (parent.getExpression() !== ref) continue;

        const member = parent.getName();
        if (ERROR_CODE_SDK_MEMBERS.has(member)) {
            needsSdkErrorCode = true;
            replacements.push({ node: ref, newText: 'SdkErrorCode' });
        } else {
            needsProtocolErrorCode = true;
            replacements.push({ node: ref, newText: 'ProtocolErrorCode' });
        }
        changesCount++;
    }

    // Apply replacements in reverse order
    const sorted = replacements.toSorted((a, b) => b.node.getStart() - a.node.getStart());
    for (const { node, newText } of sorted) {
        node.replaceWithText(newText);
    }

    // ... rest of import cleanup (unchanged from current code, lines 87-143) ...
```

This eliminates the `forEachDescendant` walk. The `errorCodeLocalName` variable and manual alias handling are also gone — `findReferencesAsNodes()` resolves aliases automatically.

- [ ] **Step 4: Refactor `handleRequestHandlerExtra` similarly**

The `forEachDescendant` walk at line 189 that finds `Node.isTypeReference` matching `extraLocalName` becomes:

```typescript
// Collect refs while binding exists
const refs = extraImport.getNameNode().findReferencesAsNodes()
    .filter(n => !Node.isImportSpecifier(n.getParent()));
```

The rest of the classification logic (checking `ServerRequest`/`ClientNotification` type args) stays the same — it operates on the parent `TypeReference` node. But we no longer need `extraLocalName` or manual alias handling.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/symbolRenames.test.ts`

Expected: all tests pass, including alias tests (lines 366-399).

- [ ] **Step 6: Suggest commit**

```
refactor(codemod): use findReferencesAsNodes in symbolRenames

Collect symbol references via findReferencesAsNodes() before
mutating import specifiers. Eliminates three forEachDescendant
walks and manual alias tracking in handleErrorCodeSplit and
handleRequestHandlerExtra.
```

---

### Task 3: Refactor `contextTypes.ts` — eliminate parent-kind guards and scope checks

This transform has the second-highest complexity. The `processCallback` function (lines 18-177):
- Walks callback body with `forEachDescendant` looking for `extra` identifiers (line 98)
- Checks 4 parent kinds to exclude property-name positions (lines 102-105)
- Does a separate `forEachDescendant` walk to check for `ctx` name conflicts (lines 63-74)
- Builds replacements with property mappings (lines 111-134)

All of this collapses with `findReferencesAsNodes()` on the parameter.

**Files:**
- Modify: `packages/codemod/src/migrations/v1-to-v2/transforms/contextTypes.ts`
- Verify: `packages/codemod/test/v1-to-v2/transforms/contextTypes.test.ts`

- [ ] **Step 1: Read the current processCallback function**

Read `packages/codemod/src/migrations/v1-to-v2/transforms/contextTypes.ts:18-177`.

Key sections to replace:
- Lines 61-84: scope-conflict check (walk looking for `ctx` identifier)
- Lines 96-107: collect identifiers matching `extra`, filter 4 parent kinds
- Lines 110-135: build replacements

- [ ] **Step 2: Replace identifier collection with findReferencesAsNodes**

Replace lines 62-84 (scope conflict check) and lines 96-107 (identifier collection) with:

```typescript
    // Check for ctx name conflicts in the callback body using findReferences on
    // any existing 'ctx' identifier — if found, it means ctx is in scope.
    if (body) {
        let ctxAlreadyInScope = false;
        body.forEachDescendant(node => {
            if (ctxAlreadyInScope) return;
            if (Node.isIdentifier(node) && node.getText() === CTX_PARAM_NAME) {
                // Check it's not inside a nested function that shadows it
                const containingFn = node.getFirstAncestor(n =>
                    Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isFunctionDeclaration(n)
                );
                if (containingFn === callbackNode || !containingFn) {
                    ctxAlreadyInScope = true;
                }
            }
        });
        if (ctxAlreadyInScope) {
            diagnostics.push(
                warning(
                    sourceFile.getFilePath(),
                    extraParam.getStartLineNumber(),
                    `Cannot rename '${EXTRA_PARAM_NAME}' to '${CTX_PARAM_NAME}': '${CTX_PARAM_NAME}' is already referenced in this scope. Manual migration required.`
                )
            );
            return -1;
        }
    }

    // Collect references to the 'extra' parameter using findReferencesAsNodes.
    // This automatically:
    //   - scopes to this specific parameter binding (ignores shadowed 'extra' in nested fns)
    //   - excludes property-name positions ({ extra: value }, obj.extra, etc.)
    const paramRefs = extraParam.getNameNode().findReferencesAsNodes()
        .filter(n => !Node.isParameter(n.getParent()));

    // Rename param declaration
    const paramDecl = extraParam.getNameNode();
    paramDecl.replaceWithText(CTX_PARAM_NAME);

    // Build replacements from collected references
    const sortedMappings = [...CONTEXT_PROPERTY_MAP]
        .filter(m => m.from !== m.to)
        .toSorted((a, b) => b.from.length - a.from.length);

    const replacements: { node: import('ts-morph').Node; newText: string }[] = [];
    for (const ref of paramRefs) {
        const parent = ref.getParent();
        // Value-position property access: extra.signal → ctx.mcpReq.signal
        if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === ref) {
            const propName = '.' + parent.getName();
            const mapping = sortedMappings.find(m => m.from === propName);
            if (mapping) {
                replacements.push({ node: parent, newText: CTX_PARAM_NAME + mapping.to });
                continue;
            }
        }
        // Type-position qualified name: typeof extra.signal → typeof ctx.mcpReq.signal
        if (parent && parent.getKind() === SyntaxKind.QualifiedName && parent.getChildAtIndex(0) === ref) {
            const right = parent.getChildAtIndex(2);
            if (right) {
                const propName = '.' + right.getText();
                const mapping = sortedMappings.find(m => m.from === propName);
                if (mapping) {
                    replacements.push({ node: parent, newText: CTX_PARAM_NAME + mapping.to });
                    continue;
                }
            }
        }
        replacements.push({ node: ref, newText: CTX_PARAM_NAME });
    }

    const sorted = replacements.toSorted((a, b) => b.node.getStart() - a.node.getStart());
    for (const { node, newText } of sorted) {
        node.replaceWithText(newText);
    }
```

**What's eliminated:**
- The 4-case parent-kind exclusion list (lines 102-106) — `findReferencesAsNodes()` handles these
- The nested-function-aware scope walk for conflict detection (lines 63-74) — simplified to a targeted check

**What stays the same:**
- Property mapping logic (PropertyAccessExpression / QualifiedName) — this is transform-specific
- The outer call-finding loop and callback detection
- The post-rewrite destructuring warning

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/contextTypes.test.ts`

Expected: all tests pass. Key tests to watch:
- `should not rename 'extra' in property positions` (verifies parent-kind exclusion)
- `should not rename when ctx already exists` (verifies scope conflict)
- `should handle nested functions` (verifies scope isolation)

- [ ] **Step 4: Suggest commit**

```
refactor(codemod): use findReferencesAsNodes in contextTypes

Replace manual forEachDescendant + 4-case parent-kind guard with
findReferencesAsNodes() on the 'extra' parameter. The language
service handles scope isolation and property-name exclusion
automatically.
```

---

### Task 4: Refactor `specSchemaAccess.ts` — eliminate `findNonImportReferences` and scoped walks

This is the most complex transform (350 lines, 6 parent-kind guards, 3-level parent walks). Two `forEachDescendant` walks are replaced.

**Files:**
- Modify: `packages/codemod/src/migrations/v1-to-v2/transforms/specSchemaAccess.ts`
- Verify: `packages/codemod/test/v1-to-v2/transforms/specSchemaAccess.test.ts`

- [ ] **Step 1: Read the current file**

Read `packages/codemod/src/migrations/v1-to-v2/transforms/specSchemaAccess.ts`.

Key sections:
- `findNonImportReferences` (lines 51-61): manual forEachDescendant walk
- `handleReference` (lines 63-192): 6 parent-kind guards at lines 129, 143, 154, 168, 172, 176
- `rewriteCapturedSafeParse` (lines 249-335): scoped forEachDescendant walk at line 269

- [ ] **Step 2: Replace `findNonImportReferences` with `findReferencesAsNodes`**

In the main loop (lines 19-31), replace:
```typescript
const refs = findNonImportReferences(sourceFile, localName);
```
with:
```typescript
// Find the import specifier node for this schema
const specNode = schemaImports.get(localName)!.specifier;
const refs = specNode.getNameNode().findReferencesAsNodes()
    .filter(n => !Node.isImportSpecifier(n.getParent()));
```

This requires changing `collectSpecSchemaImports` to also return the specifier node:
```typescript
function collectSpecSchemaImports(sourceFile: SourceFile): Map<string, { originalName: string; specifier: import('ts-morph').ImportSpecifier }> {
    const result = new Map<string, { originalName: string; specifier: import('ts-morph').ImportSpecifier }>();
    for (const imp of sourceFile.getImportDeclarations()) {
        if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
        for (const n of imp.getNamedImports()) {
            const exportName = n.getName();
            if (!SPEC_SCHEMA_NAMES.has(exportName)) continue;
            const localName = n.getAliasNode()?.getText() ?? exportName;
            result.set(localName, { originalName: exportName, specifier: n });
        }
    }
    return result;
}
```

Delete the `findNonImportReferences` function entirely.

- [ ] **Step 3: Simplify `handleReference` parent-kind guards**

With `findReferencesAsNodes()`, we no longer get identifiers in property-name positions. Remove these now-unreachable guards:

```typescript
// REMOVE — findReferencesAsNodes never returns property-name-position identifiers:
// - line 168: Node.isPropertyAssignment(parent) && parent.getNameNode() === ref
// - line 172: Node.isBindingElement(parent) && parent.getPropertyNameNode() === ref
// - line 176: Node.isPropertyAccessExpression(parent) && parent.getNameNode() === ref
```

Keep these — they classify the reference type, not exclude positions:
- `isTypeofInTypePosition` — distinguishes type-level `typeof X` from value usage
- `isSafeParseSuccessPattern` / `isSafeParsePattern` / `isParsePattern` — detect Zod API patterns
- `Node.isPropertyAccessExpression(parent) && parent.getExpression() === ref` — value-position property access
- `Node.isExportSpecifier(parent)` — re-export position
- `Node.isShorthandPropertyAssignment(parent)` — shorthand property

- [ ] **Step 4: Replace scoped walk in `rewriteCapturedSafeParse`**

Current code (lines 268-317) does `scope.forEachDescendant` to find `${varName}.success`, `${varName}.data`, `${varName}.error` accesses. Replace with `findReferencesAsNodes()` on the variable declaration:

```typescript
function rewriteCapturedSafeParse(
    safeParseCall: import('ts-morph').CallExpression,
    localName: string,
    typeName: string,
    sourceFile: SourceFile,
    diagnostics: Diagnostic[]
): boolean {
    const varDecl = safeParseCall.getParent() as import('ts-morph').VariableDeclaration;
    const varName = varDecl.getName();
    const args = safeParseCall.getArguments();
    const argText = args.length > 0 ? args[0]!.getText() : '';

    // Collect references to the result variable BEFORE rewriting the initializer
    const varNameNode = varDecl.getNameNode();
    const varRefs = varNameNode.findReferencesAsNodes()
        .filter(n => n !== varNameNode && !Node.isVariableDeclaration(n.getParent()));

    // Rewrite the safeParse call
    safeParseCall.replaceWithText(`specTypeSchemas.${typeName}['~standard'].validate(${argText})`);
    ensureImport(sourceFile, 'specTypeSchemas');

    // Classify property accesses on the result variable
    const replacements: { node: import('ts-morph').Node; newText: string }[] = [];
    for (const ref of varRefs) {
        const parent = ref.getParent();
        if (!parent || !Node.isPropertyAccessExpression(parent)) continue;
        if (parent.getExpression() !== ref) continue;

        const propName = parent.getName();
        switch (propName) {
            case 'success': {
                const grandParent = parent.getParent();
                if (grandParent && Node.isPrefixUnaryExpression(grandParent) &&
                    grandParent.getOperatorToken() === SyntaxKind.ExclamationToken) {
                    replacements.push({ node: grandParent, newText: `${varName}.issues !== undefined` });
                } else {
                    replacements.push({ node: parent, newText: `(${varName}.issues === undefined)` });
                }
                break;
            }
            case 'data':
                replacements.push({ node: parent, newText: `${varName}.value` });
                break;
            case 'error': {
                const errorParent = parent.getParent();
                if (errorParent && Node.isPropertyAccessExpression(errorParent) && errorParent.getExpression() === parent) {
                    const subProp = errorParent.getName();
                    if (subProp === 'issues') {
                        replacements.push({ node: errorParent, newText: `${varName}.issues` });
                    } else if (subProp === 'message') {
                        replacements.push({ node: errorParent, newText: `${varName}.issues?.map(i => i.message).join(', ')` });
                    } else {
                        diagnostics.push(warning(sourceFile.getFilePath(), errorParent.getStartLineNumber(),
                            `${varName}.error.${subProp} has no StandardSchema equivalent. Manual migration required.`));
                    }
                } else {
                    replacements.push({ node: parent, newText: `${varName}.issues` });
                }
                break;
            }
        }
    }

    const sorted = replacements.toSorted((a, b) => b.node.getStart() - a.node.getStart());
    for (const { node, newText } of sorted) {
        node.replaceWithText(newText);
    }

    diagnostics.push(warning(sourceFile.getFilePath(), varDecl.getStartLineNumber(),
        `Rewrote ${localName}.safeParse() to specTypeSchemas.${typeName}['~standard'].validate(). ` +
        `Result properties remapped: .success → .issues === undefined, .data → .value, .error → .issues.`));

    return true;
}
```

**What's eliminated:**
- `findNonImportReferences` function (11 lines) — deleted entirely
- 3 unreachable parent-kind guards in `handleReference`
- The `scope.forEachDescendant` walk in `rewriteCapturedSafeParse` (was scope-insensitive anyway, as a PR comment noted)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/specSchemaAccess.test.ts`

Expected: all tests pass. Key tests:
- Aliased import `import { CallToolRequestSchema as CTRS }` (line 493)
- Captured safeParse rewrite (line 248+)
- Non-MCP schemas not touched (line 222+)

- [ ] **Step 6: Suggest commit**

```
refactor(codemod): use findReferencesAsNodes in specSchemaAccess

Delete findNonImportReferences() and replace both forEachDescendant
walks with findReferencesAsNodes(). The scoped safeParse-result
rewrite now uses findReferencesAsNodes on the variable declaration,
which is inherently scope-correct.
```

---

### Task 5: Refactor `importPaths.ts` — collect refs before import removal

Currently, `importPaths.ts` removes the old import (line 170), then calls `renameAllReferences` (line 172). Since Task 1's `renameAllReferences` now uses `findReferencesAsNodes()`, the binding must exist when it's called. Reorder operations.

**Files:**
- Modify: `packages/codemod/src/migrations/v1-to-v2/transforms/importPaths.ts`
- Verify: `packages/codemod/test/v1-to-v2/transforms/importPaths.test.ts`

- [ ] **Step 1: Read the relevant section**

Read `packages/codemod/src/migrations/v1-to-v2/transforms/importPaths.ts:106-175`.

The issue is at lines 162-175:
```typescript
for (const n of namedImports) {
    // ... add pending imports ...
}
imp.remove();        // ← removes binding
changesCount++;
for (const [oldName, newName] of symbolsToRenameInFile) {
    renameAllReferences(sourceFile, oldName, newName);  // ← needs binding
}
```

- [ ] **Step 2: Move rename before import removal**

```typescript
// Rename body references BEFORE removing the import (findReferencesAsNodes needs the binding)
for (const [oldName, newName] of symbolsToRenameInFile) {
    renameAllReferences(sourceFile, oldName, newName);
}

for (const n of namedImports) {
    const name = n.getName();
    const resolvedName = mapping.renamedSymbols?.[name] ?? name;
    const specifierTypeOnly = typeOnly || n.isTypeOnly();
    const symbolTarget = mapping.symbolTargetOverrides?.[name] ?? targetPackage;
    usedPackages.add(symbolTarget);
    addPending(symbolTarget, [resolvedName], specifierTypeOnly);
}
imp.remove();
changesCount++;
```

Also apply the same reorder to the in-place `setModuleSpecifier` branch (lines 106-159): move `renameAllReferences` calls (lines 156-158) before `imp.setModuleSpecifier` (line 136) — though `setModuleSpecifier` doesn't break bindings, it's cleaner to be consistent.

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/importPaths.test.ts`

Expected: all tests pass.

- [ ] **Step 4: Suggest commit**

```
refactor(codemod): reorder importPaths to rename refs before import removal

findReferencesAsNodes() (used by renameAllReferences) needs the
import binding to still exist. Move rename calls before imp.remove().
```

---

### Task 6: Refactor `removedApis.ts` — same reorder pattern

Same issue: `renameAllReferences` called after import removal.

**Files:**
- Modify: `packages/codemod/src/migrations/v1-to-v2/transforms/removedApis.ts`
- Verify: `packages/codemod/test/v1-to-v2/transforms/removedApis.test.ts`

- [ ] **Step 1: Read the relevant sections**

Read `packages/codemod/src/migrations/v1-to-v2/transforms/removedApis.ts`.

Find all places where `renameAllReferences` is called and check whether the import binding has already been removed/modified.

- [ ] **Step 2: Move renames before import removal**

Apply the same pattern as Task 5: collect or apply renames before the import specifier or declaration is removed.

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/removedApis.test.ts`

Expected: all tests pass.

- [ ] **Step 4: Suggest commit**

```
refactor(codemod): reorder removedApis to rename refs before import removal
```

---

### Task 7: Simplify `removeUnusedImport` in importUtils.ts

The `removeUnusedImport` function (lines 116-141) does a manual `forEachDescendant` walk to count references. Replace with `findReferencesAsNodes()`.

**Files:**
- Modify: `packages/codemod/src/utils/importUtils.ts`
- Verify: `pnpm --filter @modelcontextprotocol/codemod test`

- [ ] **Step 1: Read the current function**

Read `packages/codemod/src/utils/importUtils.ts:116-141`.

- [ ] **Step 2: Rewrite using findReferencesAsNodes**

```typescript
export function removeUnusedImport(sourceFile: SourceFile, symbolName: string, onlyMcpImports?: boolean): void {
    for (const imp of sourceFile.getImportDeclarations()) {
        if (onlyMcpImports && !isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
        for (const namedImport of imp.getNamedImports()) {
            if ((namedImport.getAliasNode()?.getText() ?? namedImport.getName()) === symbolName) {
                // Check if the symbol has any non-import references
                const refs = namedImport.getNameNode().findReferencesAsNodes()
                    .filter(n => !Node.isImportSpecifier(n.getParent()));
                if (refs.length === 0) {
                    namedImport.remove();
                    if (imp.getNamedImports().length === 0 && !imp.getDefaultImport() && !imp.getNamespaceImport()) {
                        imp.remove();
                    }
                }
                return;
            }
        }
    }
}
```

This eliminates the manual reference-counting `forEachDescendant` walk.

- [ ] **Step 3: Run all tests**

Run: `pnpm --filter @modelcontextprotocol/codemod test`

Expected: all tests pass. `removeUnusedImport` is called by `specSchemaAccess` and `symbolRenames`.

- [ ] **Step 4: Suggest commit**

```
refactor(codemod): use findReferencesAsNodes in removeUnusedImport
```

---

### Task 8: Full test suite verification and cleanup

- [ ] **Step 1: Run full test suite**

Run: `pnpm --filter @modelcontextprotocol/codemod test`

Expected: all 14 test files pass.

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter @modelcontextprotocol/codemod typecheck`

Expected: no type errors.

- [ ] **Step 3: Run lint**

Run: `pnpm --filter @modelcontextprotocol/codemod lint`

Expected: no lint errors.

- [ ] **Step 4: Remove dead code**

Check if these functions are still used:
- `findNonImportReferences` in specSchemaAccess.ts — should be deleted (Task 4)
- Any unused imports in modified files

- [ ] **Step 5: Suggest commit**

```
chore(codemod): remove dead code after findReferencesAsNodes refactor
```

---

## Phase 2: Optional tsconfig Loading for Receiver Type Checking

This phase is independent of Phase 1 and addresses a different class of PR comments: transforms that cannot verify the *receiver* of a method call (e.g., `.tool()` might be on any object, not just `McpServer`).

### Task 9: Add tsconfig resolution to projectAnalyzer

**Files:**
- Modify: `packages/codemod/src/utils/projectAnalyzer.ts`
- Modify: `packages/codemod/src/types.ts`
- Modify: `packages/codemod/src/runner.ts`
- Test: `packages/codemod/test/projectAnalyzer.test.ts`

- [ ] **Step 1: Add `findTsConfig` to projectAnalyzer**

```typescript
export function findTsConfig(startDir: string): string | undefined {
    let dir = path.resolve(startDir);
    const root = path.parse(dir).root;
    while (true) {
        const candidate = path.join(dir, 'tsconfig.json');
        if (existsSync(candidate)) return candidate;
        if (dir === root) return undefined;
        if (PROJECT_ROOT_MARKERS.some(m => existsSync(path.join(dir, m)))) return undefined;
        dir = path.dirname(dir);
    }
}
```

- [ ] **Step 2: Extend `TransformContext` with optional Project**

In `packages/codemod/src/types.ts`:

```typescript
import type { Project, SourceFile } from 'ts-morph';

export interface TransformContext {
    projectType: 'client' | 'server' | 'both' | 'unknown';
    project?: Project;
    hasTypeInfo?: boolean;
}
```

- [ ] **Step 3: Modify runner to optionally load tsconfig**

In `packages/codemod/src/runner.ts`, change Project creation:

```typescript
import { findTsConfig } from './utils/projectAnalyzer.js';

const tsConfigPath = findTsConfig(options.targetDir);
const project = new Project({
    tsConfigFilePath: tsConfigPath,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
        allowJs: true,
        noEmit: true,
        skipLibCheck: true,
        ...(tsConfigPath ? {} : { strict: false }),
    }
});

// ... existing file globbing ...

const hasTypeInfo = !!tsConfigPath;
const context: TransformContext = {
    ...analyzeProject(options.targetDir),
    project,
    hasTypeInfo,
};
```

Note: `skipAddingFilesFromTsConfig: true` keeps the current behavior of globbing files ourselves. But with a tsconfig, ts-morph resolves module paths and loads declaration files from `node_modules`.

- [ ] **Step 4: Test with and without tsconfig**

The existing tests use `new Project({ useInMemoryFileSystem: true })` and pass `TransformContext` without a `project` field. They should continue to work because `project` and `hasTypeInfo` are optional.

Add a targeted test in `packages/codemod/test/projectAnalyzer.test.ts`:

```typescript
describe('findTsConfig', () => {
    it('should find tsconfig.json in target directory', () => {
        const dir = mkdtempSync(join(tmpdir(), 'codemod-'));
        writeFileSync(join(dir, 'tsconfig.json'), '{}');
        expect(findTsConfig(dir)).toBe(join(dir, 'tsconfig.json'));
        rmSync(dir, { recursive: true });
    });

    it('should walk up to find tsconfig.json', () => {
        const dir = mkdtempSync(join(tmpdir(), 'codemod-'));
        const subDir = join(dir, 'src');
        mkdirSync(subDir);
        writeFileSync(join(dir, 'tsconfig.json'), '{}');
        expect(findTsConfig(subDir)).toBe(join(dir, 'tsconfig.json'));
        rmSync(dir, { recursive: true });
    });

    it('should return undefined when no tsconfig exists', () => {
        const dir = mkdtempSync(join(tmpdir(), 'codemod-'));
        mkdirSync(join(dir, '.git'));
        expect(findTsConfig(dir)).toBeUndefined();
        rmSync(dir, { recursive: true });
    });
});
```

- [ ] **Step 5: Suggest commit**

```
feat(codemod): optionally resolve tsconfig for type-aware transforms

When a tsconfig.json is found near the target directory, the ts-morph
Project loads it for module resolution and type information. Transforms
can check context.hasTypeInfo to use type-aware APIs. Falls back to
syntax-only mode when no tsconfig is found.
```

---

### Task 10: Add receiver type checking to `mcpServerApi.ts`

When type info is available, verify that `.tool()` / `.prompt()` / `.resource()` calls are on an `McpServer` instance. This addresses the PR comment about false positives on `someOtherObj.tool()`.

**Files:**
- Modify: `packages/codemod/src/migrations/v1-to-v2/transforms/mcpServerApi.ts`
- Verify: `packages/codemod/test/v1-to-v2/transforms/mcpServerApi.test.ts`

- [ ] **Step 1: Add a receiver-type guard helper**

At the top of `mcpServerApi.ts`:

```typescript
function isMcpServerReceiver(expr: import('ts-morph').PropertyAccessExpression, context: TransformContext): boolean {
    if (!context.hasTypeInfo) return true; // permissive when no types

    try {
        const receiverType = expr.getExpression().getType();
        const symbol = receiverType.getSymbol();
        if (!symbol) return true; // can't determine — be permissive
        const name = symbol.getName();
        return name === 'McpServer';
    } catch {
        return true; // type resolution failed — be permissive
    }
}
```

- [ ] **Step 2: Guard the call collection loop**

In the switch statement (lines 33-59), add the guard:

```typescript
for (const call of calls) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;
    if (!isMcpServerReceiver(expr, context)) continue;  // ← NEW
    const methodName = expr.getName();
    // ... rest of switch ...
}
```

Note: `_context` parameter in `apply()` must be renamed to `context` since it's now used.

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/mcpServerApi.test.ts`

Expected: all tests pass. Tests use in-memory projects without type info, so `isMcpServerReceiver` returns `true` (permissive mode).

- [ ] **Step 4: Suggest commit**

```
feat(codemod): add receiver type checking for McpServer API migration

When type info is available (tsconfig resolved), verify that .tool(),
.prompt(), .resource() calls are on McpServer instances. Falls back
to permissive mode when types unavailable.
```

---

## Summary of Changes

| Metric | Before | After Phase 1 | After Phase 2 |
|--------|--------|---------------|---------------|
| `renameAllReferences` parent guards | 12 | 2 (ShorthandProp, ExportSpecifier) | 2 |
| `contextTypes` parent guards | 4 | 0 | 0 |
| `specSchemaAccess` parent guards | 6 | 3 (pattern classification only) | 3 |
| `forEachDescendant` walks across all transforms | ~12 | ~4 | ~4 |
| Manual import-provenance functions | 6 | 6 (unchanged) | 6 (could reduce further) |
| Receiver type checking | none | none | mcpServerApi |
| Lines in astUtils.ts | 33 | ~28 | ~28 |
| Lines in specSchemaAccess.ts | 350 | ~300 | ~300 |
| Lines in contextTypes.ts | 257 | ~200 | ~200 |
| Lines in symbolRenames.ts | 352 | ~310 | ~310 |

Phase 1 (Tasks 1-8) is the high-value work. Phase 2 (Tasks 9-10) is additive improvement.
