"use client";

/**
 * /admin/property/edit?id=… — a property's edit page (dispatch 30, Kian's
 * ruling of 2026-10-10). The ID rides in the query, as on the property page,
 * so the page is static and costs the server nothing per property; the
 * editor reads the stored document through the admin route. `&section=`
 * keeps the open section across a reload; `&created=1` is set by the new
 * page once it has created the property.
 */

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { AdminHeader } from "../../components/AdminHeader";
import { PinGate } from "../../components/PinGate";
import { PropertyEditorPage } from "../editor/PropertyEditor";
import shared from "../../page.module.css";

export default function EditPropertyPage() {
  return (
    <Suspense fallback={null}>
      <EditPropertyInner />
    </Suspense>
  );
}

function EditPropertyInner() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return (
      <PinGate>
        <div className={shared.container}>
          <AdminHeader current="properties" title="Edit property" />
          <main className={shared.main}>
            <div className={`${shared.empty} ${shared.loadError}`} role="alert">
              <AlertTriangle size={48} strokeWidth={1} />
              <h2>Which property?</h2>
              <p>Open one from the list: the address needs a property ID.</p>
              <Link href="/admin" prefetch={false} className={shared.btnPrimary}>
                Go to Properties
              </Link>
            </div>
          </main>
        </div>
      </PinGate>
    );
  }
  return <PropertyEditorPage key={id} mode={{ mode: "edit", id }} section={params.get("section")} created={params.get("created") === "1"} mirror={params.get("mirror")} links={params.get("links")} />;
}
