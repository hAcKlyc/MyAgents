import { describe, expect, it } from "vitest";
import {
  hostAddressKey,
  sameHostAddress,
  validHostProvider,
} from "./hostManagement";

describe("Host UI identity and redacted Provider inputs", () => {
  it("isolates connections, accounts and target identity generations", () => {
    const address = {
      connectionId: "official",
      principalId: "human",
      authGeneration: 1,
      serviceId: "service",
      networkId: "network",
      deviceId: "host",
      targetIdentityGeneration: 2,
    };
    const values = [
      address,
      { ...address, connectionId: "selfhost" },
      { ...address, principalId: "other" },
      { ...address, authGeneration: 2 },
      { ...address, serviceId: "other-service" },
      { ...address, networkId: "other-network" },
      { ...address, deviceId: "other-host" },
      { ...address, targetIdentityGeneration: 3 },
    ];
    expect(new Set(values.map(hostAddressKey)).size).toBe(values.length);
    expect(sameHostAddress(address, { ...address })).toBe(true);
    for (const changed of values.slice(1))
      expect(sameHostAddress(address, changed)).toBe(false);
  });
  it("rejects endpoints carrying credentials, query secrets or controls and missing models", () => {
    const config = {
      baseUrl: "https://provider.example.invalid/v1",
      model: "model",
    };
    expect(validHostProvider(config)).toBe(true);
    for (const baseUrl of [
      "http://provider.invalid",
      "https://user:secret@provider.invalid",
      "https://provider.invalid?key=fixture",
      "https://provider.invalid#fixture",
      "https://provider.invalid/\n",
      "invalid",
    ])
      expect(validHostProvider({ ...config, baseUrl })).toBe(false);
    for (const model of [" ", "model\0", "x".repeat(161)])
      expect(validHostProvider({ ...config, model })).toBe(false);
  });
});
