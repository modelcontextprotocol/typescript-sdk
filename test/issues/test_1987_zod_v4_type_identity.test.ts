import { McpServer } from '../../src/server/mcp.js';

type ExternalZodV4Schema<Output, Input = Output> = {
    _zod: {
        output: Output;
        input: Input;
        def: { type: string };
    };
};

function assertTypechecks(callback: () => void): void {
    expect(typeof callback).toBe('function');
}

describe('Issue #1987: externally resolved Zod v4 schema types', () => {
    it('accepts raw shapes whose fields come from another compatible Zod v4 module identity', () => {
        assertTypechecks(() => {
            const server = new McpServer({ name: 'test', version: '1.0.0' });
            const name = {} as ExternalZodV4Schema<string>;
            const age = {} as ExternalZodV4Schema<number | undefined, number | undefined>;

            server.registerTool(
                'example',
                {
                    inputSchema: { name, age }
                },
                async ({ name, age }) => {
                    const upperName: string = name.toUpperCase();
                    const maybeAge: number | undefined = age;

                    return { content: [{ type: 'text', text: `${upperName} ${maybeAge ?? ''}` }] };
                }
            );
        });
    });
});
