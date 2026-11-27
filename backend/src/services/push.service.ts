import { getMessaging } from 'firebase-admin/messaging';
import { env } from '../config/env.js';
import { getFirebaseApp } from '../config/firebase.js';
import logger from '../utils/logger.js';

export type SendStatus = 'sent' | 'token_invalid' | 'failed';

const TOKEN_INVALID_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
  'messaging/invalid-registration-token',
]);

export async function sendPush(
  token: string,
  payload: { title: string; body: string; data?: Record<string, string> },
): Promise<SendStatus> {
  if (env.EXTERNAL_EFFECTS_ENABLED === 'false') {
    logger.info('FCM push blocked in rehearsal');
    return 'failed';
  }
  const app = getFirebaseApp();
  try {
    await getMessaging(app).send({
      token,
      notification: { title: payload.title, body: payload.body },
      data: payload.data ?? {},
    });
    return 'sent';
  } catch (e: unknown) {
    const code = (e as { code?: string }).code ?? '';
    if (TOKEN_INVALID_CODES.has(code)) return 'token_invalid';
    logger.error({ err: e, code }, 'FCM send failed');
    return 'failed';
  }
}
