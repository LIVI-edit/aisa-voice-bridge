import 'dotenv/config';

export const DEFAULT_INSTRUCTIONS = 'You are AISA. This is a short telephone connection test. Speak briefly and naturally. Greet the caller and have a short conversation. Do not mention technical implementation unless asked.';

export function loadConfig(env = process.env) {
  for (const name of ['OPENAI_API_KEY', 'ASTERISK_ARI_USER', 'ASTERISK_ARI_PASSWORD']) {
    if (!env[name]?.trim()) throw new Error(`Заполните ${name} в .env.`);
  }
  let ariUrl;
  try { ariUrl = new URL(env.ASTERISK_ARI_URL || 'http://127.0.0.1:8088/ari'); }
  catch { throw new Error('Некорректный ASTERISK_ARI_URL.'); }
  if (ariUrl.protocol !== 'http:' || ariUrl.hostname !== '127.0.0.1' ||
      ariUrl.port !== '8088' || ariUrl.pathname.replace(/\/$/, '') !== '/ari' ||
      ariUrl.username || ariUrl.password || ariUrl.search || ariUrl.hash) {
    throw new Error('ARI должен быть http://127.0.0.1:8088/ari.');
  }
  const endpoint = env.ZADARMA_ENDPOINT || '220546';
  if (!/^[A-Za-z0-9_-]+$/.test(endpoint)) throw new Error('Некорректный ZADARMA_ENDPOINT.');
  const bindAddress = env.RTP_BIND_ADDRESS || '127.0.0.1';
  if (bindAddress !== '127.0.0.1') throw new Error('Для этого MVP RTP_BIND_ADDRESS должен быть 127.0.0.1.');
  const payloadType = Number(env.RTP_PAYLOAD_TYPE || '0');
  if (!Number.isInteger(payloadType) || payloadType < 0 || payloadType > 127 ||
      (payloadType !== 0 && payloadType < 96)) {
    throw new Error('RTP_PAYLOAD_TYPE: 0 (PCMU) либо явно согласованный dynamic PT 96–127.');
  }
  return {
    ariUrl: ariUrl.href.replace(/\/$/, ''), ariUser: env.ASTERISK_ARI_USER,
    ariPassword: env.ASTERISK_ARI_PASSWORD, apiKey: env.OPENAI_API_KEY,
    endpoint, bindAddress, payloadType,
    voice: env.OPENAI_VOICE?.trim() || undefined,
    instructions: env.OPENAI_INSTRUCTIONS?.trim() || DEFAULT_INSTRUCTIONS,
    requestTimeoutMs: 10000, connectTimeoutMs: 15000,
    answerTimeoutSeconds: 45, closeTimeoutMs: 15000,
    maxQueueFrames: 100,
  };
}

export function validateNumber(number) {
  if (!/^\+[1-9]\d{7,14}$/.test(number || '')) {
    throw new Error('Укажите один номер в международном формате: node src/index.js +380XXXXXXXXX');
  }
  return number;
}

export function normalizeZadarmaNumber(number) {
  return validateNumber(number).slice(1);
}

export function safeMessage(error, config) {
  let message = String(error?.message || error || 'Неизвестная ошибка');
  for (const secret of [config?.apiKey, config?.ariPassword,
    config && Buffer.from(`${config.ariUser}:${config.ariPassword}`).toString('base64')]) {
    if (secret) message = message.split(secret).join('[REDACTED]');
  }
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 600);
}
