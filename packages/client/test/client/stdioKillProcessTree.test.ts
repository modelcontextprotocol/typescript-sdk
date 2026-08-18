import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { StdioClientTransport } from '../../src/client/stdio';

test('killProcessTree terminates grandchildren spawned by a wrapper', async () => {
    // The npx/uvx anatomy: the direct child is a wrapper that spawns the real server.
    // Without process-group teardown the grandchild outlives close() as an orphan.
    if (process.platform === 'win32') return; // taskkill path is covered manually

    const pidFile = `${tmpdir()}/mcp-tree-${process.pid}-${Date.now()}`;
    const WRAPPER_SCRIPT = String.raw`
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
        setInterval(() => {}, 1000);
    `;

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['-e', WRAPPER_SCRIPT],
        killProcessTree: true
    });
    await transport.start();

    while (!existsSync(pidFile)) await new Promise(resolve => setTimeout(resolve, 25));
    const grandchildPid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(grandchildPid, 0)).not.toThrow();

    await transport.close();

    // The group signal is delivered asynchronously; give it a moment to land.
    for (let i = 0; i < 40; i++) {
        try {
            process.kill(grandchildPid, 0);
        } catch {
            return; // gone — the tree was reaped
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`grandchild ${grandchildPid} survived close()`);
}, 15_000);
