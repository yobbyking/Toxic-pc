/**
 * lib/firebase-admin.ts — Firebase Admin SDK for server-side token verification.
 *
 * Uses firebase-admin v14 modular API:
 *   - admin.cert() for credentials (not admin.credential.cert())
 *   - getAuth(app).verifyIdToken() (not admin.auth().verifyIdToken())
 */

import { initializeApp, getApps, getApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

let app: ReturnType<typeof initializeApp> | null = null;

function init() {
  if (app) return app;
  if (getApps().length > 0) {
    app = getApp();
    return app;
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (privateKey) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Missing Firebase Admin credentials (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY)');
  }
  app = initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
  return app;
}

export async function verifyIdToken(idToken: string) {
  try {
    const firebaseApp = init();
    const authInstance = getAuth(firebaseApp);
    const decoded = await authInstance.verifyIdToken(idToken);
    return decoded;
  } catch (err: any) {
    console.error('[firebase-admin] token verify failed:', err.message || err);
    return null;
  }
}

// Also export updateUser for password reset
export async function updateUserPassword(uid: string, newPassword: string) {
  try {
    const firebaseApp = init();
    const authInstance = getAuth(firebaseApp);
    await authInstance.updateUser(uid, { password: newPassword });
    return true;
  } catch (err: any) {
    console.error('[firebase-admin] update user failed:', err.message || err);
    return false;
  }
}
