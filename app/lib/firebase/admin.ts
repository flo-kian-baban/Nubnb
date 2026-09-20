/**
 * Firebase Admin SDK — server-side only.
 * Uses GOOGLE_APPLICATION_CREDENTIALS or falls back to env-var-based init.
 */

import { initializeApp, getApps, cert, App } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

let adminApp: App;
let adminDb: Firestore;

/**
 * The default Storage bucket. Same value the browser config uses, but read
 * server-side: the Admin SDK needs it explicitly or `.bucket()` throws.
 */
function getBucketName(): string {
  const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (!bucket) {
    throw new Error(
      'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not configured — uploads cannot be stored.',
    );
  }
  return bucket;
}

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
      adminApp = initializeApp({
        credential: cert(parsed),
        storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
      });
      return adminApp;
    } catch (e) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY:', e);
    }
  }

  // Option 2: Project ID only (works in GCP-hosted environments with ADC)
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (projectId) {
    adminApp = initializeApp({
      projectId,
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    });
    return adminApp;
  }

  throw new Error('Firebase Admin SDK: No credentials configured.');
}

export function getAdminDb(): Firestore {
  if (adminDb) return adminDb;
  adminDb = getFirestore(getAdminApp());
  return adminDb;
}

/**
 * The default Storage bucket, via the Admin SDK.
 *
 * Admin SDK writes use the service account and bypass Storage Security Rules
 * entirely — the same way `getAdminDb()` bypasses Firestore rules. This is
 * what lets storage.rules stay deny-all for clients.
 *
 * Return type is inferred rather than annotated: `Bucket` lives in
 * @google-cloud/storage, which is only a transitive dependency here.
 */
export function getAdminBucket() {
  return getStorage(getAdminApp()).bucket(getBucketName());
}
