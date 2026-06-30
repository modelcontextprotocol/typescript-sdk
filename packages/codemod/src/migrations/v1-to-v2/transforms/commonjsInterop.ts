import type { Block, ExportDeclaration, Identifier, ImportDeclaration, ImportSpecifier, SourceFile } from 'ts-morph';
import { Node } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types';
import { isKeyPositionIdentifier } from '../../../utils/astUtils';
import { actionRequired, warning } from '../../../utils/diagnostics';

const V2_PACKAGE_ROOTS = new Set([
    '@modelcontextprotocol/client',
    '@modelcontextprotocol/server',
    '@modelcontextprotocol/core',
    '@modelcontextprotocol/server-legacy',
    '@modelcontextprotocol/node',
    '@modelcontextprotocol/express'
]);

/** A v2 package root or any `/subpath` of one (e.g. `@modelcontextprotocol/server/stdio`). */
export function isV2Specifier(specifier: string): boolean {
    if (V2_PACKAGE_ROOTS.has(specifier)) return true;
    const secondSlash = specifier.indexOf('/', specifier.indexOf('/') + 1);
    return secondSlash !== -1 && V2_PACKAGE_ROOTS.has(specifier.slice(0, secondSlash));
}

export interface V2ValueImport {
    decl: ImportDeclaration;
    specifier: string;
    named: ImportSpecifier[]; // value (non-type-only) named specifiers
    namespace?: Identifier; // `import * as ns`
    defaultImport?: Identifier; // `import d from`
}

/**
 * v2 imports with at least one VALUE-referenced binding (these break under CommonJS).
 *
 * The transform keys off value USAGE, not import syntax. A binding declared with a plain `import { X }`
 * but used only in type position (`: X` / `as X`) has zero value references, so TypeScript erases it at
 * emit time — the static import never produces a runtime `require`, so it is harmless and must be left
 * intact. Including such a binding here would wrongly remove its static import and orphan the surviving
 * type annotations (TS2304). So a binding is collected only when `findValueRefs` finds ≥1 value reference;
 * a whole `import type { … }` (and any inline `type X` specifier) is skipped as before. (`findValueRefs`
 * is a hoisted function declaration below, so it is safe to call here.)
 */
export function collectV2ValueImports(sourceFile: SourceFile): V2ValueImport[] {
    const out: V2ValueImport[] = [];
    for (const decl of sourceFile.getImportDeclarations()) {
        const specifier = decl.getModuleSpecifierValue();
        if (!isV2Specifier(specifier)) continue;
        if (decl.isTypeOnly()) continue; // whole `import type { … }` — erased, harmless
        const named = decl
            .getNamedImports()
            .filter(n => !n.isTypeOnly() && findValueRefs(sourceFile, n.getAliasNode()?.getText() ?? n.getName()).length > 0);
        const namespaceBinding = decl.getNamespaceImport();
        const namespace =
            namespaceBinding && findValueRefs(sourceFile, namespaceBinding.getText()).length > 0 ? namespaceBinding : undefined;
        const defaultBinding = decl.getDefaultImport();
        const defaultImport = defaultBinding && findValueRefs(sourceFile, defaultBinding.getText()).length > 0 ? defaultBinding : undefined;
        if (named.length === 0 && !namespace && !defaultImport) continue;
        out.push({ decl, specifier, named, namespace, defaultImport });
    }
    return out;
}

/** v2 re-exports that carry a runtime VALUE (named non-type exports, or a star re-export). These break
 *  under CommonJS and can't be made dynamic, so they are diagnosed (never converted). */
export function collectV2ValueReExports(sourceFile: SourceFile): ExportDeclaration[] {
    return sourceFile.getExportDeclarations().filter(exp => {
        const specifier = exp.getModuleSpecifierValue();
        if (!specifier || !isV2Specifier(specifier)) return false;
        if (exp.isTypeOnly()) return false;
        const named = exp.getNamedExports();
        if (named.length === 0) return true; // `export * from "<v2>"`
        return named.some(n => !n.isTypeOnly());
    });
}

/** Local binding names a v2 value import introduces (aliases preferred). */
export function localBindings(imp: V2ValueImport): string[] {
    const names: string[] = [];
    if (imp.namespace) names.push(imp.namespace.getText());
    if (imp.defaultImport) names.push(imp.defaultImport.getText());
    for (const n of imp.named) names.push(n.getAliasNode()?.getText() ?? n.getName());
    return names;
}

