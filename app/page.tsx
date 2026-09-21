import HomePage from "./components/HomePage";
import { getPropertySummaries } from "./lib/firebase/server-properties";

/**
 * Cache the rendered page and regenerate it in the background.
 *
 * One hour, and it is the backstop only: every create, edit and delete
 * through the admin API calls `revalidateListingPages()`, so an operator's
 * change is live on the next request rather than an hour later. The timer is
 * there for changes that never pass through the API — a document edited
 * straight in the Firestore console, say.
 *
 * It has to be a literal. Next reads segment config statically at build time
 * and rejects an imported constant, so LISTINGS_REVALIDATE_SECONDS in
 * lib/revalidate-listings.ts documents the same number rather than supplying
 * it; the two are checked against each other by the test below it.
 *
 * If `getPropertySummaries()` throws, this render fails and Next keeps
 * serving the previous good page — a failed read is never cached as an empty
 * catalogue. That is the reason the read throws instead of returning [].
 */
export const revalidate = 3600;

export default async function Page() {
  const properties = await getPropertySummaries();
  return <HomePage properties={properties} />;
}
