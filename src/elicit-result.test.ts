/**
 * Tests for ElicitResult schema validation
 * 
 * This test suite specifically validates that ElicitResult handles the GitHub issue:
 * "ElicitResultSchema violates MCP Specs" where content: null was incorrectly rejected
 * for cancel/decline responses.
 * 
 * GitHub Issue: https://github.com/modelcontextprotocol/typescript-sdk/issues/966
 */

import { ElicitResultSchema } from "./types.js";

describe("ElicitResult Schema", () => {
  describe("MCP Spec Compliance", () => {
    it("should accept content: null for cancel responses (GitHub issue fix)", () => {
      const result = { action: "cancel", content: null };
      expect(() => ElicitResultSchema.parse(result)).not.toThrow();
      
      const parsed = ElicitResultSchema.parse(result);
      expect(parsed.action).toBe("cancel");
      expect(parsed.content).toBe(null);
    });

    it("should accept content: null for decline responses (GitHub issue fix)", () => {
      const result = { action: "decline", content: null };
      expect(() => ElicitResultSchema.parse(result)).not.toThrow();
      
      const parsed = ElicitResultSchema.parse(result);
      expect(parsed.action).toBe("decline");
      expect(parsed.content).toBe(null);
    });

    it("should accept omitted content for cancel responses", () => {
      const result = { action: "cancel" };
      expect(() => ElicitResultSchema.parse(result)).not.toThrow();
      
      const parsed = ElicitResultSchema.parse(result);
      expect(parsed.action).toBe("cancel");
      expect(parsed.content).toBeUndefined();
    });

    it("should accept omitted content for decline responses", () => {
      const result = { action: "decline" };
      expect(() => ElicitResultSchema.parse(result)).not.toThrow();
      
      const parsed = ElicitResultSchema.parse(result);
      expect(parsed.action).toBe("decline");
      expect(parsed.content).toBeUndefined();
    });

    it("should accept empty object content for cancel/decline responses", () => {
      const cancelResult = { action: "cancel", content: {} };
      const declineResult = { action: "decline", content: {} };
      
      expect(() => ElicitResultSchema.parse(cancelResult)).not.toThrow();
      expect(() => ElicitResultSchema.parse(declineResult)).not.toThrow();
    });
  });

  describe("Accept Action Validation", () => {
    it("should require content for accept responses", () => {
      const result = { action: "accept" };
      expect(() => ElicitResultSchema.parse(result)).toThrow();
    });

    it("should accept valid content for accept responses", () => {
      const result = {
        action: "accept",
        content: {
          choice: "yes",
          reason: "Testing"
        }
      };
      
      expect(() => ElicitResultSchema.parse(result)).not.toThrow();
      
      const parsed = ElicitResultSchema.parse(result);
      expect(parsed.action).toBe("accept");
      expect(parsed.content).toEqual({
        choice: "yes", 
        reason: "Testing"
      });
    });

    it("should accept various primitive types in accept content", () => {
      const result = {
        action: "accept",
        content: {
          stringField: "text",
          numberField: 42,
          booleanField: true
        }
      };
      
      expect(() => ElicitResultSchema.parse(result)).not.toThrow();
      
      const parsed = ElicitResultSchema.parse(result);
      expect(parsed.content).toEqual({
        stringField: "text",
        numberField: 42,
        booleanField: true
      });
    });
  });

  describe("Flexibility Requirements", () => {
    it("should support 'typically omitted' flexibility as per MCP spec", () => {
      // Test all the patterns that should work according to MCP spec
      const patterns = [
        { action: "cancel" },                    // omitted
        { action: "cancel", content: null },     // explicit null
        { action: "cancel", content: {} },       // empty object
        { action: "decline" },                   // omitted
        { action: "decline", content: null },    // explicit null
        { action: "decline", content: {} },      // empty object
      ];

      patterns.forEach((pattern, index) => {
        expect(() => ElicitResultSchema.parse(pattern)).not.toThrow(
          `Pattern ${index + 1} should be valid: ${JSON.stringify(pattern)}`
        );
      });
    });

    it("should maintain backward compatibility with existing code patterns", () => {
      // These patterns were already working and should continue to work
      const workingPatterns = [
        { action: "cancel" },
        { action: "cancel", content: {} },
        { action: "decline" },
        { action: "decline", content: {} },
        { action: "accept", content: { choice: "yes" } }
      ];

      workingPatterns.forEach(pattern => {
        expect(() => ElicitResultSchema.parse(pattern)).not.toThrow(
          `Existing pattern should remain valid: ${JSON.stringify(pattern)}`
        );
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle undefined content consistently", () => {
      const result = { action: "cancel", content: undefined };
      const parsed = ElicitResultSchema.parse(result);
      
      // undefined should be normalized to omitted
      expect(parsed.content).toBeUndefined();
    });

    it("should reject invalid action values", () => {
      const result = { action: "invalid", content: null };
      expect(() => ElicitResultSchema.parse(result)).toThrow();
    });

    it("should include _meta field when provided", () => {
      const result = { 
        action: "cancel", 
        content: null,
        _meta: { sessionId: "test" }
      };
      
      const parsed = ElicitResultSchema.parse(result);
      expect(parsed._meta).toEqual({ sessionId: "test" });
    });
  });
});