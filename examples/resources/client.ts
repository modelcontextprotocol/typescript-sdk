/**
 * Drives the resources example: list, list templates, read direct + templated.
 */
import { check, connectFromArgs, runClient } from '../harness.js';

runClient('resources', async () => {
    // connectFromArgs picks transport (default: spawn ./server.ts over stdio; --http <url>) and era (--legacy) from argv. Your code would construct a Client and connect over your chosen transport directly.
    const client = await connectFromArgs(import.meta.dirname);

    const list = await client.listResources();
    check.ok(list.resources.some(r => r.uri === 'config://app'));

    const templates = await client.listResourceTemplates();
    check.ok(templates.resourceTemplates.some(t => t.uriTemplate === 'greeting://{name}'));

    const config = await client.readResource({ uri: 'config://app' });
    const configContent = config.contents[0];
    check.equal(configContent && 'text' in configContent ? configContent.text : '', '{"feature":true}');

    const hello = await client.readResource({ uri: 'greeting://world' });
    const helloContent = hello.contents[0];
    check.equal(helloContent && 'text' in helloContent ? helloContent.text : '', 'Hello, world!');

    await client.close();
});
