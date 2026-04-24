"use client";

import { useParams } from "next/navigation";
import HomePage from "../../components/HomePage";

export default function PropertyPage() {
  const params = useParams<{ slug: string }>();
  return <HomePage initialSlug={params.slug} />;
}
