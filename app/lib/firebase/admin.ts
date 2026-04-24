/**
 * Firebase Admin SDK — server-side only.
 * Uses GOOGLE_APPLICATION_CREDENTIALS or falls back to env-var-based init.
 */

import { initializeApp, getApps, cert, App } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';

let adminApp: App;
let adminDb: Firestore;

function getAdminApp(): App {
  if (adminApp) return adminApp;

  if (getApps().length > 0) {
    adminApp = getApps()[0];
    return adminApp;
  }

  // Option 1: Service account JSON via env var (recommended for Vercel)
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (serviceAccount) {
    try {
      const parsed = JSON.parse(serviceAccount);
      adminApp = initializeApp({ credential: cert(parsed) });
      return adminApp;
    } catch (e) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY:', e);
    }
  }

  // Option 2: Project ID only (works in GCP-hosted environments with ADC)
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (projectId) {
    adminApp = initializeApp({ projectId });
    return adminApp;
  }

  throw new Error('Firebase Admin SDK: No credentials configured.');
}

export function getAdminDb(): Firestore {
  if (adminDb) return adminDb;
  adminDb = getFirestore(getAdminApp());
  return adminDb;
}
