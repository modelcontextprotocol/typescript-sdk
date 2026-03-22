import { describe, it, expect } from "vitest";
import { BearerTokenAuthenticator } from "../../src/server/auth/bearer.js";
import { Authorizer } from "../../src/server/auth/authorizer.js";

describe("BearerTokenAuthenticator", () => {
  it("should authenticate with a valid token", async () => {
    const authenticator = new BearerTokenAuthenticator(async (token) => {
      if (token === "valid-token") {
        return { name: "test-user", token: "valid-token", clientId: "test-client", scopes: ["read"] };
      }
      return undefined;
    });

    const authInfo = await authenticator.authenticate({
      requestId: 1,
      method: "test",
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    expect(authInfo).toEqual({ name: "test-user", token: "valid-token", clientId: "test-client", scopes: ["read"] });
  });

  it("should return undefined with an invalid token", async () => {
    const authenticator = new BearerTokenAuthenticator(async (_) => undefined);

    const authInfo = await authenticator.authenticate({
      requestId: 1,
      method: "test",
      headers: {
        authorization: "Bearer invalid-token",
      },
    });
    expect(authInfo).toBeUndefined();
  });

  it("should return undefined when Authorization header is missing", async () => {
    const authenticator = new BearerTokenAuthenticator(async (_) => ({
      name: "test-user",
      token: "test-token",
      clientId: "test-client",
      scopes: [],
    }));

    const authInfo = await authenticator.authenticate({
      requestId: 1,
      method: "test",
      headers: {},
    });
    expect(authInfo).toBeUndefined();
  });
});

describe("Authorizer", () => {
  it("should authorize when no scopes are required", () => {
    const authInfo = { name: "test-user", token: "test-token", clientId: "test-client", scopes: [] };
    expect(Authorizer.isAuthorized(authInfo, undefined)).toBe(true);
    expect(Authorizer.isAuthorized(authInfo, [])).toBe(true);
  });

  it("should authorize when all required scopes are present", () => {
    const authInfo = { name: "test-user", token: "test-token", clientId: "test-client", scopes: ["read", "write"] };
    expect(Authorizer.isAuthorized(authInfo, ["read"])).toBe(true);
    expect(Authorizer.isAuthorized(authInfo, ["read", "write"])).toBe(true);
  });

  it("should not authorize when a required scope is missing", () => {
    const authInfo = { name: "test-user", token: "test-token", clientId: "test-client", scopes: ["read"] };
    expect(Authorizer.isAuthorized(authInfo, ["write"])).toBe(false);
    expect(Authorizer.isAuthorized(authInfo, ["read", "write"])).toBe(false);
  });

  it("should not authorize if authInfo is missing but scopes are required", () => {
    expect(Authorizer.isAuthorized(undefined, ["read"])).toBe(false);
  });
});
