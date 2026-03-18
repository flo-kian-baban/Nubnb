import { collection, doc, getDocs, getDoc, addDoc, updateDoc, deleteDoc, query, orderBy } from 'firebase/firestore';
import { db } from './config';
import { Property } from '@/app/data/properties'; // Use existing interface

const COLLECTION_NAME = 'properties';

export async function getProperties(): Promise<Property[]> {
  try {
    const q = query(collection(db, COLLECTION_NAME));
    const querySnapshot = await getDocs(q);
    const properties: Property[] = [];
    querySnapshot.forEach((doc) => {
      properties.push({ id: doc.id, ...doc.data() } as Property);
    });
    return properties;
  } catch (error) {
    console.error("Error getting documents: ", error);
    return [];
  }
}

export async function getProperty(id: string): Promise<Property | null> {
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

export async function addProperty(property: Omit<Property, 'id'>): Promise<string | null> {
  try {
    const docRef = await addDoc(collection(db, COLLECTION_NAME), property);
    return docRef.id;
  } catch (error) {
    console.error("Error adding document: ", error);
    return null;
  }
}

export async function updateProperty(id: string, property: Partial<Property>): Promise<boolean> {
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    await updateDoc(docRef, property);
    return true;
  } catch (error) {
    console.error("Error updating document: ", error);
    return false;
  }
}

export async function deleteProperty(id: string): Promise<boolean> {
  try {
    await deleteDoc(doc(db, COLLECTION_NAME, id));
    return true;
  } catch (error) {
    console.error("Error deleting document: ", error);
    return false;
  }
}
