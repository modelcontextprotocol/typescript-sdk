# Codemod Batch Test Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 codemod transform issues discovered by running the batch test against real-world repos (inspector + mcp-servers-fork).

**Architecture:** Each fix targets a specific transform or mapping file within `packages/codemod/src/migrations/v1-to-v2/`. Fixes are ordered by dependency: Tasks 1 and 4 are independent; Tasks 2 and 3 both modify `specSchemaAccess.ts` so Task 2 must land first; Task 5 is independent. All tasks follow TDD.

**Tech Stack:** TypeScript, ts-morph (AST manipulation), vitest

---

## File Map

| File | Action | Task(s) |
|------|--------|---------|
| `packages/codemod/src/migrations/v1-to-v2/mappings/schemaToMethodMap.ts` | Modify | 1 |
| `packages/codemod/test/v1-to-v2/transforms/handlerRegistration.test.ts` | Modify | 1 |
| `packages/codemod/src/migrations/v1-to-v2/transforms/specSchemaAccess.ts` | Modify | 2, 3 |
| `packages/codemod/test/v1-to-v2/transforms/specSchemaAccess.test.ts` | Modify | 2, 3 |
| `packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts` | Modify | 4, 5 |
| `packages/codemod/test/v1-to-v2/transforms/importPaths.test.ts` | Modify | 4, 5 |

---

### Task 1: Complete handler registration schema-to-method mapping

Add missing experimental/task request schemas and notification schemas to `schemaToMethodMap.ts` so the `handlerRegistration` transform auto-converts them to string method names instead of falling through to `specSchemaAccess` which incorrectly replaces them with `specTypeSchemas.X`.

**Impact:** Fixes ~20 errors in inspector/client `useConnection.ts` (setRequestHandler + downstream param type inference).

**Files:**
- Modify: `packages/codemod/src/migrations/v1-to-v2/mappings/schemaToMethodMap.ts`
- Test: `packages/codemod/test/v1-to-v2/transforms/handlerRegistration.test.ts`

- [ ] **Step 1: Write failing tests for task request schemas**

Add to `handlerRegistration.test.ts`:

```typescript
it('replaces ListTasksRequestSchema with method string', () => {
    const input = [
        `import { ListTasksRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
        `client.setRequestHandler(ListTasksRequestSchema, async (request) => {`,
        `    return { tasks: [] };`,
        `});`,
        ''
    ].join('\n');
    const result = applyTransform(input);
    expect(result).toContain("setRequestHandler('tasks/list'");
    expect(result).not.toContain('ListTasksRequestSchema');
});

