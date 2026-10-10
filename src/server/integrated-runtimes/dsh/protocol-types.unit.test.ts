import { describe, expect, it } from "vitest";

import {
  assertDshProtocolContract,
  DSH_CLIENT_METHOD_BY_PROTOCOL,
  DSH_HOST_METHOD_NAMES,
  DSH_NOTIFICATION_NAMES,
  DSH_REVERSE_METHOD_NAMES,
} from "./protocol-types";

describe("DSH formal protocol surface", () => {
  it("binds all 48 Host methods and seven reverse ports", () => {
    expect(DSH_HOST_METHOD_NAMES).toHaveLength(48);
    expect(DSH_REVERSE_METHOD_NAMES).toHaveLength(7);
    expect(DSH_NOTIFICATION_NAMES).toHaveLength(4);
    expect(Object.keys(DSH_CLIENT_METHOD_BY_PROTOCOL)).toEqual([
      ...DSH_HOST_METHOD_NAMES,
    ]);
    expect(new Set(Object.values(DSH_CLIENT_METHOD_BY_PROTOCOL)).size).toBe(48);
    expect(() => assertDshProtocolContract()).not.toThrow();
  });
});
