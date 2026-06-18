/**
 * Drives the prompts example: list, complete an argument, get a prompt.
 */
import { check, connectFromArgs, runClient } from '../harness.js';

runClient('prompts', async () => {
    const client = await connectFromArgs(import.meta.dirname);

    const list = await client.listPrompts();
    check.ok(list.prompts.some(p => p.name === 'review-code'));

    const completion = await client.complete({
        ref: { type: 'ref/prompt', name: 'review-code' },
        argument: { name: 'language', value: 'ty' }
    });
    check.ok(completion.completion.values.includes('typescript'));

    const got = await client.getPrompt({ name: 'review-code', arguments: { language: 'rust', code: 'fn main() {}' } });
    check.equal(got.messages.length, 1);
    const text = got.messages[0]?.content.type === 'text' ? got.messages[0].content.text : '';
    check.match(text, /Review this rust code/);

    await client.close();
});
