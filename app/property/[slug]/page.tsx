import HomePage from "../../components/HomePage";
import { getPropertySummaries, getPropertyById } from "../../lib/firebase/server-properties";
import { resolvePropertySlug, toSlug } from "../../lib/slug";

/** Same caching contract as "/" — see the note there. Must be a literal. */
export const revalidate = 3600;

/**
 * Prerender the canonical slug of every property.
 *
 * Without this the segment is fully dynamic: `revalidate` alone does not make
 * an on-demand dynamic route cacheable, so each visit would re-read Firestore.
 * With it, the 43 canonical URLs are built once and then behave exactly like
 * "/" — cached, regenerated on the timer, and invalidated on demand by
 * `revalidateListingPages()`.
 *
 * `dynamicParams` stays at its default of true, which is what keeps dispatch
 * 7 intact: the 27 stored-but-not-canonical slugs are not in this list and are
 * rendered on demand, exactly as any other unrecognised slug is.
 */
export async function generateStaticParams() {
  const properties = await getPropertySummaries();
  return properties.map((property) => ({ slug: toSlug(property.name) }));
}

interface PropertyPageProps {
  params: Promise<{ slug: string }>;
}

/**
 * A property URL renders the same page as "/" with one property already open.
 *
 * The slug is resolved on the server now, against the same catalogue the page
 * renders, so the full document for the opened property is in the HTML and
 * the panel does not have to fetch anything on arrival. Resolution still
 * accepts a stored-but-not-canonical slug (27 of the 43 documents carry one);
 * the browser rewrites the address bar to the canonical URL after hydration,
 * exactly as it did before.
 *
 * A slug that matches nothing is passed through unresolved and the client
 * shows "this property is no longer available" — unchanged from dispatch 7.
 */
export default async function PropertyPage({ params }: PropertyPageProps) {
  const { slug } = await params;
  const properties = await getPropertySummaries();

  const resolved = resolvePropertySlug(properties, slug);
  const initialProperty = resolved ? await getPropertyById(resolved.property.id) : null;

  return (
    <HomePage
      properties={properties}
      initialSlug={slug}
      initialProperty={initialProperty ?? undefined}
    />
  );
}