/**
 * Conservative type-position test: returns true ONLY when the identifier is clearly part of a type
 * (a type reference / type query target). Anything uncertain is treated as a VALUE usage, which biases
 * toward diagnosing rather than wrongly converting a sync usage.
 */
export function isTypePositionReference(node: Node): boolean {
    let current: Node | undefined = node;
    // Walk up through dotted type names (`ns.Foo` in type position is a QualifiedName).
    while (current) {
        const parent: Node | undefined = current.getParent();
        if (!parent) return false;
        if (Node.isTypeReference(parent) || Node.isTypeQuery(parent) || Node.isImportTypeNode(parent)) {
            return true;
        }
        if (Node.isQualifiedName(parent)) {
            current = parent;
            continue;
        }
        return false;
    }
    return false;
}

/** In-file value references to `localName` (excludes the import binding itself, property keys, and type positions). */
export function findValueRefs(sourceFile: SourceFile, localName: string): Node[] {
    const refs: Node[] = [];
    sourceFile.forEachDescendant(node => {
        if (!Node.isIdentifier(node) || node.getText() !== localName) return;
        const parent = node.getParent();
        if (!parent) return;
        if (Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isNamespaceImport(parent)) return;
        if (isKeyPositionIdentifier(node)) return;
        if (isTypePositionReference(node)) return;
        refs.push(node);
    });
    return refs;
}

/**
 * True iff `localName` appears in at least one TYPE position (a `: localName` / `as localName` / `<localName>`
 * reference), excluding the import binding itself and property keys. A binding referenced as BOTH a value and
 * a type cannot be converted: removing its static import (to load the value dynamically) would orphan the
 * surviving type usage (TS2304). Such a binding is diagnosed rather than converted — see `analyzeConvertibility`.
 */
export function hasTypeReference(sourceFile: SourceFile, localName: string): boolean {
    let found = false;
    sourceFile.forEachDescendant(node => {
        if (found) return;
        if (!Node.isIdentifier(node) || node.getText() !== localName) return;
        const parent = node.getParent();
        if (!parent) return;
        if (Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isNamespaceImport(parent)) return;
        if (isKeyPositionIdentifier(node)) return;
        if (isTypePositionReference(node)) found = true;
    });
    return found;
}

/**
 * True iff the nearest enclosing function-like is an async function/method/arrow WITH A BLOCK BODY
 * (await-capable AND able to host a `const { … } = await …;` statement). An expression-bodied async
 * arrow (`async () => expr`) returns false → the file is diagnosed rather than mis-converted into code
 * that references an unbound symbol.
 */
export function isAwaitSafe(node: Node): boolean {
    const fn = node.getFirstAncestor(
        a =>
            Node.isFunctionDeclaration(a) ||
            Node.isFunctionExpression(a) ||
            Node.isArrowFunction(a) ||
            Node.isMethodDeclaration(a) ||
            Node.isConstructorDeclaration(a) ||
            Node.isGetAccessorDeclaration(a) ||
            Node.isSetAccessorDeclaration(a)
    );
    if (!fn) return false; // module top-level
    if (Node.isConstructorDeclaration(fn) || Node.isGetAccessorDeclaration(fn) || Node.isSetAccessorDeclaration(fn)) {
        return false; // never async-capable
    }
    if (!fn.isAsync()) return false;
    const body = fn.getBody();
    if (!body || !Node.isBlock(body)) return false; // expression-bodied async arrow -> not hostable -> diagnose
    // The body is async/block-hostable, but the ref must also sit INSIDE it: parameter defaults and other
    // signature positions evaluate in parameter scope (outside the body block) and can't see a body-level
    // `const { … } = await …;`, so a ref there is not await-safe -> diagnose rather than emit unbound code.
    return node.getStart() >= body.getStart() && node.getEnd() <= body.getEnd();
}

export interface Convertibility {
    convertible: boolean;
    // A blocker's root cause selects its diagnostic message:
    // - `isDefaultImport`: a default import (no v2 default export, and no dynamic-destructure form).
    // - `isValueAndType`: a named binding referenced as both a value and a type (converting would orphan the type usage).
    // - neither: a value used in a synchronous context that cannot await a dynamic import.
    blockers: Array<{ symbol: string; line: number; decl: ImportDeclaration; isDefaultImport?: boolean; isValueAndType?: boolean }>;
}

