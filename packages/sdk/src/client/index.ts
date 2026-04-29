export * from '@modelcontextprotocol/client';
// Shadow with v1-compat subclass (later export wins for `export *` collisions)
export { Client } from '../compatWrappers.js';
