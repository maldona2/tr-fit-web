import { cert, getApps, initializeApp, type App, type ServiceAccount } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { env } from './env.js';

let app: App | null = null;

export function getFirebaseApp(): App {
  if (app) return app;
  const existing = getApps();
  if (existing.length > 0) {
    app = existing[0]!;
    return app;
  }
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as ServiceAccount;
  app = initializeApp({ credential: cert(sa) });
  return app;
}

/** The Cloud Storage bucket used for athlete profile pictures. */
export function getStorageBucket() {
  return getStorage(getFirebaseApp()).bucket(env.FIREBASE_STORAGE_BUCKET);
}
