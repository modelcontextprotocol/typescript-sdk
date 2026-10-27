/**
 * Compile-time contract for `McpServer.registerTool` handler results (SEP-2106 / #2754).
 *
 * These are type-level tests: every `@ts-expect-error` line must fail to compile and every
 * other registration must compile. `pnpm typecheck` enforces both. The runtime assertions only
 * pin the authoring affordances the types rely on (content auto-fill).
 */
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/core-internal';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import { type } from 'arktype';
import * as v from 'valibot';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as z from 'zod/v4';

import type { CallToolResult, ServerContext, ToolCallback, ToolResultFor, ToolStructuredContent } from '../../src/index';
import { fromJsonSchema, inputRequired, McpServer } from '../../src/index';
import { invoke } from '../../src/server/invoke';

const server = new McpServer({ name: 's', version: '1' });

describe('registerTool: structuredContent is typed from outputSchema', () => {
    it('rejects the exact #2754 repro', () => {
        // The issue's snippet verbatim, with the callback opened on the registerTool line: tsc reports
        // overload errors at the call and tsgo at the callback, so one line keeps both compilers honest.
        // prettier-ignore
        // @ts-expect-error structuredContent is a string but outputSchema is an object
        server.registerTool('ping', { description: 'Returns a string pong with a timestamp', outputSchema: z.object({ data: z.string() }) }, async () => {
            const str = `Pong at ${new Date().toISOString()}`;
            return {
                content: [{ type: 'text', text: str }],
                structuredContent: str
            };
        });

        server.registerTool('ping-ok', { outputSchema: z.object({ data: z.string() }) }, async () => {
            const str = `Pong at ${new Date().toISOString()}`;
            return { content: [{ type: 'text', text: str }], structuredContent: { data: str } };
        });
    });

    it('checks object fields, missing fields and missing structuredContent', () => {
        const outputSchema = z.object({ data: z.string(), count: z.number() });
        server.registerTool('obj', { outputSchema }, () => ({ content: [], structuredContent: { data: 'ok', count: 1 } }));

        // @ts-expect-error missing required field
        server.registerTool('obj-missing-field', { outputSchema }, () => ({ content: [], structuredContent: { data: 'x' } }));
        // @ts-expect-error wrong field type
        server.registerTool('obj-wrong-field', { outputSchema }, () => ({ content: [], structuredContent: { data: 'x', count: '1' } }));
        // @ts-expect-error successful results must carry structuredContent when outputSchema is declared
        server.registerTool('obj-no-structured', { outputSchema }, () => ({ content: [{ type: 'text', text: 'no structured' }] }));
        // @ts-expect-error runtime treats undefined structuredContent as absent
        server.registerTool('obj-undefined', { outputSchema }, () => ({ content: [], structuredContent: undefined }));
        // @ts-expect-error isError: false is a success and is validated
        server.registerTool('obj-false-error', { outputSchema }, () => ({ content: [], isError: false }));
    });

    it('works with inputSchema, sync and async handlers', () => {
        const inputSchema = z.object({ n: z.number() });
        const outputSchema = z.object({ doubled: z.number() });
        server.registerTool('sync', { inputSchema, outputSchema }, ({ n }) => {
            expectTypeOf(n).toEqualTypeOf<number>();
            return { content: [], structuredContent: { doubled: n * 2 } };
        });
        server.registerTool('async', { inputSchema, outputSchema }, async ({ n }) => ({
            content: [],
            structuredContent: { doubled: n * 2 }
        }));
        // @ts-expect-error wrong type with an inputSchema present too
        server.registerTool('async-bad', { inputSchema, outputSchema }, async ({ n }) => ({
            content: [],
            structuredContent: { doubled: `${n}` }
        }));
    });

    it('supports non-object output roots (SEP-2106)', () => {
        server.registerTool('arr', { outputSchema: z.array(z.number()) }, () => ({ content: [], structuredContent: [1, 2] }));
        // @ts-expect-error array schema rejects a string
        server.registerTool('arr-bad', { outputSchema: z.array(z.number()) }, () => ({ content: [], structuredContent: 'nope' }));
        server.registerTool('str', { outputSchema: z.string() }, () => ({ content: [], structuredContent: 'ok' }));
        // @ts-expect-error string schema rejects a number
        server.registerTool('str-bad', { outputSchema: z.string() }, () => ({ content: [], structuredContent: 1 }));
        server.registerTool('nul', { outputSchema: z.null() }, () => ({ content: [], structuredContent: null }));
        server.registerTool('unk', { outputSchema: z.unknown() }, () => ({ content: [], structuredContent: null }));
        // An unknown output accepts any value, so forwarded `unknown` values type-check. The cost: a
        // literal `undefined` here is left to the runtime "no structured content" check.
        expectTypeOf<ToolStructuredContent<z.ZodUnknown>>().toEqualTypeOf<unknown>();
        // @ts-expect-error an optional root still requires a defined value at runtime
        server.registerTool('opt-undef', { outputSchema: z.string().optional() }, () => ({ content: [], structuredContent: undefined }));
        server.registerTool('opt-val', { outputSchema: z.string().optional() }, () => ({ content: [], structuredContent: 'x' }));
    });

    it('requires values valid on both sides of the schema (defaults, coercion, transforms)', () => {
        // Defaults: the advertised (output-side) JSON Schema requires `n`, so the handler must supply it.
        const withDefault = z.object({ n: z.number().default(0) });
        expectTypeOf<ToolStructuredContent<typeof withDefault>>().toEqualTypeOf<{ n: number }>();
        // @ts-expect-error the value is sent unparsed, so the default is never applied on the wire
        server.registerTool('default-missing', { outputSchema: withDefault }, () => ({ content: [], structuredContent: {} }));

        // Coercion: input is unknown, output is number — a number satisfies both.
        expectTypeOf<ToolStructuredContent<z.ZodCoercedNumber>>().toEqualTypeOf<number>();
        // @ts-expect-error a string passes coercion at runtime but does not match the advertised schema
        server.registerTool('coerce-str', { outputSchema: z.coerce.number() }, () => ({ content: [], structuredContent: '1' }));

        // Transforms: the runtime validates and sends the raw value; a string → number transform has
        // no value that is valid input AND matches the output-side schema.
        const transformed = z.string().transform(s => s.length);
        expectTypeOf<ToolStructuredContent<typeof transformed>>().toEqualTypeOf<never>();
    });

    it('allows isError results and input-required results without structuredContent', () => {
        const inputSchema = z.object({ ok: z.boolean() });
        const outputSchema = z.object({ data: z.string() });
        server.registerTool('err', { outputSchema }, () => ({ content: [{ type: 'text', text: 'failed' }], isError: true }));
        server.registerTool('err-any-structured', { outputSchema }, () => ({
            content: [],
            isError: true,
            structuredContent: 'diagnostic'
        }));
        server.registerTool('mixed', { inputSchema, outputSchema }, async ({ ok }) =>
            ok ? { content: [], structuredContent: { data: 'ok' } } : { content: [], isError: true }
        );
        server.registerTool('ir', { outputSchema }, () => inputRequired({ requestState: 'opaque' }));

        // prettier-ignore
        // @ts-expect-error a bad success branch cannot hide behind a valid error branch
        server.registerTool('mixed-bad', { inputSchema, outputSchema }, ({ ok }) => (ok ? { structuredContent: { data: 1 } } : { content: [], isError: true }));
    });

    it('lets typed successes omit content (the server fills it in)', () => {
        const outputSchema = z.object({ data: z.string() });
        server.registerTool('no-content', { outputSchema }, () => ({ structuredContent: { data: 'x' } }));
        // The rest of CallToolResult keeps its types on the typed branch.
        server.registerTool('meta', { outputSchema }, () => ({ _meta: { trace: 'abc' }, structuredContent: { data: 'x' } }));
        // @ts-expect-error content blocks are still checked when supplied
        server.registerTool('bad-block', { outputSchema }, () => ({ content: [{ type: 'bogus' }], structuredContent: { data: 'x' } }));
        // Schema-less and error results keep the CallToolResult contract (content required).
        // @ts-expect-error content is required without an outputSchema
        server.registerTool('schemaless-no-content', {}, () => ({ structuredContent: 'x' }));
        // @ts-expect-error content is required on error results
        server.registerTool('err-no-content', { outputSchema }, () => ({ isError: true }));
    });

    it('leaves schema-less tools unchanged', () => {
        server.registerTool('none', {}, () => ({ content: [], structuredContent: 'anything' }));
        server.registerTool('none-input', { inputSchema: z.object({ v: z.string() }) }, ({ v }) => ({
            content: [],
            structuredContent: v.length
        }));
        expectTypeOf<ToolResultFor<undefined>>().toEqualTypeOf<CallToolResult>();
        // A schema that is only possibly present stays broad when spelled out explicitly...
        expectTypeOf<ToolResultFor<z.ZodString | undefined>>().toEqualTypeOf<CallToolResult>();
        // ...but `outputSchema?:` absorbs `| undefined` at the call site, so registerTool checks it as present.
        const maybe = (on: boolean): z.ZodObject<{ a: z.ZodString }> | undefined => (on ? z.object({ a: z.string() }) : undefined);
        server.registerTool('maybe', { outputSchema: maybe(false) }, () => ({ content: [], structuredContent: { a: 'x' } }));
        // @ts-expect-error possibly-absent schema is checked as if present
        server.registerTool('maybe-bad', { outputSchema: maybe(false) }, () => ({ content: [], structuredContent: 42 }));
    });

    it('is provider-agnostic (any StandardSchemaWithJSON)', () => {
        const objectOut = {} as StandardSchemaWithJSON<{ answer: string }, { answer: string }>;
        server.registerTool('std', { outputSchema: objectOut }, () => ({ content: [], structuredContent: { answer: 'ok' } }));
        // @ts-expect-error provider-agnostic: wrong field type
        server.registerTool('std-bad', { outputSchema: objectOut }, () => ({ content: [], structuredContent: { answer: 1 } }));

        const unknownOut = {} as StandardSchemaWithJSON<unknown, unknown>;
        server.registerTool('std-unknown', { outputSchema: unknownOut }, () => ({ content: [], structuredContent: { any: 'thing' } }));
        // @ts-expect-error unknown output still needs a defined structuredContent
        server.registerTool('std-unknown-missing', { outputSchema: unknownOut }, () => ({ content: [] }));
    });

    it('works with ArkType and Valibot output schemas', () => {
        const ark = type({ result: 'string' });
        server.registerTool('ark', { outputSchema: ark }, () => ({ structuredContent: { result: 'ok' } }));
        // @ts-expect-error ArkType: wrong field type
        server.registerTool('ark-bad', { outputSchema: ark }, () => ({ structuredContent: { result: 1 } }));

        const valibot = toStandardJsonSchema(v.object({ result: v.string() }));
        server.registerTool('valibot', { outputSchema: valibot }, () => ({ structuredContent: { result: 'ok' } }));
        // @ts-expect-error Valibot: missing required field
        server.registerTool('valibot-bad', { outputSchema: valibot }, () => ({ structuredContent: {} }));
    });

    it('covers the deprecated raw-shape overload', () => {
        const inputSchema = { n: z.number() };
        const outputSchema = { result: z.string() };
        server.registerTool('raw', { inputSchema, outputSchema }, ({ n }) => {
            expectTypeOf(n).toEqualTypeOf<number>();
            return { content: [], structuredContent: { result: String(n) } };
        });
        // @ts-expect-error raw output shape: wrong field type
        server.registerTool('raw-bad', { inputSchema, outputSchema }, ({ n }) => ({ content: [], structuredContent: { result: n } }));
        // Raw input shape with a Standard Schema output.
        server.registerTool('raw-in-std-out', { inputSchema, outputSchema: z.array(z.number()) }, ({ n }) => ({
            content: [],
            structuredContent: [n]
        }));
        // @ts-expect-error raw input shape with a Standard Schema output: wrong root
        server.registerTool('raw-in-std-out-bad', { inputSchema, outputSchema: z.array(z.number()) }, ({ n }) => ({
            content: [],
            structuredContent: n
        }));
        server.registerTool('raw-err', { inputSchema, outputSchema }, () => ({ content: [], isError: true }));
    });

    it('keeps every config the base overloads accepted compiling', () => {
        // A forwarded, possibly-undefined raw input shape (v1 wrapper idiom).
        const maybeRawInput = (on: boolean): { n: z.ZodNumber } | undefined => (on ? { n: z.number() } : undefined);
        server.registerTool('fwd-raw-in', { inputSchema: maybeRawInput(true) }, args => ({
            content: [{ type: 'text', text: String(args.n) }]
        }));
        const config: { inputSchema?: { n: z.ZodNumber } } = {};
        server.registerTool('cfg-raw-in', config, () => ({ content: [] }));

        // A raw output shape typed as possibly undefined, or as a union with a Standard Schema.
        const maybeRawOutput = (on: boolean): { r: z.ZodString } | undefined => (on ? { r: z.string() } : undefined);
        server.registerTool('fwd-raw-out', { outputSchema: maybeRawOutput(true) }, () => ({ structuredContent: { r: 'x' } }));
        const rawOrStd = (on: boolean): { r: z.ZodString } | z.ZodObject<{ r: z.ZodString }> =>
            on ? { r: z.string() } : z.object({ r: z.string() });
        server.registerTool('raw-or-std-out', { outputSchema: rawOrStd(true) }, () => ({ structuredContent: { r: 'x' } }));

        // An `any`-typed schema resolves to the Standard Schema overload as on main (not the deprecated
        // raw-shape one, which would type args as Record<string, unknown> and reject this annotation).
        const anySchema = z.object({ city: z.string() }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        server.registerTool('any-in', { inputSchema: anySchema }, async (args: { city: string }) => ({
            content: [],
            _meta: { city: args.city }
        }));

        // No inputSchema: the callback still receives only the context.
        server.registerTool('ctx-only', {}, ctx => {
            expectTypeOf(ctx).toEqualTypeOf<ServerContext>();
            return { content: [] };
        });
    });

    it('accepts an unknown-typed value for an untyped fromJsonSchema output', () => {
        const forwarded: unknown = JSON.parse('{"a":1}');
        server.registerTool('json-out', { outputSchema: fromJsonSchema({ type: 'object' }) }, () => ({ structuredContent: forwarded }));
        // @ts-expect-error structuredContent is still required on success
        server.registerTool('json-out-missing', { outputSchema: fromJsonSchema({ type: 'object' }) }, () => ({ content: [] }));
    });

    it('types standalone callbacks via ToolCallback<Input, Output>', () => {
        const inputSchema = z.object({ q: z.string() });
        const outputSchema = z.object({ hits: z.number() });
        const cb: ToolCallback<typeof inputSchema, typeof outputSchema> = ({ q }) => ({
            content: [],
            structuredContent: { hits: q.length }
        });
        server.registerTool('standalone', { inputSchema, outputSchema }, cb);
        // @ts-expect-error standalone callback: wrong structuredContent
        const bad: ToolCallback<typeof inputSchema, typeof outputSchema> = () => ({ content: [], structuredContent: { hits: 'x' } });
        void bad;
        // A result typed as plain CallToolResult no longer fits a tool with an outputSchema (documented break).
        // prettier-ignore
        // @ts-expect-error CallToolResult has optional, untyped structuredContent
        server.registerTool('widened', { inputSchema, outputSchema }, async (): Promise<CallToolResult> => ({ content: [], structuredContent: { hits: 1 } }));
        // Branded outputs require branded values.
        const branded = z.object({ id: z.string().brand<'Id'>() });
        // @ts-expect-error a plain string is not a branded Id
        server.registerTool('brand', { outputSchema: branded }, () => ({ structuredContent: { id: 'x' } }));
        // The one-argument form stays broad (unchanged for existing annotations).
        const broad: ToolCallback<typeof inputSchema> = () => ({ content: [], structuredContent: 'anything' });
        void broad;
    });
});

describe('registerTool: runtime affordances the types rely on', () => {
    const call = async (s: McpServer, name: string): Promise<CallToolResult> => {
        const response = await invoke(
            s,
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
            { classification: { era: 'legacy' } }
        );
        return ((await response.json()) as { result: CallToolResult }).result;
    };

    it('sends structuredContent as a JSON text block when content is omitted', async () => {
        const s = new McpServer({ name: 's', version: '1' });
        s.registerTool('obj', { outputSchema: z.object({ data: z.string() }) }, () => ({ structuredContent: { data: 'x' } }));
        s.registerTool('arr', { outputSchema: z.array(z.number()) }, () => ({ structuredContent: [1, 2] }));

        const obj = await call(s, 'obj');
        expect(obj.isError).toBeUndefined();
        expect(obj.content).toEqual([{ type: 'text', text: '{"data":"x"}' }]);
        expect(obj.structuredContent).toEqual({ data: 'x' });

        const arr = await call(s, 'arr');
        expect(arr.isError).toBeUndefined();
        expect(arr.content).toEqual([{ type: 'text', text: '[1,2]' }]);

        // Explicit content, even empty, is left alone.
        s.registerTool('empty', { outputSchema: z.object({ data: z.string() }) }, () => ({
            content: [],
            structuredContent: { data: 'x' }
        }));
        expect((await call(s, 'empty')).content).toEqual([]);
    });
});
