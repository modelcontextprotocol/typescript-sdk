import type { ObjectLiteralExpression, SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types';
import { isKeyPositionIdentifier } from '../../../utils/astUtils';
import { actionRequired, info } from '../../../utils/diagnostics';
import { hasMcpImports } from '../../../utils/importUtils';
import { CONTEXT_PROPERTY_MAP, CTX_PARAM_NAME, EXTRA_PARAM_NAME } from '../mappings/contextPropertyMap';

const CONTEXT_LIKE_KEYS = new Set(CONTEXT_PROPERTY_MAP.map(mapping => mapping.from.slice(1)));

/**
 * v1 context keys distinctive enough that a single one on an object literal is a strong
 * signal it's a hand-built handler-context mock (vs. generic keys like `signal`/`sessionId`/
 * `requestId` — a bare correlation-ID literal such as `logger.info(msg, { requestId })` is
 * not a context mock — which appear on unrelated objects and only count in aggregate).
 */
const DISTINCTIVE_CONTEXT_KEYS = new Set([
    'sendRequest',
    'sendNotification',
    'requestInfo',
    'authInfo',
    'closeSSEStream',
    'closeStandaloneSSEStream'
]);

/** A literal already carrying one of these is in the v2 nested shape — not a stale v1 mock. */
const V2_SHAPE_KEYS = new Set(['mcpReq', 'http', 'task']);

const HANDLER_METHODS = new Set(['setRequestHandler', 'setNotificationHandler']);

/**
 * Transport ingestion methods whose second argument is a flat `MessageExtraInfo`
 * (authInfo/request/closeSSEStream/… stay top-level in v2), NOT a handler context —
 * so a literal handed to them must never get handler-context reshape guidance.
 */
const TRANSPORT_MESSAGE_METHODS = new Set(['onmessage', 'handleMessage']);

const REGISTER_METHODS = new Set(['registerTool', 'registerPrompt', 'registerResource', 'tool', 'prompt', 'resource']);

/**
 * Attempt to rename the second parameter of a callback from 'extra' to 'ctx'
 * and rewrite context property accesses in its body.
 * Returns the number of changes made, or -1 if skipped.
 */
function processCallback(
    callbackNode: Node,
    sourceFile: SourceFile,
    diagnostics: Diagnostic[],
    methodName: string,
    callLine: number
): number {
    if (!Node.isArrowFunction(callbackNode) && !Node.isFunctionExpression(callbackNode) && !Node.isMethodDeclaration(callbackNode))
        return -1;

    const params = callbackNode.getParameters();
    if (params.length < 2) return -1;

    // The context argument is always trailing — registerTool/registerPrompt callbacks
    // are (args, extra) but a registerResource template read callback is
    // (uri, variables, extra) — so find the parameter named `extra` among the
    // non-first positions instead of assuming index 1. A destructured trailing
    // parameter is selected too, so it reaches the destructuring diagnostic below.
    const trailing = params.at(-1)!;
    const extraParam =
        params.slice(1).find(par => !Node.isObjectBindingPattern(par.getNameNode()) && par.getName() === EXTRA_PARAM_NAME) ??
        (Node.isObjectBindingPattern(trailing.getNameNode()) ? trailing : undefined);
    if (extraParam === undefined) return -1;
    const paramNameNode = extraParam.getNameNode();
    if (Node.isObjectBindingPattern(paramNameNode)) {
        // A destructured trailing parameter is only the context when its keys look
        // like context members — a registerResource template read callback's
        // `(uri, { owner, repo })` destructures the URI variables, not the context.
        // Match the PROPERTY names (a renamed binding `{ signal: abort }` still
        // destructures the context's `signal`).
        const propertyNames = paramNameNode.getElements().map(el => el.getPropertyNameNode()?.getText() ?? el.getName());
        if (!propertyNames.some(name => CONTEXT_LIKE_KEYS.has(name))) return -1;
        diagnostics.push(
            actionRequired(
                sourceFile.getFilePath(),
                extraParam,
                `Destructuring of context parameter in signature: "${paramNameNode.getText()}". ` +
                    'Properties have been reorganized in v2 (e.g., signal is now ctx.mcpReq.signal). Manual refactoring required.'
            )
        );
        return -1;
    }
    const paramName = extraParam.getName();
    if (paramName !== EXTRA_PARAM_NAME) return -1;

    const body = callbackNode.getBody();

    const otherParams = callbackNode.getParameters().filter(p => p !== extraParam);
    if (otherParams.some(p => p.getName() === CTX_PARAM_NAME)) {
        diagnostics.push(
            actionRequired(
                sourceFile.getFilePath(),
                extraParam,
                `Cannot rename '${EXTRA_PARAM_NAME}' to '${CTX_PARAM_NAME}': another parameter is already named '${CTX_PARAM_NAME}'. Manual migration required.`
            )
        );
        return -1;
    }

    if (body) {
        let ctxAlreadyInScope = false;
        body.forEachDescendant((node, traversal) => {
            if (
                (Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node)) &&
                node.getParameters().some(p => p.getName() === CTX_PARAM_NAME)
            ) {
                traversal.skip();
                return;
            }
            if (Node.isIdentifier(node) && node.getText() === CTX_PARAM_NAME) {
                ctxAlreadyInScope = true;
            }
        });
        if (ctxAlreadyInScope) {
            diagnostics.push(
                actionRequired(
                    sourceFile.getFilePath(),
                    extraParam,
                    `Cannot rename '${EXTRA_PARAM_NAME}' to '${CTX_PARAM_NAME}': '${CTX_PARAM_NAME}' is already referenced in this scope. Manual migration required.`
                )
            );
            return -1;
        }
    }

    // Rename param declaration and rewrite body references using AST traversal.
    // We walk Identifier nodes to avoid corrupting string literals, comments, and
    // unrelated property names (e.g., meta.extra) that regex-based replacement would hit.
    const paramDecl = extraParam.getNameNode();
    paramDecl.replaceWithText(CTX_PARAM_NAME);

    if (body) {
        const sortedMappings = [...CONTEXT_PROPERTY_MAP].filter(m => m.from !== m.to).toSorted((a, b) => b.from.length - a.from.length);

        // Collect identifiers that are actual references to the `extra` parameter
        const identifiers: import('ts-morph').Node[] = [];
        body.forEachDescendant(node => {
            if (!Node.isIdentifier(node) || node.getText() !== EXTRA_PARAM_NAME) return;
            const parent = node.getParent();
            if (parent && isKeyPositionIdentifier(node)) return;
            identifiers.push(node);
        });

        // Build replacements: apply property mappings for PropertyAccess/QualifiedName, plain rename otherwise
        const replacements: { node: import('ts-morph').Node; newText: string }[] = [];
        for (const id of identifiers) {
            const parent = id.getParent();
            // Value-position property access: extra.signal → ctx.mcpReq.signal
            if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === id) {
                const propName = '.' + parent.getName();
                const mapping = sortedMappings.find(m => m.from === propName);
                if (mapping) {
                    // Preserve optional chaining: `extra?.signal` stays defensive.
                    const joiner = parent.hasQuestionDotToken() ? '?' + mapping.to : mapping.to;
                    replacements.push({ node: parent, newText: CTX_PARAM_NAME + joiner });
                    continue;
                }
            }
            // Type-position qualified name: typeof extra.signal → typeof ctx.mcpReq.signal
            if (parent && parent.getKind() === SyntaxKind.QualifiedName && parent.getChildAtIndex(0) === id) {
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
            // Shorthand property assignment: { extra } → { extra: ctx }
            if (parent && Node.isShorthandPropertyAssignment(parent)) {
                replacements.push({ node: parent, newText: `${EXTRA_PARAM_NAME}: ${CTX_PARAM_NAME}` });
                continue;
            }
            replacements.push({ node: id, newText: CTX_PARAM_NAME });
        }

        // Apply in reverse position order to avoid node invalidation
        const sorted = replacements.toSorted((a, b) => b.node.getStart() - a.node.getStart());
        for (const { node, newText } of sorted) {
            node.replaceWithText(newText);
        }
    }

    const changes = 1;

    if (['tool', 'prompt', 'resource'].includes(methodName)) {
        diagnostics.push(
            info(
                sourceFile.getFilePath(),
                callLine,
                `Renamed 'extra' to 'ctx' in .${methodName}() callback. If this is not an McpServer method, revert this change.`
            )
        );
    }

    // A context object forwarded wholesale to a helper carries the v1 property shape
    // into code this transform never sees — note each callee once.
    const forwardedBody = callbackNode.getBody();
    if (forwardedBody) {
        const notedCallees = new Set<string>();
        forwardedBody.forEachDescendant(node => {
            if (!Node.isCallExpression(node)) return;
            const hasBareCtx = node
                .getArguments()
                .some(arg => Node.isIdentifier(arg) && arg.getText() === CTX_PARAM_NAME && !isKeyPositionIdentifier(arg));
            if (!hasBareCtx) return;
            const calleeText = node.getExpression().getText();
            if (notedCallees.has(calleeText)) return;
            notedCallees.add(calleeText);
            diagnostics.push({
                ...actionRequired(
                    sourceFile.getFilePath(),
                    node,
                    `The context object is forwarded to ${calleeText}(…) — its property shape changed in v2 ` +
                        `(e.g. extra.signal is now ctx.mcpReq.signal, extra.sendRequest is ctx.mcpReq.send). Update the ` +
                        `helper's parameter type and property accesses.`
                ),
                advisoryOnly: true
            });
        });
    }

    // Warn on destructuring of ctx in body (after text replacement)
    const freshBody = callbackNode.getBody();
    if (freshBody) {
        freshBody.forEachDescendant(node => {
            if (!Node.isVariableDeclaration(node)) return;
            const initializer = node.getInitializer();
            if (!initializer || !Node.isIdentifier(initializer) || initializer.getText() !== CTX_PARAM_NAME) return;
            const nameNode = node.getNameNode();
            if (!Node.isObjectBindingPattern(nameNode)) return;
            diagnostics.push(
                actionRequired(
                    sourceFile.getFilePath(),
                    node,
                    `Destructuring of context parameter detected: "const ${nameNode.getText()} = ${CTX_PARAM_NAME}". ` +
                        'Properties have been reorganized in v2 (e.g., signal is now ctx.mcpReq.signal). Manual refactoring required.'
                )
            );
        });
    }

    return changes;
}

