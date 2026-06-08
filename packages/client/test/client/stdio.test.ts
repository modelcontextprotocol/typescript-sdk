import type { JSONRPCMessage } from '@modelcontextprotocol/core';

import type { StdioServerParameters } from '../../src/client/stdio.js';
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '../../src/client/stdio.js';

// Configure default server parameters based on OS
// Uses 'more' command for Windows and 'tee' command for Unix/Linux
const getDefaultServerParameters = (): StdioServerParameters => {
    if (process.platform === 'win32') {
        return { command: 'more' };
    }
    return { command: '/usr/bin/tee' };
};

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

test('DEFAULT_INHERITED_ENV_VARS matches the host platform', () => {
    if (process.platform === 'win32') {
        // Variables Windows tooling needs to resolve executables and shells.
        // Missing PATHEXT or COMSPEC causes spawn ENOENT for npm/git/etc.
        expect(DEFAULT_INHERITED_ENV_VARS).toEqual(
            expect.arrayContaining([
                'APPDATA',
                'COMSPEC',
                'HOMEDRIVE',
                'HOMEPATH',
                'LOCALAPPDATA',
                'PATH',
                'PATHEXT',
                'PROCESSOR_ARCHITECTURE',
                'PROGRAMFILES',
                'PROGRAMFILES(X86)',
                'PROGRAMW6432',
                'SYSTEMDRIVE',
                'SYSTEMROOT',
                'TEMP',
                'USERNAME',
                'USERPROFILE',
                'WINDIR'
            ])
        );
    } else {
        expect(DEFAULT_INHERITED_ENV_VARS).toEqual(['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER']);
    }
});
