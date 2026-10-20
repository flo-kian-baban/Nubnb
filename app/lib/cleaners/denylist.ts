/**
 * The list of codes never given out (security rule, 2026-10-19; codes.ts): every code or PIN ever issued whose four
 * digits appeared anywhere in Nubnb's public git history. Read from the server's environment on each use, keyed by the
 * cleaner key (CLEANER_SESSION_SECRET): `unkeyed` when the list is set and cannot be checked — issuing a cleaner code
 * or setting an admin PIN then fails closed, since a value the list would refuse cannot be told apart. Server-only:
 * it reads the environment and the cleaner key.
 */

import { CODE_DENYLIST_VAR, readCodeDenylist, type CodeDenylist } from './codes';
import { getCleanerSecrets } from './secrets';

export function codeDenylist(): { kind: 'ok'; denylist: CodeDenylist | null } | { kind: 'unkeyed' } {
  const secrets = getCleanerSecrets();
  const read = readCodeDenylist(process.env[CODE_DENYLIST_VAR], secrets.kind === 'ok' ? secrets.sessionKey : null);
  if (read.kind === 'unkeyed') return { kind: 'unkeyed' };
  return { kind: 'ok', denylist: read.kind === 'ok' ? read.denylist : null };
}
