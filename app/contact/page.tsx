/**
 * The contact page.
 *
 * A server component purely so a "Request these dates" arrival renders with
 * the property and dates already in place: reading them here means the filled
 * form is in the first response, rather than appearing a moment after
 * hydration the way `useSearchParams` in a client component would leave it.
 * Metadata is untouched and still lives in layout.tsx.
 *
 * The same read decides the submission's source: a stay request is a property
 * arrival, and `?from=partner` or `?from=fund` marks the partner and Fund
 * pages' links. Everything else is a general visit.
 */

import ContactForm from "./ContactForm";
import { parseInquiryOrigin } from "./stay-request";

interface ContactPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ContactPage({ searchParams }: ContactPageProps) {
  const params = await searchParams;
  return <ContactForm origin={parseInquiryOrigin(params)} />;
}
