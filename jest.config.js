import { createDefaultEsmPreset } from "ts-jest";

const defaultEsmPreset = createDefaultEsmPreset();

/** @type {import('ts-jest').JestConfigWithTsJest} **/
export default {
  ...defaultEsmPreset,
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^pkce-challenge$": "<rootDir>/src/__mocks__/pkce-challenge.ts",
    "^standard-json-schema$": "<rootDir>/node_modules/standard-json-schema/cjs/index.js"
  },
  transformIgnorePatterns: [
    "/node_modules/(?!eventsource|standard-json-schema)/"
  ],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
};
