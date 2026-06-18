/**
 * Drives the tools example: list, inspect schemas + annotations, call,
 * assert structured output, assert an unknown tool errors.
 */
import { check, connectFromArgs, runClient } from '../harness.js';

runClient('tools', async () => {
    const client = await connectFromArgs(import.meta.dirname);

    const list = await client.listTools();
    const names = new Set(list.tools.map(t => t.name));
    check.ok(names.has('calc') && names.has('echo'), 'tools/list should contain calc and echo');

    const calc = list.tools.find(t => t.name === 'calc')!;
    check.equal(calc.annotations?.readOnlyHint, true);
    const required = (calc.inputSchema as { required?: string[] }).required ?? [];
    check.ok(required.includes('op') && required.includes('a') && required.includes('b'));
    check.ok(calc.outputSchema, 'calc should publish an outputSchema');

    const result = await client.callTool({ name: 'calc', arguments: { op: 'add', a: 2, b: 3 } });
    check.equal((result.structuredContent as { result?: number } | undefined)?.result, 5);
    check.equal((result.structuredContent as { op?: string } | undefined)?.op, 'add');

    const echo = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    check.equal(echo.content?.[0]?.type === 'text' ? echo.content[0].text : '', 'hi');
    check.equal(echo.structuredContent, undefined);

    // An unknown tool should be a tool error (isError) or a wire error — either is acceptable.
    let unknownFailed = false;
    try {
        const r = await client.callTool({ name: 'nope', arguments: {} });
        unknownFailed = !!r.isError;
    } catch {
        unknownFailed = true;
    }
    check.ok(unknownFailed, 'calling an unknown tool should fail');

    await client.close();
});
