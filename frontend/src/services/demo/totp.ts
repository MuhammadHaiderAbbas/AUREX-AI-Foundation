/** RFC 6238 TOTP for the static demo (WebCrypto HMAC-SHA1). Mirrors backend/app/core/totp.py. */
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";  // pragma: allowlist secret (base32 alphabet)

export function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = "", out = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) out += ALPHA[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function decode(secret: string): Uint8Array {
  let bits = "";
  for (const ch of secret.toUpperCase().replace(/[\s=]/g, "")) bits += ALPHA.indexOf(ch).toString(2).padStart(5, "0");
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

export async function codeAt(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", decode(secret) as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new ArrayBuffer(8);
  new DataView(msg).setBigUint64(0, BigInt(step));
  const d = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = d[d.length - 1]! & 0x0f;
  const v = ((d[o]! & 0x7f) << 24) | (d[o + 1]! << 16) | (d[o + 2]! << 8) | d[o + 3]!;
  return String(v % 1_000_000).padStart(6, "0");
}

export const currentStep = () => Math.floor(Date.now() / 30_000);

export async function verify(secret: string, code: string, lastStep: number | null): Promise<number | null> {
  const c = code.trim().replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const step = currentStep();
  for (let s = step - 1; s <= step + 1; s++) {
    if (lastStep != null && s <= lastStep) continue;
    if ((await codeAt(secret, s)) === c) return s;
  }
  return null;
}

export const otpauthUri = (secret: string, account: string) =>
  `otpauth://totp/${encodeURIComponent(`AUREX AI:${account}`)}?secret=${secret}&issuer=${encodeURIComponent("AUREX AI")}&algorithm=SHA1&digits=6&period=30`;

export const newRecoveryCodes = () => Array.from({ length: 10 }, () => {
  const h = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h()}-${h()}`;
});
