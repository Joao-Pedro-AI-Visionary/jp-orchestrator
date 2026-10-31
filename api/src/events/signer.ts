import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed events (MCP Events / Standard Webhooks style):
 *   X-JP-Signature: t=<unix seconds>,v1=<hex hmac_sha256(secret, "<t>.<raw body>")>
 * The timestamp is part of the signed content, so replays outside the
 * tolerance window are rejected even with a valid signature.
 */
export const SIGNATURE_HEADER = 'x-jp-signature';

export function sign(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export function verify(secret: string, body: string, header: string | undefined, toleranceSec = 300, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