export function analyzeConvertibility(sourceFile: SourceFile, v2ValueImports: V2ValueImport[]): Convertibility {
    const blockers: Convertibility['blockers'] = [];
    for (const imp of v2ValueImports) {
        // Default imports have no dynamic-destructure form (and v2 ships no default exports) -> always diagnose.
        if (imp.defaultImport) {
            blockers.push({
                symbol: imp.defaultImport.getText(),
                line: imp.decl.getStartLineNumber(),
                decl: imp.decl,
                isDefaultImport: true
            });
            continue;
        }
        // Sync-context blockers first: when a binding is BOTH used in a sync context and used as a type,
        // both reasons target the same import declaration and the diagnostic dedups per declaration. The
        // sync usage is the more fundamental blocker (it cannot await even after migrating the type usage),
        // so it is recorded first and wins.
        for (const local of localBindings(imp)) {
            for (const ref of findValueRefs(sourceFile, local)) {
                if (!isAwaitSafe(ref)) {
                    blockers.push({ symbol: local, line: ref.getStartLineNumber(), decl: imp.decl });
                }
            }
        }
        // A named binding referenced as both a value and a type cannot be converted: removing its static
        // import to load the value dynamically would orphan the surviving `: name` / `as name` type usage
        // (TS2304). Diagnose rather than convert (the conservative, type-safe choice — we do not auto-split
        // the value and type usages into a retained `import type` in this pass).
        for (const n of imp.named) {
            const local = n.getAliasNode()?.getText() ?? n.getName();
            if (hasTypeReference(sourceFile, local)) {
                blockers.push({ symbol: local, line: imp.decl.getStartLineNumber(), decl: imp.decl, isValueAndType: true });
            }
        }
    }
    return { convertible: blockers.length === 0, blockers };
}

const HELPER_ID = '_mcpDynImport';
const HELPER_DECL =
    '// eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval\n' +
    `const ${HELPER_ID} = new Function("s", "return import(s)") as <T>(s: string) => Promise<T>;`;

