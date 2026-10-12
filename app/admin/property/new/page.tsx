"use client";

/**
 * /admin/property/new — a new property on its own page (dispatch 30, Kian's
 * ruling of 2026-10-10). The page is static: the editor reads nothing until
 * the admin imports or types. Once created, the address becomes the
 * property's edit page.
 */

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { PropertyEditorPage } from "../editor/PropertyEditor";

export default function NewPropertyPage() {
  return (
    <Suspense fallback={null}>
      <NewPropertyInner />
    </Suspense>
  );
}

function NewPropertyInner() {
  const params = useSearchParams();
  return <PropertyEditorPage mode={{ mode: "new" }} section={params.get("section")} created={false} mirror={null} />;
}
