import type { Migration } from '../../types';
import { v1ToV2Transforms } from './transforms/index';

export const v1ToV2Migration: Migration = {
    name: 'v1-to-v2',
    description: 'Migrate from @modelcontextprotocol/sdk (v1) to v2 packages (@modelcontextprotocol/client, /server, etc.)',
    transforms: v1ToV2Transforms
};