export const contextTypesTransform: Transform = {
    name: 'Context type rewrites',
    id: 'context',
    apply(sourceFile: SourceFile, _context: TransformContext): TransformResult {
        if (!hasMcpImports(sourceFile)) {
            return { changesCount: 0, diagnostics: [] };
        }

        let changesCount = 0;
        const diagnostics: Diagnostic[] = [];

        // Process one callback at a time, re-querying the AST after each.
        // processCallback uses body.replaceWithText() which invalidates sibling nodes,
        // so we cannot iterate a pre-collected list of calls.
        let madeProgress = true;
        const processed = new Set<number>();
        while (madeProgress) {
            madeProgress = false;
            const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

            for (const call of calls) {
                const callStart = call.getStart();
                if (processed.has(callStart)) continue;

                const expr = call.getExpression();
                if (!Node.isPropertyAccessExpression(expr)) continue;

                const methodName = expr.getName();
                const isHandler = HANDLER_METHODS.has(methodName);
                const isRegister = REGISTER_METHODS.has(methodName);
                if (!isHandler && !isRegister) continue;

                const args = call.getArguments();

                let callbackArg: Node | undefined;
                if (isHandler && args.length >= 2) {
                    callbackArg = args[1];
                } else if (isRegister && args.length >= 2) {
                    callbackArg = args.at(-1);
                }

                if (!callbackArg) continue;

                // Handle ObjectLiteralExpression callback containers (handler maps)
                if (Node.isObjectLiteralExpression(callbackArg)) {
                    for (const prop of callbackArg.getProperties()) {
                        let callbackNode: Node | undefined;
                        if (Node.isPropertyAssignment(prop)) {
                            callbackNode = prop.getInitializer();
                        } else if (Node.isMethodDeclaration(prop)) {
                            callbackNode = prop;
                        }
                        if (!callbackNode) continue;

                        const result = processCallback(callbackNode, sourceFile, diagnostics, methodName, call.getStartLineNumber());
                        if (result > 0) {
                            changesCount += result;
                            madeProgress = true;
                        }
                    }
                    processed.add(callStart);
                    if (madeProgress) break;
                    continue;
                }

                // Handle direct ArrowFunction / FunctionExpression callbacks
                const result = processCallback(callbackArg, sourceFile, diagnostics, methodName, call.getStartLineNumber());
                processed.add(callStart);
                if (result > 0) {
                    changesCount += result;
                    madeProgress = true;
                    break;
                }
            }
        }

        changesCount += processFallbackHandlerAssignments(sourceFile, diagnostics);
        changesCount += remapAnnotatedContextParams(sourceFile, diagnostics);
        flagV1MockContextLiterals(sourceFile, diagnostics);

        return { changesCount, diagnostics };
    }
};

