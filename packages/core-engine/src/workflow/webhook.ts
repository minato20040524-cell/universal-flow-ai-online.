import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Each webhook trigger gets its own secret. Callers sign `timestamp.body`
 * with HMAC-SHA256; the timestamp window blocks replayed requests.
 */
export const createWebhookSecret = (): string => randomBytes(32).toString('base64url');

export const signWebhookPayload = (secret: string, timestampMs: number, body: string): string =>
  createHmac('sha256', secret).update(`${timestampMs}.${body}`).digest('hex');

export type WebhookVerification = {
  secret: string;
  body: string;
  timestampMs: number;
  signature: string;
  nowMs: number;
  toleranceMs?: number;
};

export const verifyWebhookSignature = ({ secret, body, timestampMs, signature, nowMs, toleranceMs = 300_000 }: WebhookVerification): boolean => {
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > toleranceMs) return false;
  const expected = Buffer.from(signWebhookPayload(secret, timestampMs, body), 'hex');
  const received = Buffer.from(signature, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
};
