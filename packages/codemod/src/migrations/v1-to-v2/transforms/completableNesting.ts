import type { CallExpression, Expression, PropertyAccessExpression, SourceFile } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types';
import { actionRequired, info, warning } from '../../../utils/diagnostics';
import { isAnyMcpSpecifier } from '../../../utils/importUtils';

/**
 * v2 resolves completion metadata on the schema found AFTER unwrapping an outer
 * optional wrapper, so the v1 idiom `completable(z.string().optional(), cb)` registers
 * the metadata one level too deep: completions come back empty and, when no argument
 * carries metadata in the v2 position, the server does not advertise the completions
 * capability. The working v2 spelling inverts the nesting:
 * `completable(z.string(), cb).optional()`.
 *
 * Only `optional` wrappers matter — the v2 lookup unwraps exactly one outer optional
 * layer and nothing else, so `.default()` / `.nullable()` / `.catch()` arguments keep
 * working as-is and are left alone. `.nullish()` is the one non-`optional` tail whose
 * outer layer IS an optional wrapper, so it gets a marker with the concrete rewrite.
 */

type ArgVerdict =
    | { kind: 'invert'; innerSchemaText: string }
    | { kind: 'nullish' }
    | { kind: 'buried-optional' }
    | { kind: 'plain-call' }
    | { kind: 'opaque' };

function unparenthesize(expr: Expression): Expression {
    let current = expr;
    while (true) {
        const paren = current.asKind(SyntaxKind.ParenthesizedExpression);
        if (!paren) return current;
        current = paren.getExpression();
    }
}

/**
 * Classify the first argument of a completable() call.
 *
 * - `invert`: outermost wrapper is `optional` and the rewrite is mechanical.
 * - `nullish`: outermost wrapper is `.nullish()` (its outer layer is an optional
 *   wrapper) — marker with the concrete manual rewrite.
 * - `buried-optional`: an `optional`/`nullish` link sits deeper in the method chain
 *   (e.g. `.optional().describe(...)`) — marker; the safe spot for the wrapper
 *   depends on the chain.
 * - `plain-call`: a call chain with no optional wrapper anywhere — leave alone.
 * - `opaque`: not a call (identifier, property access, …) — the schema may be
 *   optional-wrapped where it is defined; one nudge per file.
 */
function classifyArg(arg: Expression): ArgVerdict {
    const outer = unparenthesize(arg).asKind(SyntaxKind.CallExpression);
    if (!outer) return { kind: 'opaque' };

    const callee = outer.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
    if (callee) {
        const name = callee.getName();
        const args = outer.getArguments();
        if (name === 'optional') {
            if (args.length === 0) return { kind: 'invert', innerSchemaText: callee.getExpression().getText() };
            if (args.length === 1) return { kind: 'invert', innerSchemaText: args[0]!.getText() };
            return { kind: 'buried-optional' };
        }
        if (name === 'nullish') return { kind: 'nullish' };
    }

    // Walk the rest of the chain (and factory-call arguments) looking for a buried
    // optional/nullish link, e.g. `z.string().optional().describe('x')` or
    // `z.optional(z.string()).meta({...})`.
    let current: Expression | undefined = unparenthesize(arg);
    while (current) {
        const call: CallExpression | undefined = current.asKind(SyntaxKind.CallExpression);
        if (!call) break;
        const pa: PropertyAccessExpression | undefined = call.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
        if (!pa) break;
        const name = pa.getName();
        if (name === 'optional' || name === 'nullish') return { kind: 'buried-optional' };
        current = pa.getExpression();
    }
    return { kind: 'plain-call' };
}

