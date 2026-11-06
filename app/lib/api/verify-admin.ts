/**
 * The admin door, for every admin route (dispatch 38).
 *
 * Every admin route handler is wrapped:
 *
 *   export const POST = adminRoute(async function POST(request, context, { actor }) { … });
 *
 * and the wrapper, before the handler runs:
 *   1. reads the session (app/lib/admins/session.ts): the signed token, then
 *      the admin's document — 401, 403 or 503 as that module says, with
 *      nothing run;
 *   2. for a route made with `{ level: 'main' }`, refuses an admin who is not
 *      a main admin (403 MAIN_ADMIN_ONLY);
 * then hands the handler the signed-in admin and their `actor`, which every
 * record the handler writes names them by (Kian's ruling of 2026-10-13:
 * every admin action records which admin did it, from now on);
 * and after it, for every method but GET (and for a GET made with
 * `{ record: true }`: a download that writes its own record), puts one line
 * in the activity log, `admin_actions` — who, when, the method, the path and
 * the status — once the response has gone, when the status is below 400.
 * Nothing of the request's body or query is recorded: they can carry PINs,
 * codes and names.
 *
 * The session used to be `<issuedAtMs>.<HMAC(ADMIN_PIN, issuedAtMs)>`, the
 * PIN itself the key; nothing reads ADMIN_PIN here any more.
 */

import { after, type NextRequest } from 'next/server';
import { apiFailure, noStore } from '@/app/lib/api/safe-response';
import { adminActor } from '@/app/lib/admins/model';
import { MAIN_ADMIN_ONLY, verifyAdminSession } from '@/app/lib/admins/session';
import type { Actor } from '@/app/lib/cleaners/model';
import { recordAdminAction, type SignedInAdmin } from '@/app/lib/firebase/server-admins';

/** What an admin route handler is given: who is signed in, and the actor their records carry. */
export interface AdminSession {
  admin: SignedInAdmin;
  actor: Actor;
}

export interface AdminRouteOptions {
  /** `'main'`: a main admin's route, refused to an admin (Kian's ruling: the main admin adds and removes admins and sets their level). */
  level?: 'main';
  /** Record a GET in the activity log too. Every other method always is. */
  record?: boolean;
}

/** An admin route handler: the request, the route's context, and the session. */
export type AdminHandler<C> = (request: NextRequest, context: C, session: AdminSession) => Promise<Response>;

/** The lines a handler asked the door to add after the request's own (recordAlso), by request. */
const alsoRecorded = new WeakMap<Request, { method: string; path: string; status: number }[]>();

/**
 * One more line in the activity log, for a request that does a second admin action besides its own (Add a job with
 * "Already cleaned", 2026-11-06: the job is added and recorded cleaned in one request, and the log holds both lines,
 * as an Add then a Record as cleaned would). `path` is the route that action has on its own, so the line reads as that
 * action's does. The door writes it after the request's own line, a millisecond later, and only when the request's own
 * line is written (a status below 400); never with a body or a query.
 */
export function recordAlso(request: NextRequest, method: string, path: string, status: number): void {
  alsoRecorded.set(request, [...(alsoRecorded.get(request) ?? []), { method, path, status }]);
}

/** Wrap a route handler in the admin door. See the file's header. */
export function adminRoute<C>(handler: AdminHandler<C>, options: AdminRouteOptions = {}): (request: NextRequest, context: C) => Promise<Response> {
  return async (request: NextRequest, context: C) => {
    const verified = await verifyAdminSession(request);
    if (!verified.ok) return noStore(apiFailure(verified.refusal));
    const { admin } = verified;
    if (options.level === 'main' && admin.level !== 'main') return noStore(apiFailure(MAIN_ADMIN_ONLY));

    const response = await handler(request, context, { admin, actor: adminActor(admin) });

    const recorded = options.record === true || (request.method !== 'GET' && request.method !== 'HEAD');
    if (recorded && response.status < 400) {
      const at = Date.now();
      const record = {
        at: new Date(at).toISOString(),
        admin: { id: admin.id, name: admin.name, level: admin.level },
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
      };
      // Any line the handler asked for (recordAlso) follows, in order, each a millisecond after the one before.
      const also = (alsoRecorded.get(request) ?? []).map((line, i) => ({ ...record, at: new Date(at + i + 1).toISOString(), method: line.method, path: line.path, status: line.status }));
      after(async () => {
        await recordAdminAction(record);
        for (const line of also) await recordAdminAction(line);
      });
    }
    return response;
  };
}