/** Camel-cased tail of a v2 specifier (e.g. `@modelcontextprotocol/server/stdio` -> `serverStdio`). */
function packageCamel(specifier: string): string {
    return specifier
        .replace(/^@modelcontextprotocol\//, '')
        .split(/[/-]/)
        .filter(Boolean)
        .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
        .join('');
}

/** Suffix `base` with `_2`, `_3`, … until it is free in `taken`, then reserve and return it. */
function reserveUniqueId(base: string, taken: Set<string>): string {
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}_${n++}`;
    taken.add(id);
    return id;
}

/** Stable, collision-free identifier for a package's module promise (e.g. `/server/stdio` -> `_mcpServerStdio`). */
export function packagePromiseId(specifier: string, taken: Set<string>): string {
    const camel = packageCamel(specifier);
    return reserveUniqueId(`_mcp${camel.charAt(0).toUpperCase()}${camel.slice(1)}`, taken);
}

/**
 * Stable, collision-free identifier for a package's type-only namespace import
 * (e.g. `/server/stdio` -> `_McpServerStdioTypes`), parallel to {@link packagePromiseId}.
 *
 * The `import type * as <id> from "<pkg>"` declaration this names keeps `<pkg>` present as a real import
 * DECLARATION — the runner derives each manifest's v2 deps from the post-transform import declarations, so the
 * converted package stays in the migrated package.json — while being fully erased at runtime (a type-only import
 * never emits a CommonJS `require`, so it does not re-break the ESM-only load).
 */
export function packageTypeId(specifier: string, taken: Set<string>): string {
    const camel = packageCamel(specifier);
    return reserveUniqueId(`_Mcp${camel.charAt(0).toUpperCase()}${camel.slice(1)}Types`, taken);
}

/** Named bindings a v2 value import contributes, as `{ local, imported }`. */
function namedBindings(imp: V2ValueImport): Array<{ local: string; imported: string }> {
    return imp.named.map(n => ({ local: n.getAliasNode()?.getText() ?? n.getName(), imported: n.getName() }));
}

/**
 * The nearest enclosing async-hostable function BLOCK body for a value ref, or undefined. Only
 * function/method/arrow/function-expression bodies qualify (where a `const { … } = await …;` can live);
 * constructors and accessors are intentionally excluded — files using a value there are diagnosed as
 * non-convertible upstream, so they never reach this rewrite.
 */
function enclosingFnBlock(ref: Node): Block | undefined {
    const fn = ref.getFirstAncestor(
        a => Node.isFunctionDeclaration(a) || Node.isFunctionExpression(a) || Node.isArrowFunction(a) || Node.isMethodDeclaration(a)
    );
    const body = fn?.getBody();
    return body && Node.isBlock(body) ? body : undefined;
}

export function convertFile(sourceFile: SourceFile, v2ValueImports: V2ValueImport[]): number {
    let changes = 0;

    // Reserve identifiers already present so generated ids never collide.
    const taken = new Set<string>();
    sourceFile.forEachDescendant(node => {
        if (Node.isIdentifier(node)) taken.add(node.getText());
    });
    taken.add(HELPER_ID);

    // One promise id + one type-binding id per distinct specifier. Both are reserved against `taken` so
    // they never collide with existing identifiers nor with each other.
    const promiseIdBySpecifier = new Map<string, string>();
    const typeIdBySpecifier = new Map<string, string>();
    for (const imp of v2ValueImports) {
        if (promiseIdBySpecifier.has(imp.specifier)) continue;
        promiseIdBySpecifier.set(imp.specifier, packagePromiseId(imp.specifier, taken));
        typeIdBySpecifier.set(imp.specifier, packageTypeId(imp.specifier, taken));
    }

    // Insert destructures into each async function that uses a package's bindings.
    for (const imp of v2ValueImports) {
        const promiseId = promiseIdBySpecifier.get(imp.specifier)!;
        // Map: async-function body Block -> set of destructure entries to inject.
        const perFn = new Map<Block, Set<string>>();

        if (imp.namespace) {
            const ns = imp.namespace.getText();
            // Whole-namespace binding: `const ns = await _pkg;`
            for (const ref of findValueRefs(sourceFile, ns)) {
                const body = enclosingFnBlock(ref);
                if (!body) continue;
                if (!perFn.has(body)) perFn.set(body, new Set());
                perFn.get(body)!.add(`__NS__${ns}`);
            }
        }
        for (const { local, imported } of namedBindings(imp)) {
            const entry = local === imported ? local : `${imported}: ${local}`;
            for (const ref of findValueRefs(sourceFile, local)) {
                const body = enclosingFnBlock(ref);
                if (!body) continue;
                if (!perFn.has(body)) perFn.set(body, new Set());
                perFn.get(body)!.add(entry);
            }
        }

        for (const [body, entries] of perFn) {
            const nsEntry = [...entries].find(e => e.startsWith('__NS__'));
            const namedEntries = [...entries].filter(e => !e.startsWith('__NS__'));
            const statements: string[] = [];
            if (namedEntries.length > 0) {
                statements.push(`const { ${namedEntries.toSorted().join(', ')} } = await ${promiseId};`);
            }
            if (nsEntry) {
                statements.push(`const ${nsEntry.slice('__NS__'.length)} = await ${promiseId};`);
            }
            body.insertStatements(0, statements);
            changes += statements.length;
        }
    }

    // A type-only namespace import per package keeps the specifier present as a real import DECLARATION
    // (the runner derives each manifest's v2 deps from getImportDeclarations(), so the converted package stays
    // in the migrated package.json), while erasing at runtime — `import type` never emits a CommonJS `require`.
    // The promise's `typeof` then references this binding instead of an inline `typeof import("…")`, which the
    // runner's dependency detection does not recognize.
    for (const [spec, typeId] of typeIdBySpecifier) {
        sourceFile.addImportDeclaration({ isTypeOnly: true, namespaceImport: typeId, moduleSpecifier: spec });
        changes++;
    }

    // Insert the helper + per-package promises after the last import declaration, then remove static value imports.
    const imports = sourceFile.getImportDeclarations();
    const insertAt = imports.length > 0 ? imports.at(-1)!.getChildIndex() + 1 : 0;
    const promiseDecls = [...promiseIdBySpecifier.entries()].map(
        ([spec, id]) => `const ${id} = ${HELPER_ID}<typeof ${typeIdBySpecifier.get(spec)!}>("${spec}");`
    );
    sourceFile.insertStatements(insertAt, [HELPER_DECL, ...promiseDecls]);
    changes += 1 + promiseDecls.length;

    // Remove the static value imports we converted; keep any type-only named siblings.
    // (Default imports never reach convertFile — analyzeConvertibility diagnoses them as non-convertible.)
    for (const imp of v2ValueImports) {
        if (imp.namespace) {
            imp.decl.remove(); // `import * as ns` is a standalone declaration
            changes++;
            continue;
        }
        for (const n of imp.named) n.remove();
        const decl = imp.decl;
        if (decl.getNamedImports().length === 0 && !decl.getDefaultImport() && !decl.getNamespaceImport()) {
            decl.remove(); // nothing (incl. type-only siblings) left
        }
        changes++;
    }

    return changes;
}

export const commonjsInteropTransform: Transform = {
    name: 'CommonJS interop for ESM-only v2',
    id: 'commonjs-interop',
    apply(sourceFile: SourceFile, context: TransformContext): TransformResult {
        const diagnostics: Diagnostic[] = [];
        if (context.moduleSystem === 'esm') return { changesCount: 0, diagnostics };

        const v2ValueImports = collectV2ValueImports(sourceFile);
        const v2ValueReExports = collectV2ValueReExports(sourceFile);
        if (v2ValueImports.length === 0 && v2ValueReExports.length === 0) {
            return { changesCount: 0, diagnostics };
        }

        const firstLine = v2ValueImports[0]?.decl.getStartLineNumber() ?? v2ValueReExports[0]!.getStartLineNumber();

        if (context.moduleSystem === 'unknown') {
            // Don't auto-rewrite a project we can't classify; flag once per file.
            diagnostics.push(
                warning(
                    sourceFile.getFilePath(),
                    firstLine,
                    'Could not determine this project’s module system. If it is CommonJS, these v2 value imports/exports ' +
                        'are ESM-only and will fail at load. See docs/migration/upgrade-to-v2.md.'
                )
            );
            return { changesCount: 0, diagnostics };
        }

        // Value re-exports can never be made dynamic -> always diagnose, and they force the whole file
        // non-convertible (a surviving static re-export re-breaks the load).
        for (const exp of v2ValueReExports) {
            diagnostics.push(
                actionRequired(
                    sourceFile.getFilePath(),
                    exp,
                    `Re-export of ${exp.getModuleSpecifierValue()} carries a runtime value, but that package is ESM-only and ` +
                        `this project is CommonJS, so this re-export fails at load. A re-export cannot be made dynamic — migrate ` +
                        `the project to ESM, or replace it with a wrapper that loads the value via dynamic import() inside an async ` +
                        `function. See docs/migration/upgrade-to-v2.md.`
                )
            );
        }

        const verdict = analyzeConvertibility(sourceFile, v2ValueImports);
        if (v2ValueReExports.length > 0 || !verdict.convertible) {
            const seen = new Set<ImportDeclaration>();
            for (const b of verdict.blockers) {
                if (seen.has(b.decl)) continue;
                seen.add(b.decl);
                const message = b.isDefaultImport
                    ? `"${b.symbol}" is a default import, but v2 packages have no default export and a default import cannot ` +
                      `be converted to a dynamic import. Migrate the project to ESM, or use the named/namespace import form. ` +
                      `See docs/migration/upgrade-to-v2.md.`
                    : b.isValueAndType
                      ? `"${b.symbol}" is used as both a value and a type; converting ${b.decl.getModuleSpecifierValue()} to a ` +
                        `dynamic import would remove the static import and orphan the type-position usage (TS2304). Migrate the ` +
                        `project to ESM, or split the usages — keep the type via a separate "import type" and load the value via ` +
                        `dynamic import() inside an async function. See docs/migration/upgrade-to-v2.md.`
                      : `${b.decl.getModuleSpecifierValue()} is ESM-only and this project is CommonJS, so this static import ` +
                        `fails at load (ERR_PACKAGE_PATH_NOT_EXPORTED). "${b.symbol}" is used in a synchronous context ` +
                        `(line ${b.line}) that cannot await a dynamic import. Restructure so the value loads inside an async ` +
                        `function (then re-run to auto-convert), or migrate the project to ESM. See docs/migration/upgrade-to-v2.md.`;
                diagnostics.push(actionRequired(sourceFile.getFilePath(), b.decl, message));
            }
            return { changesCount: 0, diagnostics };
        }

        // Convertible (value imports only, all await-safe).
        const changesCount = convertFile(sourceFile, v2ValueImports);
        return { changesCount, diagnostics };
    }
};
