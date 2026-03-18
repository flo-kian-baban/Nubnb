"use client";

import { useState, useEffect } from "react";
import { Property } from "@/app/data/properties";
import { getProperties, deleteProperty, addProperty } from "@/app/lib/firebase/properties";
import { PropertyForm } from "./components/PropertyForm";
import styles from "./page.module.css";
import { Plus, Edit2, Trash2, Home } from "lucide-react";
import Link from "next/link";

// We need an admin panel because the user wants "an admin page where the admin can create new listings, edit listings, delete listings."
export default function AdminPage() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
  const [editingProperty, setEditingProperty] = useState<Property | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);

  useEffect(() => {
    fetchProperties();
  }, []);

  const fetchProperties = async () => {
    setIsLoading(true);
    const data = await getProperties();
    setProperties(data);
    setIsLoading(false);
  };

  const handleDelete = async (id: string, name: string) => {
    if (confirm(`Are you sure you want to delete ${name}?`)) {
      await deleteProperty(id);
      fetchProperties();
    }
  };

  const handleEdit = (property: Property) => {
    setEditingProperty(property);
    setIsFormOpen(true);
  };

  const handleAddNew = () => {
    setEditingProperty(null);
    setIsFormOpen(true);
  };

  const handleSaveContent = () => {
    setIsFormOpen(false);
    fetchProperties();
  };

  const handleSeedDatabase = async () => {
    if (confirm("Are you sure you want to seed the database with mock properties? This will add them to Firestore.")) {
      setIsLoading(true);
      const { properties: staticProps } = await import("@/app/data/properties");
      for (const p of staticProps) {
        const { id: _id, ...dataToSave } = p;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await addProperty(dataToSave as any);
      }
      await fetchProperties();
    }
  };

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <Link href="/" className={styles.backBtn}>
            <Home size={20} />
            <span>View Site</span>
          </Link>
          <h1>Property Management</h1>
        </div>
        
        <div className={styles.headerRight} style={{ display: 'flex', gap: '12px' }}>
          <button className={styles.addBtnOutline} onClick={handleSeedDatabase} style={{ margin: 0 }}>
            Seed Data
          </button>
          <button className={styles.addBtn} onClick={handleAddNew}>
            <Plus size={18} />
            <span>Add Property</span>
          </button>
        </div>
      </header>

      <main className={styles.main}>
        {isLoading ? (
          <div className={styles.loading}>Loading properties from Firebase...</div>
        ) : properties.length === 0 ? (
          <div className={styles.empty}>
            <p>No properties found in Firebase.</p>
            <button className={styles.addBtnOutline} onClick={handleAddNew}>
              Create your first property
            </button>
          </div>
        ) : (
          <div className={styles.tableContainer}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Image</th>
                  <th>Name</th>
                  <th>Location</th>
                  <th>Price / Night</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {properties.map(p => (
                  <tr key={p.id}>
                      <td>
                      <div className={styles.thumbWrapper}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.coverImage} alt={p.name} className={styles.thumb} />
                      </div>
                    </td>
                    <td>
                      <div className={styles.nameCell}>
                        <strong>{p.name}</strong>
                        <span>{p.type} • {p.bedrooms} Beds</span>
                      </div>
                    </td>
                    <td style={{ color: '#c0c0c0', fontSize: '14px' }}>{p.location}</td>
                    <td style={{ color: '#ffffff', fontWeight: 500, fontSize: '15px' }}>${p.price} {p.currency}</td>
                    <td className={styles.actionsCell}>
                      <div className={styles.actionsFlex}>
                        <button className={styles.iconBtn} onClick={() => handleEdit(p)} title="Edit">
                          <Edit2 size={16} />
                        </button>
                        <button className={styles.iconBtnDelete} onClick={() => handleDelete(p.id, p.name)} title="Delete">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {isFormOpen && (
        <PropertyForm
          initialData={editingProperty || undefined}
          onClose={() => setIsFormOpen(false)}
          onSave={handleSaveContent}
        />
      )}
    </div>
  );
}
