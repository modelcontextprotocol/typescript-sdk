import { z } from "zod";
import { completable } from "./completable.js";

describe("completable", () => {
  it("preserves types and values of underlying schema", () => {
    const baseSchema = z.string();
    const schema = completable(baseSchema, () => []);

    expect(schema.parse("test")).toBe("test");
    expect(() => schema.parse(123)).toThrow();
  });

  it("provides access to completion function", async () => {
    const completions = ["foo", "bar", "baz"];
    const schema = completable(z.string(), () => completions);

    expect(await schema._def.complete("")).toEqual(completions);
  });

  it("allows async completion functions", async () => {
    const completions = ["foo", "bar", "baz"];
    const schema = completable(z.string(), async () => completions);

    expect(await schema._def.complete("")).toEqual(completions);
  });

  it("passes current value to completion function", async () => {
    const schema = completable(z.string(), (value) => [value + "!"]);

    expect(await schema._def.complete("test")).toEqual(["test!"]);
  });

  it("works with number schemas", async () => {
    const schema = completable(z.number(), () => [1, 2, 3]);

    expect(schema.parse(1)).toBe(1);
    expect(await schema._def.complete(0)).toEqual([1, 2, 3]);
  });

  it("preserves schema description", () => {
    const desc = "test description";
    const schema = completable(z.string().describe(desc), () => []);

    expect(schema.description).toBe(desc);
  });
});
