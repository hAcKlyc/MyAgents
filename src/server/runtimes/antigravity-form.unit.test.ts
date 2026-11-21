import { describe, expect, it } from "vitest";
import { antigravityForm } from "./antigravity-form";

describe("ACP form round-trip", () => {
  it("preserves opaque constants, false, and optional free text", () => {
    const form = antigravityForm(
      {
        required: ["q", "confirmed"],
        properties: {
          q: { type: "string", oneOf: [{ const: "2", title: "Blue" }] },
          confirmed: { type: "boolean" },
          other: { type: "string" },
        },
      },
      "Select a color",
    )!;
    expect(
      form.questions.map((q) => [q.id, q.required, q.allowCustom]),
    ).toEqual([
      ["q", true, false],
      ["confirmed", true, false],
      ["other", false, true],
    ]);
    expect(
      form.decode({
        q: { selected: ["Blue"] },
        confirmed: "false",
        other: { selected: [], custom: "sky" },
      }),
    ).toEqual({ q: "2", confirmed: false, other: "sky" });
    expect(() => form.decode({ q: "Yellow", confirmed: "true" })).toThrow();
  });
  it("declines ambiguous labels and constraints the composer cannot enforce", () => {
    expect(
      antigravityForm(
        { properties: { q: { type: "string", pattern: "[a-z]+" } } },
        "q",
      ),
    ).toBeNull();
    expect(
      antigravityForm(
        {
          properties: {
            q: {
              type: "string",
              oneOf: [
                { const: "1", title: "Blue" },
                { const: "2", title: "Blue" },
              ],
            },
          },
        },
        "q",
      ),
    ).toBeNull();
  });
});