it('replaces GetTaskRequestSchema with method string', () => {
    const input = [
        `import { GetTaskRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
        `client.setRequestHandler(GetTaskRequestSchema, async (request) => {`,
        `    return { taskId: '1', status: 'completed' };`,
        `});`,
        ''
    ].join('\n');
    const result = applyTransform(input);
    expect(result).toContain("setRequestHandler('tasks/get'");
    expect(result).not.toContain('GetTaskRequestSchema');
});

it('replaces CancelTaskRequestSchema with method string', () => {
    const input = [
        `import { CancelTaskRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
        `client.setRequestHandler(CancelTaskRequestSchema, async (request) => {`,
        `    return {};`,
        `});`,
        ''
    ].join('\n');
    const result = applyTransform(input);
    expect(result).toContain("setRequestHandler('tasks/cancel'");
    expect(result).not.toContain('CancelTaskRequestSchema');
});

it('replaces GetTaskPayloadRequestSchema with method string', () => {
    const input = [
        `import { GetTaskPayloadRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
        `client.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {`,
        `    return { content: [] };`,
        `});`,
        ''
    ].join('\n');
    const result = applyTransform(input);
    expect(result).toContain("setRequestHandler('tasks/result'");
    expect(result).not.toContain('GetTaskPayloadRequestSchema');
});

it('replaces TaskStatusNotificationSchema with method string', () => {
    const input = [
        `import { TaskStatusNotificationSchema } from '@modelcontextprotocol/sdk/types.js';`,
        `client.setNotificationHandler(TaskStatusNotificationSchema, async () => {});`,
        ''
    ].join('\n');
    const result = applyTransform(input);
    expect(result).toContain("setNotificationHandler('notifications/tasks/status'");
    expect(result).not.toContain('TaskStatusNotificationSchema');
});

it('replaces ElicitationCompleteNotificationSchema with method string', () => {
    const input = [
        `import { ElicitationCompleteNotificationSchema } from '@modelcontextprotocol/sdk/types.js';`,
        `client.setNotificationHandler(ElicitationCompleteNotificationSchema, async () => {});`,
        ''
    ].join('\n');
    const result = applyTransform(input);
    expect(result).toContain("setNotificationHandler('notifications/elicitation/complete'");
    expect(result).not.toContain('ElicitationCompleteNotificationSchema');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/handlerRegistration.test.ts`
Expected: 6 new tests FAIL (schemas not in map, get "Custom method handler" diagnostic instead)

- [ ] **Step 3: Add missing schemas to the mapping**

In `packages/codemod/src/migrations/v1-to-v2/mappings/schemaToMethodMap.ts`, add entries to `SCHEMA_TO_METHOD`:

```typescript
ListTasksRequestSchema: 'tasks/list',
GetTaskRequestSchema: 'tasks/get',
GetTaskPayloadRequestSchema: 'tasks/result',
CancelTaskRequestSchema: 'tasks/cancel',
```

And add entries to `NOTIFICATION_SCHEMA_TO_METHOD`:

```typescript
TaskStatusNotificationSchema: 'notifications/tasks/status',
ElicitationCompleteNotificationSchema: 'notifications/elicitation/complete',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/handlerRegistration.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/codemod/src/migrations/v1-to-v2/mappings/schemaToMethodMap.ts packages/codemod/test/v1-to-v2/transforms/handlerRegistration.test.ts
git commit -m "fix(codemod): add task and elicitation schemas to handler registration map"
```

---

### Task 2: Replace schema identifiers in generic property access positions

Currently, when a spec schema like `OAuthTokensSchema` is used with a Zod-specific method (e.g., `.parseAsync()`, `.or()`, `.extend()`), the `specSchemaAccess` transform only emits a diagnostic but does NOT replace the identifier. This leaves the old schema name in imports, which breaks compilation since v2 packages don't export these schema symbols.

**Fix:** In the generic property access case, replace the identifier with `specTypeSchemas.X` (even though the method call itself won't work). The diagnostic still tells the user what to do, but the import now resolves.

**Impact:** Fixes ~12 "Module has no exported member 'XSchema'" errors across both repos.

**Files:**
- Modify: `packages/codemod/src/migrations/v1-to-v2/transforms/specSchemaAccess.ts`
- Test: `packages/codemod/test/v1-to-v2/transforms/specSchemaAccess.test.ts`

- [ ] **Step 1: Write failing tests for generic property access replacement**

Add to `specSchemaAccess.test.ts` in a new `describe` block:

```typescript
describe('auto-transform: generic property access → specTypeSchemas.X', () => {
    it('replaces schema identifier in .parseAsync() call', () => {
        const input = [
            `import { OAuthTokensSchema } from '@modelcontextprotocol/server';`,
            `const tokens = await OAuthTokensSchema.parseAsync(data);`,
            ''
        ].join('\n');
        const { text, result } = applyTransform(input);
        expect(text).toContain('specTypeSchemas.OAuthTokens.parseAsync(data)');
        expect(text).not.toMatch(/import\s*\{[^}]*OAuthTokensSchema[^}]*\}/);
        expect(result.changesCount).toBeGreaterThan(0);
        expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it('replaces schema identifier in .or() call', () => {
        const input = [
            `import { ServerNotificationSchema } from '@modelcontextprotocol/server';`,
            `const union = ServerNotificationSchema.or(otherSchema);`,
            ''
        ].join('\n');
        const { text, result } = applyTransform(input);
        expect(text).toContain('specTypeSchemas.ServerNotification.or(otherSchema)');
        expect(text).not.toMatch(/import\s*\{[^}]*ServerNotificationSchema[^}]*\}/);
        expect(result.changesCount).toBeGreaterThan(0);
    });

    it('replaces schema identifier in .extend() call', () => {
        const input = [
            `import { ToolSchema } from '@modelcontextprotocol/server';`,
            `const extended = ToolSchema.extend({ extra: z.string() });`,
            ''
        ].join('\n');
        const { text, result } = applyTransform(input);
        expect(text).toContain('specTypeSchemas.Tool.extend');
        expect(result.changesCount).toBeGreaterThan(0);
    });

    it('adds specTypeSchemas import for generic property access', () => {
        const input = [
            `import { OAuthTokensSchema } from '@modelcontextprotocol/server';`,
            `const tokens = await OAuthTokensSchema.parseAsync(data);`,
            ''
        ].join('\n');
        const { text } = applyTransform(input);
        expect(text).toMatch(/import.*specTypeSchemas.*from/);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/specSchemaAccess.test.ts`
Expected: 4 new tests FAIL (generic property access only emits diagnostic, doesn't replace)

- [ ] **Step 3: Modify the generic property access handler to also replace the identifier**

In `packages/codemod/src/migrations/v1-to-v2/transforms/specSchemaAccess.ts`, find the generic property access handler in `handleReference()` (around line 129). Change:

```typescript
// BEFORE (diagnostic-only, no replacement):
if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === ref) {
    diagnostics.push(
        warning(
            sourceFile.getFilePath(),
            ref.getStartLineNumber(),
            `${localName} is not exported in v2. Use \`specTypeSchemas.${typeName}\` (typed as StandardSchemaV1) or \`isSpecType.${typeName}\` for validation.`
        )
    );
    return false;
}
```

to:

```typescript
// AFTER (replace identifier AND emit diagnostic):
if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === ref) {
    const line = ref.getStartLineNumber();
    ref.replaceWithText(`specTypeSchemas.${typeName}`);
    ensureImport(sourceFile, 'specTypeSchemas');
    diagnostics.push(
        warning(
            sourceFile.getFilePath(),
            line,
            `Replaced ${localName} with specTypeSchemas.${typeName}. Note: typed as StandardSchemaV1, not ZodType — Zod methods like .safeParse()/.parse()/.parseAsync() are not available. Manual rewrite required.`
        )
    );
    return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/specSchemaAccess.test.ts`
Expected: All tests PASS (including existing "keeps original schema import when some refs are diagnostic-only" test — verify this one still passes since the behavior changed)

**Note:** The existing test at line 262 ("keeps original schema import when some refs are diagnostic-only") combines a `.safeParse().success` auto-transform with a `.parse()` diagnostic-only case. The `.parse()` case is separate from the generic property access case (it has its own handler returning `false`). This test should still pass because `.parse()` is handled before the generic property access check.

- [ ] **Step 5: Commit**

```bash
git add packages/codemod/src/migrations/v1-to-v2/transforms/specSchemaAccess.ts packages/codemod/test/v1-to-v2/transforms/specSchemaAccess.test.ts
git commit -m "fix(codemod): replace schema identifiers in generic property access positions"
```

---

### Task 3: Fix safeParse-to-validate `.error` sub-property remapping

When `const r = XSchema.safeParse(v)` is captured, the transform rewrites `.error` → `.issues`. But downstream accesses like `r.error.message` become `r.issues.message` (wrong — `.issues` is an array) and `r.error.issues` becomes `r.issues.issues` (double nesting).

**Fix:** In the `case 'error':` block of `rewriteCapturedSafeParse`, check if the parent node is another PropertyAccessExpression (meaning `r.error.X`). Handle `.issues` (unwrap) and `.message` (rewrite to array map) specifically.

**Impact:** Fixes ~10 TypeScript errors in inspector/client's `AppRenderer.tsx`, `SamplingRequest.tsx`, `ToolResults.tsx`.

**Files:**
- Modify: `packages/codemod/src/migrations/v1-to-v2/transforms/specSchemaAccess.ts`
- Test: `packages/codemod/test/v1-to-v2/transforms/specSchemaAccess.test.ts`

- [ ] **Step 1: Write failing tests for error sub-property remapping**

Add to `specSchemaAccess.test.ts` inside the "auto-transform: captured safeParse result" describe block:

```typescript
it('rewrites .error.issues to .issues (unwrap double nesting)', () => {
    const input = [
        `import { CallToolResultSchema } from '@modelcontextprotocol/server';`,
        `const parsed = CallToolResultSchema.safeParse(data);`,
        `if (!parsed.success) { console.log(parsed.error.issues); }`,
        ''
    ].join('\n');
    const { text } = applyTransform(input);
    expect(text).toContain('parsed.issues');
    expect(text).not.toContain('parsed.issues.issues');
    expect(text).not.toContain('parsed.error');
});

it('rewrites .error.message to issues map expression', () => {
    const input = [
        `import { CallToolResultSchema } from '@modelcontextprotocol/server';`,
        `const parsed = CallToolResultSchema.safeParse(data);`,
        `if (!parsed.success) { console.log(parsed.error.message); }`,
        ''
    ].join('\n');
    const { text } = applyTransform(input);
    expect(text).not.toContain('parsed.error');
    expect(text).not.toContain('parsed.issues.message');
    expect(text).toContain("parsed.issues?.map(i => i.message).join(', ')");
});

it('rewrites bare .error to .issues (unchanged behavior)', () => {
    const input = [
        `import { ToolSchema } from '@modelcontextprotocol/server';`,
        `const result = ToolSchema.safeParse(raw);`,
        `if (!result.success) { console.log(result.error); }`,
        ''
    ].join('\n');
    const { text } = applyTransform(input);
    expect(text).toContain('result.issues');
    expect(text).not.toContain('result.error');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/specSchemaAccess.test.ts`
Expected: First 2 new tests FAIL (`.error.issues` becomes `.issues.issues`, `.error.message` becomes `.issues.message`). Third test should already pass.

- [ ] **Step 3: Update the error case in rewriteCapturedSafeParse**

In `packages/codemod/src/migrations/v1-to-v2/transforms/specSchemaAccess.ts`, in the `rewriteCapturedSafeParse` function, replace the `case 'error'` block (around line 293):

```typescript
// BEFORE:
case 'error': {
    replacements.push({ node, newText: `${varName}.issues` });
    break;
}
```

with:

```typescript
// AFTER:
case 'error': {
    const errorParent = node.getParent();
    if (errorParent && Node.isPropertyAccessExpression(errorParent) && errorParent.getExpression() === node) {
        const subProp = errorParent.getName();
        if (subProp === 'issues') {
            replacements.push({ node: errorParent, newText: `${varName}.issues` });
        } else if (subProp === 'message') {
            replacements.push({ node: errorParent, newText: `${varName}.issues?.map(i => i.message).join(', ')` });
        } else {
            replacements.push({ node: errorParent, newText: `${varName}.issues` });
        }
    } else {
        replacements.push({ node, newText: `${varName}.issues` });
    }
    break;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/specSchemaAccess.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/codemod/src/migrations/v1-to-v2/transforms/specSchemaAccess.ts packages/codemod/test/v1-to-v2/transforms/specSchemaAccess.test.ts
git commit -m "fix(codemod): handle .error sub-property accesses in safeParse rewrite"
```

---

### Task 4: Handle `zod-compat.js` import path

The import path `@modelcontextprotocol/sdk/server/zod-compat.js` is not in `IMPORT_MAP`, so `importPaths` emits "Unknown SDK import path" and leaves it untouched. The file exported `AnySchema` and `SchemaOutput` types that don't exist in v2.

**Fix:** Add the path to `IMPORT_MAP` as `removed` with a descriptive message. This removes the import and emits a clear diagnostic.

**Impact:** Fixes "Unknown SDK import path" warnings in inspector/client (4 files). The `AnySchema`/`SchemaOutput` usages in function signatures will still need manual migration, but the import won't be stale.

**Files:**
- Modify: `packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts`
- Test: `packages/codemod/test/v1-to-v2/transforms/importPaths.test.ts`

- [ ] **Step 1: Write failing test for zod-compat import removal**

Add to `importPaths.test.ts`:

```typescript
it('removes zod-compat.js import and emits diagnostic', () => {
    const input = [
        `import { AnySchema, SchemaOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js';`,
        `function validate<T extends AnySchema>(schema: T): SchemaOutput<T> { return {} as any; }`,
        ''
    ].join('\n');
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', input);
    const result = importPathsTransform.apply(sourceFile, ctx);
    const text = sourceFile.getFullText();
    expect(text).not.toContain('zod-compat');
    expect(text).not.toContain("from '@modelcontextprotocol/sdk");
    expect(result.changesCount).toBeGreaterThan(0);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]!.message).toContain('zod-compat');
});
```

Ensure the test file imports the necessary pieces — check the existing test imports at the top and match them. The existing test file should already import `importPathsTransform`, `Project`, and define a `ctx` constant.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/importPaths.test.ts`
Expected: FAIL — import is left unchanged, "Unknown SDK import path" warning emitted

- [ ] **Step 3: Add zod-compat.js to the import map**

In `packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts`, add this entry to `IMPORT_MAP` after the `'@modelcontextprotocol/sdk/server/middleware.js'` entry:

```typescript
'@modelcontextprotocol/sdk/server/zod-compat.js': {
    target: '',
    status: 'removed',
    removalMessage:
        'zod-compat removed in v2. AnySchema and SchemaOutput types have no v2 equivalent — v2 uses StandardSchemaV1 from @standard-schema/spec. Rewrite generic function signatures to use StandardSchemaV1 directly.'
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/importPaths.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts packages/codemod/test/v1-to-v2/transforms/importPaths.test.ts
git commit -m "fix(codemod): handle zod-compat.js import path as removed"
```

---

### Task 5: Rename `ResourceTemplate` type imports to `ResourceTemplateType`

When `ResourceTemplate` is imported from `@modelcontextprotocol/sdk/types.js` (protocol type usage), the import is rewritten to `@modelcontextprotocol/server`. But the server exports a `ResourceTemplate` **class** (used for server-side registration), shadowing the protocol type. The protocol type already exists in v2 as `ResourceTemplateType` (defined in `core/src/types/types.ts`, publicly exported via `core/public`'s `export * from '../../types/types.js'`, and re-exported by both `@modelcontextprotocol/server` and `@modelcontextprotocol/client`).

**Fix:** Add `ResourceTemplate` → `ResourceTemplateType` to the `renamedSymbols` mapping for the `types.js` import path. This auto-renames the import and all references. No SDK changes needed — `ResourceTemplateType` is already publicly exported.

**Impact:** Fixes ~8 TypeScript errors in inspector/client `ResourcesTab.tsx` (`.name`, `.description`, `UriTemplate` vs `string` issues).

**Files:**
- Modify: `packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts`
- Test: `packages/codemod/test/v1-to-v2/transforms/importPaths.test.ts`

- [ ] **Step 1: Write failing test for ResourceTemplate rename**

Add to `importPaths.test.ts`:

```typescript
it('renames ResourceTemplate to ResourceTemplateType when imported from types.js', () => {
    const input = [
        `import { ResourceTemplate } from '@modelcontextprotocol/sdk/types.js';`,
        `const template: ResourceTemplate = getTemplate();`,
        ''
    ].join('\n');
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', input);
    const result = importPathsTransform.apply(sourceFile, ctx);
    const text = sourceFile.getFullText();
    expect(text).toContain('ResourceTemplateType');
    expect(text).not.toMatch(/\bResourceTemplate\b(?!Type)/);
    expect(result.changesCount).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/importPaths.test.ts`
Expected: FAIL — ResourceTemplate is not renamed

- [ ] **Step 3: Add ResourceTemplate rename to import map**

In `packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts`, find the entry for `'@modelcontextprotocol/sdk/types.js'`:

```typescript
'@modelcontextprotocol/sdk/types.js': {
    target: 'RESOLVE_BY_CONTEXT',
    status: 'moved'
},
```

Add `renamedSymbols`:

```typescript
'@modelcontextprotocol/sdk/types.js': {
    target: 'RESOLVE_BY_CONTEXT',
    status: 'moved',
    renamedSymbols: {
        ResourceTemplate: 'ResourceTemplateType'
    }
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @modelcontextprotocol/codemod test -- test/v1-to-v2/transforms/importPaths.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run full test suite**

Run: `pnpm --filter @modelcontextprotocol/codemod test`
Expected: All tests PASS across all test files

- [ ] **Step 6: Commit**

```bash
git add packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts packages/codemod/test/v1-to-v2/transforms/importPaths.test.ts
git commit -m "fix(codemod): rename ResourceTemplate to ResourceTemplateType to avoid class collision"
```

---

## Verification

After all 5 tasks are complete:

- [ ] **Rebuild and re-run batch test**

```bash
pnpm --filter @modelcontextprotocol/codemod build
pnpm --filter @modelcontextprotocol/codemod batch-test
```

Compare `packages/codemod/batch-test/results/summary.json` with the pre-fix results. Expected improvements:
- inspector/client: build errors should decrease significantly (StandardSchemaV1→AnySchema errors from handler registration fixed, schema import errors fixed)
- inspector/server: `SSEServerTransport` errors remain (manual migration), but `setRequestHandler` task schema errors should be fixed
- mcp-servers-fork: `SSEServerTransport` errors remain (manual migration), test context mock errors remain (manual migration)