export const completableNestingTransform: Transform = {
    name: 'Completable optional-nesting inversion',
    id: 'completable-nesting',
    apply(sourceFile: SourceFile, _context: TransformContext): TransformResult {
        const diagnostics: Diagnostic[] = [];
        let changesCount = 0;
        const filePath = sourceFile.getFilePath();

        // Local bindings of `completable` from an MCP package (named import, possibly
        // aliased) and MCP namespace bindings (`ns.completable(...)`). importPaths runs
        // earlier, so the specifier is normally the v2 package already; the v1 specifier
        // is accepted too so the transform also works in isolation.
        const localNames = new Set<string>();
        const namespaceNames = new Set<string>();
        for (const imp of sourceFile.getImportDeclarations()) {
            if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
            for (const ni of imp.getNamedImports()) {
                if (ni.getName() === 'completable') localNames.add(ni.getAliasNode()?.getText() ?? 'completable');
            }
            const ns = imp.getNamespaceImport();
            if (ns) namespaceNames.add(ns.getText());
        }
        if (localNames.size === 0 && namespaceNames.size === 0) {
            return { changesCount: 0, diagnostics: [] };
        }

        const completableCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call: CallExpression) => {
            const expr = call.getExpression();
            if (expr.getKind() === SyntaxKind.Identifier) return localNames.has(expr.getText());
            const pa = expr.asKind(SyntaxKind.PropertyAccessExpression);
            return pa !== undefined && pa.getName() === 'completable' && namespaceNames.has(pa.getExpression().getText());
        });

        let opaqueArgNoted = false;
        // Reverse document order so each replacement leaves the still-unprocessed
        // (earlier) nodes' positions intact.
        for (const call of completableCalls.toReversed()) {
            const args = call.getArguments();
            if (args.length === 0) continue;
            const verdict = classifyArg(args[0]! as Expression);
            switch (verdict.kind) {
                case 'invert': {
                    const line = call.getStartLineNumber();
                    const calleeText = call.getExpression().getText();
                    const restArgs = args.slice(1).map(a => a.getText());
                    call.replaceWithText(`${calleeText}(${[verdict.innerSchemaText, ...restArgs].join(', ')}).optional()`);
                    changesCount++;
                    diagnostics.push(
                        info(
                            filePath,
                            line,
                            `completable() with an optional schema argument: moved .optional() outside the call — v2 resolves ` +
                                `completion metadata after unwrapping an outer optional wrapper, so completable(schema, cb).optional() ` +
                                `keeps both optionality and completions.`
                        )
                    );
                    break;
                }
                case 'nullish': {
                    diagnostics.push(
                        actionRequired(
                            filePath,
                            call,
                            `completable() first argument ends in .nullish(), whose outer layer is an optional wrapper — v2 resolves ` +
                                `completion metadata after unwrapping it, so completions would come back empty. Rewrite as ` +
                                `completable(schema.nullable(), cb).optional().`
                        )
                    );
                    break;
                }
                case 'buried-optional': {
                    diagnostics.push(
                        actionRequired(
                            filePath,
                            call,
                            `completable() first argument contains an optional wrapper inside its method chain — v2 resolves ` +
                                `completion metadata after unwrapping an outer optional wrapper, so the v1 nesting returns empty ` +
                                `completion lists. Move the optional wrapping to the completable(...) result ` +
                                `(completable(schema, cb).optional()) and rebuild the rest of the chain around it.`
                        )
                    );
                    break;
                }
                case 'opaque': {
                    // The schema may be optional-wrapped where it is defined. One nudge per
                    // file, no marker (plain schemas via identifiers are common and fine).
                    if (!opaqueArgNoted) {
                        opaqueArgNoted = true;
                        diagnostics.push({
                            ...warning(
                                filePath,
                                call.getStartLineNumber(),
                                `completable() receives a schema by reference — verify the referenced schema is not wrapped in ` +
                                    `.optional() inside the call. v2 resolves completion metadata after unwrapping an outer optional ` +
                                    `wrapper, so optionality belongs on the completable(...) result: completable(schema, cb).optional().`
                            ),
                            advisoryOnly: true
                        });
                    }
                    break;
                }
                case 'plain-call': {
                    break;
                }
            }
        }

        return { changesCount, diagnostics };
    }
};
