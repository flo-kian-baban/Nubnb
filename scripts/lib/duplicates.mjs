/**
 * Duplicate codes and PINs (Kian's ruling of 2026-11-06, the security round, item 1): no cleaner code equals another
 * cleaner's code or any admin PIN, and no admin PIN equals another's. The product refuses a duplicate when a code is
 * generated or typed and when a PIN is set (server-cleaners.ts codeAvailability and the drawn code's transaction;
 * server-admins.ts pinHeld and the cleaner_codes read); this finds any that exists in stored data, by role and name
 * only. Nothing here prints a value: each finding names the holders, never the digits.
 */

const four = (v) => typeof v === 'string' && /^\d{4}$/.test(v);

/**
 * The duplicates in an export's `cleaners` and `admins` documents, plus the shared PIN when given:
 *   codeShared     a cleaner code held by two or more accounts (any status)
 *   pinShared      an admin PIN held by two or more admins
 *   codeIsPin      a cleaner code that is also an admin's PIN
 *   sharedPinHeld  the shared PIN (ADMIN_PIN) held as a code or a PIN
 * Each finding lists `who`: "cleaner Ana (active)", "admin Kian (main)". Never a value.
 */
export function findDuplicates(cleaners, admins, sharedPin = null) {
  const codeHolders = new Map();
  for (const c of cleaners) {
    if (!four(c.code)) continue;
    const who = `${c.role === 'handyman' ? 'handyman' : 'cleaner'} ${c.name ?? '(unnamed)'} (${c.status ?? 'unknown'})`;
    codeHolders.set(c.code, [...(codeHolders.get(c.code) ?? []), who]);
  }
  const pinHolders = new Map();
  for (const a of admins) {
    const pin = a.pin?.state === 'readable' ? a.pin.value : null;
    if (!four(pin)) continue;
    const who = `admin ${a.name ?? '(unnamed)'} (${a.level ?? 'unknown'})`;
    pinHolders.set(pin, [...(pinHolders.get(pin) ?? []), who]);
  }
  const codeShared = [...codeHolders.values()].filter((who) => who.length > 1).map((who) => ({ who }));
  const pinShared = [...pinHolders.values()].filter((who) => who.length > 1).map((who) => ({ who }));
  const codeIsPin = [];
  for (const [code, who] of codeHolders) if (pinHolders.has(code)) codeIsPin.push({ who: [...who, ...pinHolders.get(code)] });
  const sharedPinHeld = [];
  if (four(sharedPin)) {
    if (codeHolders.has(sharedPin)) sharedPinHeld.push({ who: codeHolders.get(sharedPin) });
    if (pinHolders.has(sharedPin)) sharedPinHeld.push({ who: pinHolders.get(sharedPin) });
  }
  return {
    codeShared,
    pinShared,
    codeIsPin,
    sharedPinHeld,
    counts: { cleanersWithCode: codeHolders.size, adminsWithPin: [...pinHolders.values()].reduce((n, who) => n + who.length, 0) },
    clean: codeShared.length === 0 && pinShared.length === 0 && codeIsPin.length === 0 && sharedPinHeld.length === 0,
  };
}

/** The findings as lines to print, by role and name only. */
export function duplicateLines(found) {
  const lines = [];
  for (const d of found.codeShared) lines.push(`a cleaner code held by two accounts: ${d.who.join(' and ')}`);
  for (const d of found.pinShared) lines.push(`an admin PIN held by two admins: ${d.who.join(' and ')}`);
  for (const d of found.codeIsPin) lines.push(`a cleaner code that is also an admin PIN: ${d.who.join(' and ')}`);
  for (const d of found.sharedPinHeld) lines.push(`the shared PIN held as a code or PIN: ${d.who.join(' and ')}`);
  return lines;
}
