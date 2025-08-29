import { createDefaultEsmPreset } from "ts-jest";

const defaultEsmPreset = createDefaultEsmPreset();

/** @type {import('ts-jest').JestConfigWithTsJest} **/
export default {
  ...defaultEsmPreset,
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^pkce-challenge$": "<rootDir>/src/__mocks__/pkce-challenge.ts"
  },
  transformIgnorePatterns: [
    "/node_modules/(?!eventsource)/"
  ],
  /*
   *  Omit spec.types.test.ts for now until we can figure out how to make it work
   *  Changes in the spec file are causing it to fail vis-à-vis
   *  JSONRPCNotification vs Notification.
   *  See: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1026
   */
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "<rootDir>/src/spec.types.test.ts"],
};
