import type { JSONRPCMessage } from '../../src/types.js';
import { ReadBuffer } from '../../src/shared/stdio.js';

const testMessage: JSONRPCMessage = {
    jsonrpc: '2.0',
    method: 'foobar'
};

test('should have no messages after initialization', () => {
    const readBuffer = new ReadBuffer();
    expect(readBuffer.readMessage()).toBeNull();
});

test('should only yield a message after a newline', () => {
    const readBuffer = new ReadBuffer();

    readBuffer.append(Buffer.from(JSON.stringify(testMessage)));
    expect(readBuffer.readMessage()).toBeNull();

    readBuffer.append(Buffer.from('\n'));
    expect(readBuffer.readMessage()).toEqual(testMessage);
    expect(readBuffer.readMessage()).toBeNull();
});

test('should be reusable after clearing', () => {
    const readBuffer = new ReadBuffer();

    readBuffer.append(Buffer.from('foobar'));
    readBuffer.clear();
    expect(readBuffer.readMessage()).toBeNull();

    readBuffer.append(Buffer.from(JSON.stringify(testMessage)));
    readBuffer.append(Buffer.from('\n'));
    expect(readBuffer.readMessage()).toEqual(testMessage);
});

describe('non-JSON line filtering', () => {
    test('should filter out non-JSON lines before a complete message', () => {
        const readBuffer = new ReadBuffer();

        // Append debug output followed by a valid JSON message
        const mixedContent = 'Debug: Starting server\n' + 'Warning: Something happened\n' + JSON.stringify(testMessage) + '\n';

        readBuffer.append(Buffer.from(mixedContent));

        // Should only get the valid JSON message, debug lines filtered out
        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should filter out non-JSON lines mixed with multiple valid messages', () => {
        const readBuffer = new ReadBuffer();

        const message1: JSONRPCMessage = { jsonrpc: '2.0', method: 'method1' };
        const message2: JSONRPCMessage = { jsonrpc: '2.0', method: 'method2' };

        const mixedContent =
            'Debug line 1\n' +
            JSON.stringify(message1) +
            '\n' +
            'Debug line 2\n' +
            'Another non-JSON line\n' +
            JSON.stringify(message2) +
            '\n';

        readBuffer.append(Buffer.from(mixedContent));

        expect(readBuffer.readMessage()).toEqual(message1);
        expect(readBuffer.readMessage()).toEqual(message2);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should preserve incomplete JSON line at end of buffer', () => {
        const readBuffer = new ReadBuffer();

        // Append incomplete JSON (no closing brace or newline)
        const incompleteJson = '{"jsonrpc": "2.0", "method": "test"';
        readBuffer.append(Buffer.from(incompleteJson));

        expect(readBuffer.readMessage()).toBeNull();

        // Complete the JSON in next chunk
        readBuffer.append(Buffer.from('}\n'));

        const expectedMessage: JSONRPCMessage = { jsonrpc: '2.0', method: 'test' };
        expect(readBuffer.readMessage()).toEqual(expectedMessage);
    });

    test('should handle lines that start with { but do not end with }', () => {
        const readBuffer = new ReadBuffer();

        const content = '{incomplete\n' + JSON.stringify(testMessage) + '\n';

        readBuffer.append(Buffer.from(content));

        // Should only get the valid message, incomplete line filtered out
        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should handle lines that end with } but do not start with {', () => {
        const readBuffer = new ReadBuffer();

        const content = 'incomplete}\n' + JSON.stringify(testMessage) + '\n';

        readBuffer.append(Buffer.from(content));

        // Should only get the valid message, incomplete line filtered out
        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should handle lines with leading/trailing whitespace around valid JSON', () => {
        const readBuffer = new ReadBuffer();

        const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test' };
        const content = '  ' + JSON.stringify(message) + '  \n';

        readBuffer.append(Buffer.from(content));

        expect(readBuffer.readMessage()).toEqual(message);
    });
});
