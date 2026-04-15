// Run with:
//   pnpm tsx --tsconfig=tsconfig.standard-decorators.json src/classDecoratorsExample.ts
//
// TC39 Stage-3 ("standard") decorator version of the class-based MCP
// pattern. Same call sites as `legacyClassDecoratorsExample.ts` — the
// difference is entirely in how each decorator body receives its arguments
// and where metadata is stashed:
//
//   - Legacy decorators: `(target, propertyKey, descriptor)`, metadata
//     pushed onto `target.constructor.prototype.__mcpTools`.
//   - Standard decorators: `(value, context)`, metadata written to the
//     `context.metadata` object — which the runtime hangs off the class
//     at `Symbol.metadata` after class initialisation. A subclass's
//     metadata object inherits from the parent's via the prototype
//     chain, so subclasses see base-class entries — but writes must be
//     copy-on-write to avoid mutating the parent's arrays in place
//     (see `ownArray()` below).
//
// `experimentalDecorators` is a project-wide TypeScript setting, so this
// file compiles under a dedicated `tsconfig.standard-decorators.json`
// that sets it to `false`. The main package tsconfig excludes this file.

// Stage-3 decorator metadata uses `Symbol.metadata`. Node < 22 does not
// ship it yet, so register it if missing. TypeScript's decorator emit
// writes to `ctor[Symbol.metadata]` during class initialisation and will
// crash without this polyfill on older Node.
((Symbol as { metadata?: symbol }).metadata as symbol | undefined) ??= Symbol.for('Symbol.metadata');

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

// ─── Decorator config shapes ─────────────────────────────────────────────
//
// Identical to the legacy version — these types are independent of
// decorator mode. See `legacyClassDecoratorsExample.ts` for the full
// derivation commentary.

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

type McpClassMetadata = {
    __mcpTools?: ToolEntry[];
    __mcpResources?: ResourceEntry[];
    __mcpResourceTemplates?: ResourceTemplateEntry[];
    __mcpPrompts?: PromptEntry[];
};

// ─── Decorators (TC39 Stage-3 method decorators) ─────────────────────────
//
// `context.metadata` is a per-class object shared by every decorator on
// the same class. The runtime attaches it to the constructor at
// `Symbol.metadata` once initialisation finishes. For a subclass, the
// runtime creates `Object.create(parent[Symbol.metadata])`, so *reads*
// transparently walk the prototype chain — subclasses see base-class
// entries for free — but *writes* must be own-properties or they silently
// mutate the parent's array. `ownArray()` below enforces copy-on-write:
// on first write in a given class it clones the inherited array, so
// subclasses end up with `[...parentEntries, ...ownEntries]` and the
// parent stays untouched.

function metaOf(context: ClassMethodDecoratorContext): McpClassMetadata {
    return context.metadata as McpClassMetadata;
}

function ownArray<K extends keyof McpClassMetadata>(meta: McpClassMetadata, key: K): NonNullable<McpClassMetadata[K]> {
    if (!Object.hasOwn(meta, key)) {
        meta[key] = [...(meta[key] ?? [])] as McpClassMetadata[K];
    }
    return meta[key] as NonNullable<McpClassMetadata[K]>;
}

export function McpTool<S extends AnyZodObject | undefined = undefined>(config: ToolConfig<S>) {
    return (value: ToolCallback<S>, context: ClassMethodDecoratorContext): void => {
        ownArray(metaOf(context), '__mcpTools').push({
            config: config as ToolConfig<AnyZodObject>,
            method: value as unknown as ToolCallback<AnyZodObject>
        });
    };
}

export function McpPrompt<S extends AnyZodObject | undefined = undefined>(config: PromptConfig<S>) {
    return (value: PromptCallback<S>, context: ClassMethodDecoratorContext): void => {
        ownArray(metaOf(context), '__mcpPrompts').push({
            config: config as PromptConfig<AnyZodObject>,
            method: value as unknown as PromptCallback<AnyZodObject>
        });
    };
}

export function McpResource(config: ResourceConfig) {
    return (value: ReadResourceCallback, context: ClassMethodDecoratorContext): void => {
        ownArray(metaOf(context), '__mcpResources').push({ config, method: value });
    };
}

export function McpResourceTemplate(config: ResourceTemplateConfig) {
    return (value: ReadResourceTemplateCallback, context: ClassMethodDecoratorContext): void => {
        ownArray(metaOf(context), '__mcpResourceTemplates').push({ config, method: value });
    };
}

// ─── Registration helper ─────────────────────────────────────────────────
//
// Pulls the class's metadata object off `Symbol.metadata` and registers
// each decorated method with the given `McpServer`.

export function registerClass(server: McpServer, instance: object): void {
    const ctor = instance.constructor as { [Symbol.metadata]?: McpClassMetadata };
    const meta = ctor[Symbol.metadata];
    if (!meta) return;

    for (const { config, method } of meta.__mcpTools ?? []) {
        const { name, ...rest } = config;
        server.registerTool(name, rest, method.bind(instance));
    }
    for (const { config, method } of meta.__mcpResources ?? []) {
        const { name, uri, ...metadata } = config;
        server.registerResource(name, uri, metadata, method.bind(instance));
    }
    for (const { config, method } of meta.__mcpResourceTemplates ?? []) {
        const { name, template, ...metadata } = config;
        server.registerResource(name, template, metadata, method.bind(instance));
    }
    for (const { config, method } of meta.__mcpPrompts ?? []) {
        const { name, ...rest } = config;
        server.registerPrompt(name, rest, method.bind(instance));
    }
}

// ─── Example class ───────────────────────────────────────────────────────
//
// Call sites are identical to the legacy version — `@McpTool({ ... })`
// and friends look the same regardless of decorator mode.

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

// ─── Bootstrap ───────────────────────────────────────────────────────────

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