/**
 * `server.fallbackRequestHandler = async (request, extra) => { … }` — the assigned
 * function is a handler callback in everything but registration shape.
 */
function processFallbackHandlerAssignments(sourceFile: SourceFile, diagnostics: Diagnostic[]): number {
    let changes = 0;
    for (const bin of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        if (bin.wasForgotten()) continue;
        if (bin.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
        const left = bin.getLeft();
        if (!Node.isPropertyAccessExpression(left)) continue;
        const name = left.getName();
        if (name !== 'fallbackRequestHandler' && name !== 'fallbackNotificationHandler') continue;
        const rhs = bin.getRight();
        if (!Node.isArrowFunction(rhs) && !Node.isFunctionExpression(rhs)) continue;
        const result = processCallback(rhs, sourceFile, diagnostics, name, bin.getStartLineNumber());
        if (result > 0) changes += result;
    }
    return changes;
}

/**
 * Render a v1 context key as a reshape hint, e.g. `sendRequest` → `mcpReq.send`. Returns
 * undefined for `sessionId` (a no-op — it stays top-level in v2) and for non-context keys.
 */
function contextKeyReshapeHint(key: string): string | undefined {
    const mapping = CONTEXT_PROPERTY_MAP.find(m => m.from === '.' + key);
    if (mapping === undefined || mapping.from === mapping.to) return undefined;
    // Render the target as a plain object path: '.http?.authInfo' → 'http.authInfo'.
    return `${key} → ${mapping.to.replace(/^\./, '').replaceAll('?', '')}`;
}

/**
 * Flag hand-built mocks of the handler context (common in tests). The call-site scan above
 * only reshapes `extra.X` inside handler definitions it can anchor on (registerTool,
 * setRequestHandler, fallback handlers, annotated params). A test hands its mock to a bare
 * `handler(args, mockCtx)` invocation, so the object literal is never reached and keeps the
 * flat v1 shape — at runtime the migrated handler reads `ctx.mcpReq.send` / `.id` / … against
 * it and throws "Cannot read properties of undefined (reading 'send')". Advisory only: an
 * untyped literal that merely shares a key name might not be a context mock, so never rewrite.
 */
function flagV1MockContextLiterals(sourceFile: SourceFile, diagnostics: Diagnostic[]): void {
    for (const obj of sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
        // Only literals in a mock-context position: a call argument or a variable initializer.
        // Covers both `handler({}, { sendRequest: fn })` and `const extra = { … }; handler(a, extra)`.
        // Unwrap casts/parens first so typed mocks — `{ … } as unknown as RequestHandlerExtra`,
        // `({ … })`, `{ … } satisfies X` — are anchored by what encloses the cast, not the
        // AsExpression that directly wraps the literal.
        let expr: Node = obj;
        let parent = expr.getParent();
        while (
            parent !== undefined &&
            (Node.isAsExpression(parent) || Node.isSatisfiesExpression(parent) || Node.isParenthesizedExpression(parent))
        ) {
            expr = parent;
            parent = parent.getParent();
        }
        const isCallArg = parent !== undefined && Node.isCallExpression(parent) && parent.getArguments().includes(expr);
        const isVarInit = parent !== undefined && Node.isVariableDeclaration(parent) && parent.getInitializer() === expr;
        if (!isCallArg && !isVarInit) continue;

        // A literal handed to a transport ingestion method (`transport.onmessage(msg, { … })`,
        // `transport.handleMessage(msg, { … })`) is a flat MessageExtraInfo, not a handler-context
        // mock — reshaping its authInfo/request/closeSSEStream/… under http/mcpReq would be wrong.
        if (isCallArg && Node.isCallExpression(parent)) {
            const callee = parent.getExpression();
            if (Node.isPropertyAccessExpression(callee) && TRANSPORT_MESSAGE_METHODS.has(callee.getName())) continue;
        }

        // The codemod's OWN output: an options object inside a just-rewritten handler whose values
        // now read `ctx.mcpReq.*` / `ctx.http.*`. The keys keep their v1 names — so V2_SHAPE_KEYS
        // below, which only inspects key names, won't catch it — but the values are already v2, not
        // a stale mock. Flagging it would insert a comment above code the codemod itself produced.
        if (readsFromMigratedContext(obj)) continue;

        // Collect named property keys (skip spreads and computed names).
        const keys: string[] = [];
        for (const prop of obj.getProperties()) {
            if (!Node.isPropertyAssignment(prop) && !Node.isShorthandPropertyAssignment(prop) && !Node.isMethodDeclaration(prop)) continue;
            const nameNode = prop.getNameNode();
            if (Node.isIdentifier(nameNode)) keys.push(nameNode.getText());
            else if (Node.isStringLiteral(nameNode)) keys.push(nameNode.getLiteralText());
        }
        if (keys.some(key => V2_SHAPE_KEYS.has(key))) continue; // already v2-shaped

        const contextKeys = keys.filter(key => CONTEXT_LIKE_KEYS.has(key));
        const hasDistinctive = contextKeys.some(key => DISTINCTIVE_CONTEXT_KEYS.has(key));
        if (!hasDistinctive && contextKeys.length < 2) continue;

        const reshapes = contextKeys.map(key => contextKeyReshapeHint(key)).filter((hint): hint is string => hint !== undefined);
        const sessionNote = contextKeys.includes('sessionId') ? '; sessionId stays top-level' : '';
        diagnostics.push({
            ...actionRequired(
                sourceFile.getFilePath(),
                obj,
                `This object looks like a v1 handler-context mock (${contextKeys.join(', ')}). v2 nests the context — ` +
                    `reshape it (${reshapes.join('; ')}${sessionNote}), e.g. { sendRequest: fn } → { mcpReq: { send: fn } }. ` +
                    `Passed as-is to a migrated handler that reads ctx.mcpReq.*, the v1 shape throws ` +
                    `"Cannot read properties of undefined".`
            ),
            advisoryOnly: true
        });
    }
}

/**
 * True when any property value already reads from the v2-nested context — a `.mcpReq` or `.http`
 * property access (e.g. `ctx.mcpReq.signal`, `ctx.http?.authInfo`). Such a literal is migrated
 * output, not a hand-built v1 mock: a real v1 mock supplies raw values (`fn`, `ac.signal`, a
 * literal), never the nested v2 shape the codemod itself just wrote.
 */
function readsFromMigratedContext(obj: ObjectLiteralExpression): boolean {
    for (const prop of obj.getProperties()) {
        if (!Node.isPropertyAssignment(prop)) continue;
        const init = prop.getInitializer();
        if (init === undefined) continue;
        const accesses = init.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
        if (Node.isPropertyAccessExpression(init)) accesses.push(init);
        if (accesses.some(access => access.getName() === 'mcpReq' || access.getName() === 'http')) return true;
    }
    return false;
}

const CONTEXT_TYPE_NAMES = new Set(['RequestHandlerExtra', 'ServerContext', 'ClientContext']);
/**
 * Split a type's text on top-level `|` only (angle brackets tracked). Returns
 * undefined for shapes that can never be a bare context reference: intersections,
 * object literals, and unbalanced text.
 */
function splitTopLevelUnion(typeText: string): string[] | undefined {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of typeText) {
        if (ch === '<') depth++;
        else if (ch === '>') depth--;
        if (depth === 0 && (ch === '&' || ch === '{')) return undefined;
        if (ch === '|' && depth === 0) {
            parts.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    parts.push(current.trim());
    return depth === 0 ? parts.filter(part => part !== '') : undefined;
}

const CONTEXT_TYPE_RE = /\b(?:RequestHandlerExtra|ServerContext|ClientContext)\b/;

/** True when `name` is rebound by a function parameter between `node` and `scopeRoot`. */
function isRebornWithin(node: Node, scopeRoot: Node, name: string): boolean {
    let current = node.getParent();
    while (current !== undefined && current !== scopeRoot) {
        if (
            (Node.isArrowFunction(current) ||
                Node.isFunctionExpression(current) ||
                Node.isFunctionDeclaration(current) ||
                Node.isMethodDeclaration(current)) &&
            current.getParameters().some(param => param.getName() === name)
        ) {
            return true;
        }
        current = current.getParent();
    }
    return false;
}

/**
 * Functions and methods whose parameter is ANNOTATED as a context type (directly,
 * `| undefined`-widened, or via same-file aliases resolved to fixpoint) carry the v1
 * property shape in their bodies even when the call-site scan never reaches them —
 * private handler methods, alias-typed callbacks. The accesses remap in place; the
 * parameter keeps its name. Annotations that mention a context type in a shape the
 * remap cannot prove (unions with other types, containers) get an advisory instead
 * of silence.
 */
function remapAnnotatedContextParams(sourceFile: SourceFile, diagnostics: Diagnostic[]): number {
    // An alias only joins the set when its right-hand side IS a context type (a bare,
    // possibly `| undefined`-widened reference to one, or to another accepted alias).
    // A wrapper that merely MENTIONS a context type (`{ mcp: ServerContext; signal: … }`)
    // has its own property shape — remapping accesses on it would corrupt them — so it
    // falls through to the advisory path below.
    const aliasNames = new Set<string>();
    const isDirectContextReference = (typeText: string): boolean => {
        const parts = splitTopLevelUnion(typeText);
        if (parts === undefined) return false;
        const names = parts.filter(part => part !== 'undefined' && part !== 'null');
        if (names.length !== 1) return false;
        const base = names[0]!.replace(/<[\s\S]*$/, '').trim();
        return /^[A-Za-z_$][\w$]*$/.test(base) && (CONTEXT_TYPE_NAMES.has(base) || aliasNames.has(base));
    };
    let grew = true;
    while (grew) {
        grew = false;
        for (const alias of sourceFile.getTypeAliases()) {
            if (aliasNames.has(alias.getName())) continue;
            if (isDirectContextReference(alias.getTypeNode()?.getText() ?? '')) {
                aliasNames.add(alias.getName());
                grew = true;
            }
        }
    }

    // Aliases that MENTION a context type without being one (wrappers, intersections,
    // containers) cannot be remapped, but parameters typed with them still carry v1
    // context members somewhere inside — they get the advisory, never the rewrite.
    const aliasMentions = new Set<string>(aliasNames);
    grew = true;
    while (grew) {
        grew = false;
        for (const alias of sourceFile.getTypeAliases()) {
            if (aliasMentions.has(alias.getName())) continue;
            const text = alias.getTypeNode()?.getText() ?? '';
            const mentions =
                CONTEXT_TYPE_RE.test(text) || [...aliasMentions].some(known => new RegExp(String.raw`\b${known}\b`).test(text));
            if (mentions) {
                aliasMentions.add(alias.getName());
                grew = true;
            }
        }
    }

    const matchesContextType = (annotation: string): boolean => {
        // Strip generic arguments and nullable widening; the base must BE the type.
        const base = annotation
            .replace(/<[\s\S]*$/, '')
            .replaceAll(/\s*\|\s*(undefined|null)\s*$/g, '')
            .trim();
        return CONTEXT_TYPE_NAMES.has(base) || aliasNames.has(base);
    };
    const mentionsContextType = (annotation: string): boolean =>
        CONTEXT_TYPE_RE.test(annotation) || [...aliasMentions].some(known => new RegExp(String.raw`\b${known}\b`).test(annotation));

    const sortedMappings = [...CONTEXT_PROPERTY_MAP]
        .filter(mapping => mapping.from !== mapping.to)
        .toSorted((a, b) => b.from.length - a.from.length);

    let changes = 0;
    sourceFile.forEachDescendant(node => {
        if (
            !Node.isArrowFunction(node) &&
            !Node.isFunctionExpression(node) &&
            !Node.isFunctionDeclaration(node) &&
            !Node.isMethodDeclaration(node)
        ) {
            return;
        }
        for (const param of node.getParameters()) {
            const annotation = param.getTypeNode()?.getText();
            if (annotation === undefined) continue;
            const nameNode = param.getNameNode();
            if (Node.isObjectBindingPattern(nameNode)) continue; // destructured: handled by the marker path
            if (!matchesContextType(annotation)) {
                if (mentionsContextType(annotation)) {
                    diagnostics.push({
                        ...actionRequired(
                            sourceFile.getFilePath(),
                            param,
                            `Parameter annotation '${annotation}' mentions a context type in a shape the codemod cannot ` +
                                `remap — review the body's property accesses (e.g. .signal is now .mcpReq.signal).`
                        ),
                        advisoryOnly: true
                    });
                }
                continue;
            }
            const paramName = param.getName();
            const body = node.getBody();
            if (body === undefined) continue;

            const replacements: { target: import('ts-morph').PropertyAccessExpression; newText: string }[] = [];
            body.forEachDescendant(descendant => {
                if (!Node.isPropertyAccessExpression(descendant)) return;
                const expr = descendant.getExpression();
                if (!Node.isIdentifier(expr) || expr.getText() !== paramName) return;
                if (isRebornWithin(descendant, node, paramName)) return;
                const mapping = sortedMappings.find(entry => entry.from === '.' + descendant.getName());
                if (mapping === undefined) return;
                // Preserve optional chaining: `extra?.signal` stays defensive.
                const joiner = descendant.hasQuestionDotToken() ? '?' + mapping.to : mapping.to;
                replacements.push({ target: descendant, newText: paramName + joiner });
            });
            if (replacements.length === 0) continue;
            for (const { target, newText } of replacements.toSorted((a, b) => b.target.getStart() - a.target.getStart())) {
                target.replaceWithText(newText);
                changes++;
            }
            diagnostics.push(
                info(
                    sourceFile.getFilePath(),
                    param.getStartLineNumber(),
                    `Remapped v1 context property accesses on '${paramName}' (annotated ${annotation}) to the v2 shape.`
                )
            );
        }
    });
    return changes;
}
