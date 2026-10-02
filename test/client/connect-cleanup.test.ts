import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const cleanup of ['resolve', 'reject', 'deferred-reject', 'pending']) {
    test(`given ${cleanup} cleanup, when initialization fails, then connect preserves the error without an unhandled rejection`, () => {
        const child = spawnSync(
            process.execPath,
            [
                '--unhandled-rejections=strict',
                '--import',
                'tsx',
                fileURLToPath(new URL('./fixtures/connect-cleanup.ts', import.meta.url)),
                cleanup
            ],
            { encoding: 'utf8', timeout: 10_000 }
        );

        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status, child.stdout + child.stderr).toBe(0);
        expect(child.stderr).toBe('');
        expect(child.stdout).toBe('Original initialization error preserved; cleanup rejection handled.\n');
    });
}
