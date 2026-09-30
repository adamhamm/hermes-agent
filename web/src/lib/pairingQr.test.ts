import { describe, expect, it } from "vitest";
import { buildPairingPayload, pairingPayloadToJson } from "./pairingQr";

describe("buildPairingPayload", () => {
  it("builds a v1 payload with baseUrl and token", () => {
    const payload = buildPairingPayload("http://192.168.1.10:9119", "abc123");
    expect(payload).toEqual({ v: 1, baseUrl: "http://192.168.1.10:9119", token: "abc123" });
  });

  it("throws on empty baseUrl", () => {
    expect(() => buildPairingPayload("", "abc123")).toThrow();
  });

  it("throws on empty token", () => {
    expect(() => buildPairingPayload("http://x", "")).toThrow();
  });
});

describe("pairingPayloadToJson", () => {
  it("round-trips through JSON.parse", () => {
    const payload = buildPairingPayload("http://192.168.1.10:9119", "abc123");
    const json = pairingPayloadToJson(payload);
    expect(JSON.parse(json)).toEqual(payload);
  });
});
