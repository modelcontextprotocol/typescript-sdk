/**
 * Calls each greet variant and asserts every inputSchema published as a JSON
 * Schema with a required `name` string; calls `get-weather` and asserts the
 * structured output matches.
 */
import { check, connectFromArgs, runClient } from '../harness.js';

runClient('schema-validators', async () => {
    // connectFromArgs picks transport (default: spawn ./server.ts over stdio; --http <url>) and era (--legacy) from argv. Your code would construct a Client and connect over your chosen transport directly.
    const client = await connectFromArgs(import.meta.dirname);

    const list = await client.listTools();
    for (const name of ['greet-zod', 'greet-arktype', 'greet-valibot']) {
        const tool = list.tools.find(t => t.name === name);
        check.ok(tool, `${name} should be listed`);
        const required = (tool!.inputSchema as { required?: string[] }).required ?? [];
        check.ok(required.includes('name'), `${name} inputSchema should require 'name'`);
        const result = await client.callTool({ name, arguments: { name: 'world' } });
        check.match(result.content?.[0]?.type === 'text' ? result.content[0].text : '', /Hello, world!/);
    }

    const weather = await client.callTool({ name: 'get-weather', arguments: { city: 'Tokyo' } });
    const sc = weather.structuredContent as { city?: string; conditions?: string; celsius?: number } | undefined;
    check.equal(sc?.city, 'Tokyo');
    check.equal(sc?.conditions, 'sunny');
    check.equal(sc?.celsius, 21);

    await client.close();
});
