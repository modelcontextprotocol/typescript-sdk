import type { Migration } from '../types.js';
import { v1ToV2Migration } from './v1-to-v2/index.js';

const migrations = new Map<string, Migration>([['v1-to-v2', v1ToV2Migration]]);

export function getMigration(name: string): Migration | undefined {
    return migrations.get(name);
}

export function listMigrations(): Map<string, Migration> {
    return migrations;
}
