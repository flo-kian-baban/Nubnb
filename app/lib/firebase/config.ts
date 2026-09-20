import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getFirestore, Firestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID
};

// Only initialize Firebase if credentials are actually present
const isConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

let app: FirebaseApp | null = null;
let db: Firestore | null = null;

if (isConfigured) {
  app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
  db = getFirestore(app);
}

/**
 * Deliberately no client Storage handle.
 *
 * This app has no Firebase Auth, so the browser carries no credential Storage
 * could authorise against — any rule permissive enough for the admin form
 * would be permissive enough for anyone. storage.rules denies all client
 * access; uploads go through POST /api/upload-image, which writes with the
 * Admin SDK. Re-exporting `getStorage(app)` here would only re-create an
 * upload path that is guaranteed to fail with `storage/unauthorized`.
 */

export function isFirebaseConfigured(): boolean {
  return isConfigured;
}

export { app, db };
