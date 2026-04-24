/**
 * Property data access layer.
 *
 * READ operations use the client Firestore SDK (public data, no auth required).
 * WRITE operations call authenticated server-side API routes that use the
 * Firebase Admin SDK — the client SDK never writes to Firestore.
 *
 * Authentication is handled automatically via the HTTP-only session cookie
 * set by /api/admin-auth. No headers or client-side tokens needed.
 */

import { collection, doc, getDocs, getDoc, query } from 'firebase/firestore';
import { db, isFirebaseConfigured } from './config';
import { Property } from '@/app/types/property';

const COLLECTION_NAME = 'properties';

// ─── READ (client SDK — public data) ───────────────────────────

export async function getProperties(): Promise<Property[]> {
  if (!isFirebaseConfigured() || !db) return [];
  try {
    const q = query(collection(db, COLLECTION_NAME));
    const querySnapshot = await getDocs(q);
    const properties: Property[] = [];
    querySnapshot.forEach((docSnap) => {
      properties.push({ id: docSnap.id, ...docSnap.data() } as Property);
    });
    return properties;
  } catch (error) {
    console.error("Error getting documents: ", error);
    return [];
  }
}

export async function getProperty(id: string): Promise<Property | null> {
  if (!isFirebaseConfigured() || !db) return null;
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() } as Property;
    } else {
      console.log("No such document!");
      return null;
    }
  } catch (error) {
    console.error("Error getting document:", error);
    return null;
  }
}

// ─── WRITE (server-side API routes via Admin SDK) ──────────────
// Session cookie is sent automatically with same-origin fetch requests.

export async function addProperty(property: Omit<Property, 'id'>): Promise<string | null> {
  try {
    const res = await fetch('/api/properties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(property),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to create property');
    }

    const result = await res.json();
    return result.data.id;
  } catch (error) {
    console.error("Error adding property:", error);
    return null;
  }
}

export async function updateProperty(id: string, property: Partial<Property>): Promise<boolean> {
  try {
    const res = await fetch(`/api/properties/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(property),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to update property');
    }

    return true;
  } catch (error) {
    console.error("Error updating property:", error);
    return false;
  }
}

export async function deleteProperty(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/properties/${id}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to delete property');
    }

    return true;
  } catch (error) {
    console.error("Error deleting property:", error);
    return false;
  }
}
