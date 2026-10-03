# The Fund page — offline

Kian's ruling (dispatch 26, 2026-10-03): the Fund page is taken offline until
counsel has read it. Its content is kept here, unused.

`page.tsx` and `page.module.css` are the page exactly as it was at `/fund`.
Nothing imports them, and Next only routes what is under `app/`, so
`/fund` answers with the site's not-found page.

To put it back after counsel's review, move this folder to `app/fund/`
(and restore the About page's "The Fund" link and the contact form's
"I'm interested in the Fund" subject, removed in the same change).
