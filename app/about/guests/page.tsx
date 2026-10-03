import { GuestsPage } from "./GuestsPage";
import { getPropertySummaries } from "../../lib/firebase/server-properties";

/**
 * Same caching contract as "/" (see the note there): an hour on the timer,
 * and invalidated on demand by `revalidateListingPages()` on every admin
 * write. Must be a literal.
 *
 * The catalogue is read on the server (dispatch 24): the listed properties
 * only, so an unlisted property never reaches the map or the city counts.
 * The page used to read the whole collection from the browser, which the
 * Firestore rules no longer allow. A failed read fails the render, and Next
 * keeps serving the last good page.
 */
export const revalidate = 3600;

export default async function Page() {
  const properties = await getPropertySummaries();
  return <GuestsPage properties={properties} />;
}
