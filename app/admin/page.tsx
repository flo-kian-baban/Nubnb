"use client";

import { useState, useEffect, useMemo } from "react";
import { Property } from "@/app/data/properties";
import { getProperties, deleteProperty, addProperty } from "@/app/lib/firebase/properties";
import { PropertyForm } from "./components/PropertyForm";
import { PinGate } from "./components/PinGate";
import styles from "./page.module.css";
import { Plus, Edit2, Trash2, Home, Search, SlidersHorizontal, Building2, BedDouble, DollarSign, LayoutGrid } from "lucide-react";
import Link from "next/link";

type SortOption = "newest" | "price-asc" | "price-desc" | "name-asc";

export default function AdminPage() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingProperty, setEditingProperty] = useState<Property | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sortBy, setSortBy] = useState<SortOption>("newest");

  useEffect(() => {
    fetchProperties();
  }, []);

  const fetchProperties = async () => {
    setIsLoading(true);
    const data = await getProperties();
    setProperties(data);
    setIsLoading(false);
  };

  // Derived unique property types for filter dropdown
  const propertyTypes = useMemo(() => {
    const types = new Set(properties.map((p) => p.type));
    return Array.from(types).sort();
  }, [properties]);

  // Filtered + sorted properties
  const filteredProperties = useMemo(() => {
    let result = [...properties];

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.location.toLowerCase().includes(q)
      );
    }

    // Type filter
    if (typeFilter !== "all") {
      result = result.filter((p) => p.type === typeFilter);
    }

    // Sort
    switch (sortBy) {
      case "price-asc":
        result.sort((a, b) => a.price - b.price);
        break;
      case "price-desc":
        result.sort((a, b) => b.price - a.price);
        break;
      case "name-asc":
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
      default:
        break;
    }

    return result;
  }, [properties, searchQuery, typeFilter, sortBy]);

  // Stats
  const stats = useMemo(() => {
    const total = properties.length;
    const avgPrice = total > 0 ? Math.round(properties.reduce((s, p) => s + p.price, 0) / total) : 0;
    const totalBedrooms = properties.reduce((s, p) => s + p.bedrooms, 0);
    const types = new Set(properties.map((p) => p.type)).size;
    return { total, avgPrice, totalBedrooms, types };
  }, [properties]);

  const handleDelete = async (id: string, name: string) => {
    if (confirm(`Are you sure you want to delete "${name}"?`)) {
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

  const getTypeBadgeClass = (type: string) => {
    switch (type.toLowerCase()) {
      case "condo": return styles.badgeCondo;
      case "house": return styles.badgeHouse;
      case "basement": return styles.badgeBasement;
      default: return styles.badgeDefault;
    }
  };

  return (
    <PinGate>
    <div className={styles.container}>
      {/* ── Header ── */}
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.headerLeft}>
            <Link href="/" className={styles.backBtn}>
              <Home size={16} />
              <span>View Site</span>
            </Link>
            <div className={styles.headerDivider} />
            <h1>Properties</h1>
          </div>

          <div className={styles.headerRight}>
            <button className={styles.btnPrimary} onClick={handleAddNew}>
              <Plus size={18} />
              <span>Add Property</span>
            </button>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        {/* ── Stats Cards ── */}
        {!isLoading && properties.length > 0 && (
          <section className={styles.statsGrid}>
            <div className={styles.statCard}>
              <div className={styles.statIcon}><LayoutGrid size={20} /></div>
              <div className={styles.statContent}>
                <span className={styles.statValue}>{stats.total}</span>
                <span className={styles.statLabel}>Total Properties</span>
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statIcon}><DollarSign size={20} /></div>
              <div className={styles.statContent}>
                <span className={styles.statValue}>${stats.avgPrice.toLocaleString()}</span>
                <span className={styles.statLabel}>Avg. Price / Night</span>
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statIcon}><BedDouble size={20} /></div>
              <div className={styles.statContent}>
                <span className={styles.statValue}>{stats.totalBedrooms}</span>
                <span className={styles.statLabel}>Total Bedrooms</span>
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statIcon}><Building2 size={20} /></div>
              <div className={styles.statContent}>
                <span className={styles.statValue}>{stats.types}</span>
                <span className={styles.statLabel}>Property Types</span>
              </div>
            </div>
          </section>
        )}

        {/* ── Search & Filters ── */}
        {!isLoading && properties.length > 0 && (
          <section className={styles.toolbar}>
            <div className={styles.searchWrapper}>
              <Search size={16} className={styles.searchIcon} />
              <input
                type="text"
                className={styles.searchInput}
                placeholder="Search by name or location…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className={styles.filterGroup}>
              <div className={styles.filterItem}>
                <SlidersHorizontal size={14} className={styles.filterIcon} />
                <select
                  className={styles.filterSelect}
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                >
                  <option value="all">All Types</option>
                  {propertyTypes.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>

              <div className={styles.filterItem}>
                <select
                  className={styles.filterSelect}
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortOption)}
                >
                  <option value="newest">Default Order</option>
                  <option value="price-asc">Price: Low → High</option>
                  <option value="price-desc">Price: High → Low</option>
                  <option value="name-asc">Name: A → Z</option>
                </select>
              </div>

              <span className={styles.resultCount}>
                {filteredProperties.length} of {properties.length}
              </span>
            </div>
          </section>
        )}

        {/* ── Content ── */}
        {isLoading ? (
          <div className={styles.loading}>
            <div className={styles.spinner} />
            <p>Loading properties from Firebase…</p>
          </div>
        ) : properties.length === 0 ? (
          <div className={styles.empty}>
            <LayoutGrid size={48} strokeWidth={1} />
            <h2>No properties yet</h2>
            <p>Get started by creating your first listing or seeding sample data.</p>
            <button className={styles.btnPrimary} onClick={handleAddNew}>
              <Plus size={18} />
              <span>Create Property</span>
            </button>
          </div>
        ) : filteredProperties.length === 0 ? (
          <div className={styles.empty}>
            <Search size={48} strokeWidth={1} />
            <h2>No matching properties</h2>
            <p>Try adjusting your search or filter criteria.</p>
          </div>
        ) : (
          <div className={styles.tableContainer}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Property</th>
                  <th>Location</th>
                  <th>Type</th>
                  <th>Beds</th>
                  <th>Price / Night</th>
                  <th className={styles.actionsHeader}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredProperties.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className={styles.propertyCell}>
                        <div className={styles.thumbWrapper}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={p.coverImage} alt={p.name} className={styles.thumb} />
                        </div>
                        <span className={styles.propertyName}>{p.name}</span>
                      </div>
                    </td>
                    <td><span className={styles.locationText}>{p.location}</span></td>
                    <td>
                      <span className={`${styles.typeBadge} ${getTypeBadgeClass(p.type)}`}>
                        {p.type}
                      </span>
                    </td>
                    <td><span className={styles.bedsText}>{p.bedrooms}</span></td>
                    <td><span className={styles.priceText}>${p.price.toLocaleString()} {p.currency}</span></td>
                    <td>
                      <div className={styles.actionsFlex}>
                        <button className={styles.iconBtn} onClick={() => handleEdit(p)} title="Edit">
                          <Edit2 size={15} />
                        </button>
                        <button className={styles.iconBtnDelete} onClick={() => handleDelete(p.id, p.name)} title="Delete">
                          <Trash2 size={15} />
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
    </PinGate>
  );
}
