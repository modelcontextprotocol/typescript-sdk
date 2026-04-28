// Run with: pnpm tsx src/legacyClassDecoratorsExample.ts
//
// Demonstrates authoring MCP tools, resources, and prompts as methods on a
// class, using lightweight `@McpTool` / `@McpResource` / `@McpResourceTemplate`
// / `@McpPrompt` decorators plus a `registerClass()` helper that wires an
// instance into an `McpServer`.
//
// This file uses **legacy TypeScript decorators** (the ones enabled by
// `experimentalDecorators: true` in the package tsconfig). For the TC39
// Stage-3 / "standard" version of the same pattern, see
// `classDecoratorsExample.ts`, which compiles under its own
// `tsconfig.standard-decorators.json`.
//
// Decorator metadata is stored on the class prototype (no reflect-metadata,
// no extra dependency). The file is self-contained — copy the ~60 lines of
// decorator plumbing into your own project to reuse the pattern.

import type {
    CallToolResult,
    GetPromptResult,
    Prompt,
    PromptCallback,
    ReadResourceCallback,
    ReadResourceResult,
    ReadResourceTemplateCallback,
    Resource,
    ResourceTemplateType,
    ServerContext,
    Tool,
    ToolCallback,
    Variables
} from '@modelcontextprotocol/server';
import { McpServer, ResourceTemplate, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// ─── Decorator config shapes ──────────────────────────────────────────────
//
// Each config is derived from the matching MCP spec type — `Tool`,
// `Prompt`, `Resource`, `ResourceTemplateType` — via `Omit<…, identity>`.
// That way any spec-level field (annotations, `_meta`, `size`, …) shows
// up in the decorator config automatically. Caveat: What properties get
// registered will ultimately depend on how the internals of the registerTool,
// registerPrompt, registerResource method work.
//
// Schema fields (`inputSchema` / `outputSchema` / `argsSchema`) are the
// exception: we replace the spec's JSON-Schema shape with a generic
// `S extends AnyZodObject` so `registerTool` / `registerPrompt` can infer
// `InputArgs` / `Args` from a Zod schema at the call site in
// `registerClass`. Keeping them generic also lets the decorator check at
// decoration time that the method signature matches the declared schema.

type AnyZodObject = z.ZodObject<z.ZodRawShape>;

type ToolConfig<S extends AnyZodObject | undefined = undefined> = {
    name: string;
    inputSchema?: S;
    outputSchema?: AnyZodObject;
} & Omit<Tool, 'name' | 'inputSchema' | 'outputSchema'>;

type PromptConfig<S extends AnyZodObject | undefined = undefined> = {
    name: string;
    argsSchema?: S;
} & Omit<Prompt, 'name' | 'arguments'>;

type ResourceConfig = { name: string; uri: string } & Omit<Resource, 'name' | 'uri'>;

type ResourceTemplateConfig = { name: string; template: ResourceTemplate } & Omit<ResourceTemplateType, 'name' | 'uriTemplate'>;

type ToolEntry = { config: ToolConfig<AnyZodObject>; method: ToolCallback<AnyZodObject> };
type PromptEntry = { config: PromptConfig<AnyZodObject>; method: PromptCallback<AnyZodObject> };
type ResourceEntry = { config: ResourceConfig; method: ReadResourceCallback };
type ResourceTemplateEntry = { config: ResourceTemplateConfig; method: ReadResourceTemplateCallback };

type ClassMeta = {
    __mcpTools?: ToolEntry[];
    __mcpResources?: ResourceEntry[];
    __mcpResourceTemplates?: ResourceTemplateEntry[];
    __mcpPrompts?: PromptEntry[];
};

// ─── Decorators (legacy TS method decorators) ─────────────────────────────
//
// Each decorator is generic over the schema type, so TypeScript can check
// at decoration time that the method signature matches the declared
// schema. We then widen to `AnyZodObject` when storing on the prototype —
// the per-method generic can't survive a heterogeneous array, but the
// check has already happened at the use site.
//
// The per-class arrays are stored as own-properties on the class's
// prototype. Because `B.prototype`'s `[[Prototype]]` is `A.prototype`, a
// naive `proto.__mcpTools ??= []` on a subclass would read through the
// chain, find the parent's array, short-circuit, and mutate it in
// place — leaking subclass tools into the parent. `ownArray()` clones
// the inherited array on first write so each class gets its own copy
// and subclasses end up with `[...parentEntries, ...ownEntries]`.

function protoOf(target: object): ClassMeta {
    return (target as { constructor: { prototype: ClassMeta } }).constructor.prototype;
}

function ownArray<K extends keyof ClassMeta>(proto: ClassMeta, key: K): NonNullable<ClassMeta[K]> {
    if (!Object.hasOwn(proto, key)) {
        proto[key] = [...(proto[key] ?? [])] as ClassMeta[K];
    }
    return proto[key] as NonNullable<ClassMeta[K]>;
}

export function McpTool<S extends AnyZodObject | undefined = undefined>(config: ToolConfig<S>) {
    return <M extends ToolCallback<S>>(target: object, _key: string | symbol, descriptor: TypedPropertyDescriptor<M>): void => {
        if (!descriptor.value) throw new Error(`@McpTool: method is undefined`);
        ownArray(protoOf(target), '__mcpTools').push({
            config: config as ToolConfig<AnyZodObject>,
            method: descriptor.value as unknown as ToolCallback<AnyZodObject>
        });
    };
}

export function McpPrompt<S extends AnyZodObject | undefined = undefined>(config: PromptConfig<S>) {
    return <M extends PromptCallback<S>>(target: object, _key: string | symbol, descriptor: TypedPropertyDescriptor<M>): void => {
        if (!descriptor.value) throw new Error(`@McpPrompt: method is undefined`);
        ownArray(protoOf(target), '__mcpPrompts').push({
            config: config as PromptConfig<AnyZodObject>,
            method: descriptor.value as unknown as PromptCallback<AnyZodObject>
        });
    };
}

export function McpResource(config: ResourceConfig) {
    return <M extends ReadResourceCallback>(target: object, _key: string | symbol, descriptor: TypedPropertyDescriptor<M>): void => {
        if (!descriptor.value) throw new Error(`@McpResource: method is undefined`);
        ownArray(protoOf(target), '__mcpResources').push({ config, method: descriptor.value });
    };
}

export function McpResourceTemplate(config: ResourceTemplateConfig) {
    return <M extends ReadResourceTemplateCallback>(
        target: object,
        _key: string | symbol,
        descriptor: TypedPropertyDescriptor<M>
    ): void => {
        if (!descriptor.value) throw new Error(`@McpResourceTemplate: method is undefined`);
        ownArray(protoOf(target), '__mcpResourceTemplates').push({ config, method: descriptor.value });
    };
}

// ─── Registration helper ──────────────────────────────────────────────────
//
// Walks one level of the instance prototype and registers every decorated
// method with the given `McpServer`. Methods are bound to the instance so
// `this` works as expected.

export function registerClass(server: McpServer, instance: object): void {
    const proto = Object.getPrototypeOf(instance) as ClassMeta;

    for (const { config, method } of proto.__mcpTools ?? []) {
        const { name, ...rest } = config;
        server.registerTool(name, rest, method.bind(instance));
    }
    for (const { config, method } of proto.__mcpResources ?? []) {
        const { name, uri, ...metadata } = config;
        server.registerResource(name, uri, metadata, method.bind(instance));
    }
    for (const { config, method } of proto.__mcpResourceTemplates ?? []) {
        const { name, template, ...metadata } = config;
        server.registerResource(name, template, metadata, method.bind(instance));
    }
    for (const { config, method } of proto.__mcpPrompts ?? []) {
        const { name, ...rest } = config;
        server.registerPrompt(name, rest, method.bind(instance));
    }
}

// ─── Example class ────────────────────────────────────────────────────────

class GreetingController {
    constructor(private readonly salutation: string) {}

    @McpTool({
        name: 'greet',
        description: 'Greet someone by name',
        inputSchema: z.object({
            name: z.string().describe('Name to greet')
        })
    })
    greet({ name }: { name: string }): CallToolResult {
        return {
            content: [{ type: 'text', text: `${this.salutation}, ${name}!` }]
        };
    }

    @McpTool({
        name: 'whoami',
        description: 'Return the current session id, if any'
    })
    whoami(ctx: ServerContext): CallToolResult {
        return {
            content: [{ type: 'text', text: `session: ${ctx.sessionId ?? '<stateless>'}` }]
        };
    }

    @McpResource({
        name: 'greeter-info',
        uri: 'greeter://info',
        description: 'Static metadata about the greeter',
        mimeType: 'text/plain'
    })
    getInfo(uri: URL): ReadResourceResult {
        return {
            contents: [{ uri: uri.href, mimeType: 'text/plain', text: `salutation=${this.salutation}` }]
        };
    }

    @McpResourceTemplate({
        name: 'greeting',
        template: new ResourceTemplate('greeting://{name}', { list: undefined }),
        description: 'Personalised greeting resource',
        mimeType: 'text/plain'
    })
    readGreeting(uri: URL, variables: Variables): ReadResourceResult {
        const raw = variables.name;
        const name = Array.isArray(raw) ? raw.join(', ') : (raw ?? 'friend');
        return {
            contents: [{ uri: uri.href, mimeType: 'text/plain', text: `${this.salutation}, ${name}!` }]
        };
    }

    @McpPrompt({
        name: 'introduce',
        description: 'Prompt the LLM to introduce a person',
        argsSchema: z.object({
            name: z.string().describe('Who to introduce')
        })
    })
    introduce({ name }: { name: string }): GetPromptResult {
        return {
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Say "${this.salutation}, ${name}!" and share a one-line fun fact about them.`
                    }
                }
            ]
        };
    }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'class-decorators-example',
    version: '1.0.0'
});

registerClass(server, new GreetingController('Hello'));

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP server is running...');
}

try {
    await main();
} catch (error) {
    console.error('Server error:', error);
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}
