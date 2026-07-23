import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Transform, TransformContext, TransformResult } from '../../../types';
import { hasMcpImports, isImportedFromMcp, removeUnusedImport, resolveOriginalImportName } from '../../../utils/importUtils';
import { SCHEMA_TO_METHOD } from '../mappings/schemaToMethodMap';

const TARGET_METHODS = new Set(['request', 'callTool']);

/** Spec request methods — the only methods whose result schema v2 resolves by name. */
const SPEC_REQUEST_METHODS: ReadonlySet<string> = new Set(Object.values(SCHEMA_TO_METHOD));

// `request()` keeps its result-schema parameter in v2 (custom methods, passthrough
// forwarding); only calls whose method the codemod can PROVE is a literal spec method
// may safely lose it. Schema-less v2 `request()` enforces the spec result schema for
// spec methods and throws a TypeError for non-spec methods, so dropping the schema
// from a dynamic-method call (`request({ method, params }, schema)` in a
// proxy/forwarder) or from a custom-method call breaks the call site.
function literalMethodOf(arg: Node): string | undefined {
    if (!Node.isObjectLiteralExpression(arg)) return undefined;
    const prop = arg.getProperty('method');
    if (!prop || !Node.isPropertyAssignment(prop)) return undefined;
    // A spread after the `method` property can override it at runtime — not provably literal.
    const props = arg.getProperties();
    const spreadAfterMethod = props.slice(props.indexOf(prop) + 1).some(p => Node.isSpreadAssignment(p));
    if (spreadAfterMethod) return undefined;
    let initializer = prop.getInitializer();
    // Unwrap `'tools/call' as const` / `satisfies` / parenthesized forms.
    while (
        initializer !== undefined &&
        (Node.isAsExpression(initializer) || Node.isSatisfiesExpression(initializer) || Node.isParenthesizedExpression(initializer))
    ) {
        initializer = initializer.getExpression();
    }
    if (initializer === undefined) return undefined;
    if (!Node.isStringLiteral(initializer) && !Node.isNoSubstitutionTemplateLiteral(initializer)) return undefined;
    return initializer.getLiteralValue();
}

export const schemaParamRemovalTransform: Transform = {
    name: 'Schema parameter removal',
    id: 'schema-params',
    apply(sourceFile: SourceFile, _context: TransformContext): TransformResult {
        let changesCount = 0;

        // `request`/`callTool` are common method names on non-MCP receivers too. The schema-identifier
        // path guards per-symbol via `isImportedFromMcp`; the `undefined` path has no symbol to check, so
        // gate it on a file-level MCP signal to avoid rewriting unrelated calls.
        const fileHasMcpImports = hasMcpImports(sourceFile);

        const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

        for (const call of calls) {
            const expr = call.getExpression();
            if (!Node.isPropertyAccessExpression(expr)) continue;

            const methodName = expr.getName();
            if (!TARGET_METHODS.has(methodName)) continue;

            const args = call.getArguments();
            if (args.length < 2) continue;

            const secondArg = args[1]!;
            if (!Node.isIdentifier(secondArg)) continue;

            // `request(req, undefined, options)` / `callTool(params, undefined, options)`: v1 passed an
            // explicit `undefined` result schema before the trailing options argument. v2 removed the
            // schema parameter for spec methods, so the literal `undefined` leaves the call with one
            // argument too many (TS2554). Drop it only when a third argument follows — a 2-arg
            // `callTool(params, undefined)` already type-checks, since `undefined` is a valid options arg.
            if (secondArg.getText() === 'undefined') {
                if (!fileHasMcpImports || args.length < 3) continue;
                const firstArg = args[0]!;
                if (methodName === 'request') {
                    // Drop only when the method is provably a literal spec method (the same
                    // proof the schema-identifier path requires). When the skip leaves an
                    // explicit undefined behind, the result is a LOUD compile error the user
                    // resolves with the call's intent in view — strictly better than silently
                    // changing semantics. The proof also keeps the rewrite off non-SDK
                    // receivers that happen to be named `request` with a bare-string first
                    // argument, where deleting the middle argument corrupts the call.
                    const literal = literalMethodOf(firstArg);
                    if (literal === undefined || !SPEC_REQUEST_METHODS.has(literal)) continue;
                } else if (
                    Node.isStringLiteral(firstArg) ||
                    Node.isNoSubstitutionTemplateLiteral(firstArg) ||
                    Node.isTemplateExpression(firstArg) ||
                    Node.isNumericLiteral(firstArg) ||
                    firstArg.getKind() === SyntaxKind.TrueKeyword ||
                    firstArg.getKind() === SyntaxKind.FalseKeyword
                ) {
                    // v1 callTool() takes a params OBJECT first — a primitive first argument
                    // means a non-SDK receiver sharing the method name.
                    continue;
                }
                call.removeArgument(1);
                changesCount++;
                continue;
            }

            const schemaName = secondArg.getText();
            const originalName = resolveOriginalImportName(sourceFile, schemaName) ?? schemaName;
            if (!originalName.endsWith('Schema')) continue;
            if (!isImportedFromMcp(sourceFile, schemaName)) continue;

            // v2 `callTool()` has no schema parameter at all, so the argument always goes.
            // v2 `request()` still accepts one — only drop it when the method is a literal
            // SPEC method (schema-less request() throws a TypeError for anything else) and
            // the schema is method-specific: the generic `ResultSchema` is the v1
            // passthrough idiom, and dropping it would silently switch the call from
            // passthrough to spec-schema enforcement.
            if (methodName === 'request') {
                const literal = literalMethodOf(args[0]!);
                if (literal === undefined || !SPEC_REQUEST_METHODS.has(literal)) continue;
                if (originalName === 'ResultSchema') continue;
            }

            call.removeArgument(1);
            changesCount++;

            removeUnusedImport(sourceFile, schemaName, true);
        }

        return { changesCount, diagnostics: [] };
    }
};
