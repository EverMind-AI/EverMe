import { randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastMs = 0;
let counter = 0;

/**
 * A part id in the host's own format: "prt_" + 12 hex digits of
 * (ms * 0x1000 + counter) + 14 base62 characters. The host validates parts
 * before saving them and orders them by id, so an id made now sorts after the
 * user's own parts created moments earlier.
 */
export function partId(now = Date.now()) {
  if (now !== lastMs) {
    lastMs = now;
    counter = 0;
  }
  counter += 1;
  const value = BigInt(now) * 0x1000n + BigInt(counter);
  const hex = value.toString(16).padStart(12, "0").slice(-12);
  const random = Array.from(randomBytes(14), (byte) => BASE62[byte % 62]).join("");
  return `prt_${hex}${random}`;
}
