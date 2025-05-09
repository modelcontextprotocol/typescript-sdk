import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./types.js";

describe("Types", () => {

    test("should have correct latest protocol version", () => {
        expect(LATEST_PROTOCOL_VERSION).toBeDefined();
        expect(LATEST_PROTOCOL_VERSION).toBe("DRAFT-2025-v2");
    });
    test("should have correct supported protocol versions", () => {
        expect(SUPPORTED_PROTOCOL_VERSIONS).toBeDefined();
        expect(SUPPORTED_PROTOCOL_VERSIONS).toBeInstanceOf(Array);
        expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(LATEST_PROTOCOL_VERSION);
        expect(SUPPORTED_PROTOCOL_VERSIONS).toContain("2024-11-05");
        expect(SUPPORTED_PROTOCOL_VERSIONS).toContain("2024-10-07");
    });

});
