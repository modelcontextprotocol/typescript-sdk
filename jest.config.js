/** @type {import('jest').Config} **/
export default {
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^pkce-challenge$": "<rootDir>/src/__mocks__/pkce-challenge.ts"
  },
  transformIgnorePatterns: [
    "/node_modules/(?!eventsource)/"
  ],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  transform: {
    '^.+\\.(t|j)sx?$': '@swc/jest',
  },
};
