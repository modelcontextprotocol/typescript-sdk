/**
 * Node.js runtime shims for server package
 *
 * This file is selected via package.json export conditions when running in Node.js.
 */
export { AjvJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/core';
export { default as process } from 'node:process';
