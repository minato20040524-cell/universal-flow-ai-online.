/** Webhook signing secrets live in the credential vault under this reserved plugin id. */
export const WEBHOOK_SECRET_PLUGIN_ID = 'core.webhook';

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export const OAUTH_CALLBACK_PATH = '/oauth/callback';
export const WEBHOOK_PATH_PREFIX = '/hooks/';

export const WEBHOOK_SIGNATURE_HEADER = 'x-uf-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-uf-timestamp';
export const WEBHOOK_TOKEN_HEADER = 'x-uf-webhook-token';
/**
 * Telegram sends the bot's `secret_token` in this header. Webhook secrets are
 * 43 base64url characters, which Telegram accepts as a secret_token as is.
 */
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';
