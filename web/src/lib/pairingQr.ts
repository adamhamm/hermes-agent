/**
 * Builds the JSON payload embedded in the mobile-pairing QR code.
 * Loopback-mode only — there is no static token to embed in gated mode
 * (see Auth_Flow_Design.md §1). Callers must check `!authRequired` first;
 * this function does not enforce it so it stays a pure, easily-testable unit.
 */
export interface PairingPayload {
  v: 1;
  baseUrl: string;
  token: string;
}

export function buildPairingPayload(baseUrl: string, token: string): PairingPayload {
  if (!baseUrl || !token) {
    throw new Error("buildPairingPayload requires a non-empty baseUrl and token");
  }
  return { v: 1, baseUrl, token };
}

export function pairingPayloadToJson(payload: PairingPayload): string {
  return JSON.stringify(payload);
}
