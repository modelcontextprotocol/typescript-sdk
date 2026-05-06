import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { execSync } from 'node:child_process';

import type { StdioServerParameters } from '../../src/client/stdio.js';
import { StdioClientTransport } from '../../src/client/stdio.js';

const isUnix = process.platform !== 'win32';

function getDefaultServerParameters(): StdioServerParameters {
    if (process.platform === 'win32') {
        return { command: 'more' };
    }
    return { command: '/usr/bin/tee' };
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function getChildPids(parentPid: number): number[] {
    return execSync(`pgrep -P ${parentPid} 2>/dev/null || true`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean).map(Number);
}

function getAllDescendantPids(rootPid: number): number[] {
    const result: number[] = [];
    const queue = [rootPid];
    while (queue.length > 0) {
        const pid = queue.shift()!;
        const children = getChildPids(pid);
        result.push(...children);
        queue.push(...children);
    }
    return result;
}

const serverParameters = getDefaultServerParameters();

test('should start then close cleanly', async () => {
    const client = new StdioClientTransport(serverParameters);
    client.onerror = error => {
        throw error;
    };

    let didClose = false;
    client.onclose = () => {
        didClose = true;
    };

    await client.start();
    expect(didClose).toBeFalsy();
    await client.close();
    expect(didClose).toBeTruthy();
});

test('should read messages', async () => {
    const client = new StdioClientTransport(serverParameters);
    client.onerror = error => {
        throw error;
    };

    const messages: JSONRPCMessage[] = [
        {
            jsonrpc: '2.0',
            id: 1,
            method: 'ping'
        },
        {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
        }
    ];

    const readMessages: JSONRPCMessage[] = [];
    const finished = new Promise<void>(resolve => {
        client.onmessage = message => {
            readMessages.push(message);

            if (JSON.stringify(message) === JSON.stringify(messages[1])) {
                resolve();
            }
        };
    });

    await client.start();
    await client.send(messages[0]!);
    await client.send(messages[1]!);
    await finished;
    expect(readMessages).toEqual(messages);

    await client.close();
});

test('should return child process pid', async () => {
    const client = new StdioClientTransport(serverParameters);

    await client.start();
    expect(client.pid).not.toBeNull();
    await client.close();
    expect(client.pid).toBeNull();
});

test.skipIf(!isUnix)('should kill child process tree on close', async () => {
    const client = new StdioClientTransport({
        command: '/bin/sh',
        args: ['-c', 'sleep 300 & wait']
    });

    await client.start();
    const parentPid = client.pid!;
    expect(parentPid).not.toBeNull();

    const grandchildPids = getChildPids(parentPid);
    expect(grandchildPids.length).toBeGreaterThan(0);

    await client.close();

    expect(isProcessAlive(parentPid)).toBe(false);
    for (const gPid of grandchildPids) {
        expect(isProcessAlive(gPid)).toBe(false);
    }
});

test.skipIf(!isUnix)('should kill multiple grandchildren on close', async () => {
    const client = new StdioClientTransport({
        command: '/bin/sh',
        args: ['-c', 'sleep 301 & sleep 302 & sleep 303 & wait']
    });

    await client.start();
    const parentPid = client.pid!;

    const grandchildPids = getChildPids(parentPid);
    expect(grandchildPids.length).toBe(3);

    await client.close();

    expect(isProcessAlive(parentPid)).toBe(false);
    for (const gPid of grandchildPids) {
        expect(isProcessAlive(gPid)).toBe(false);
    }
});

test.skipIf(!isUnix)('should kill a 3-level deep process tree on close', async () => {
    const client = new StdioClientTransport({
        command: '/bin/sh',
        args: ['-c', '/bin/sh -c "sleep 304 & wait" & wait']
    });

    await client.start();
    const rootPid = client.pid!;

    // Give the nested shell time to spawn its children
    await new Promise(resolve => setTimeout(resolve, 500));

    const allDescendants = getAllDescendantPids(rootPid);
    expect(allDescendants.length).toBeGreaterThanOrEqual(2);

    await client.close();

    expect(isProcessAlive(rootPid)).toBe(false);
    for (const pid of allDescendants) {
        expect(isProcessAlive(pid)).toBe(false);
    }
});

test.skipIf(!isUnix)('should fire onclose callback when killing process tree', async () => {
    const client = new StdioClientTransport({
        command: '/bin/sh',
        args: ['-c', 'sleep 305 & wait']
    });

    let didClose = false;
    client.onclose = () => {
        didClose = true;
    };

    await client.start();
    await client.close();

    expect(didClose).toBe(true);
});

test('should not throw when closing an already-exited process', async () => {
    const client = new StdioClientTransport(
        isUnix ? { command: '/bin/sh', args: ['-c', 'exit 0'] } : { command: 'cmd.exe', args: ['/c', 'exit 0'] }
    );

    await client.start();

    // Wait for the process to exit on its own
    await new Promise(resolve => setTimeout(resolve, 500));

    await expect(client.close()).resolves.toBeUndefined();
});

test('should not throw when close is called twice', async () => {
    const client = new StdioClientTransport(serverParameters);

    await client.start();
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
});

test('should not throw when close is called without start', async () => {
    const client = new StdioClientTransport(serverParameters);
    await expect(client.close()).resolves.toBeUndefined();
});
