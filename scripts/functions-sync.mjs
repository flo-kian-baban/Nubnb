#!/usr/bin/env node
/**
 * Copy the availability module into the Cloud Functions package.
 *
 *   node scripts/functions-sync.mjs
 *
 * The Firebase CLI packs only the functions/ directory, and the refresh the
 * function runs is the app's own app/lib/availability module (plus the SSRF
 * guard it fetches through). Rather than a second copy of that code living
 * in git, this copies it in before every build and deploy (functions'
 * `build` script and firebase.json's predeploy both run it), into
 * functions/src/lib/, which is git-ignored. Nothing else is copied: the
 * module imports nothing from the app but url-guard.ts.
 */

import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FROM = join(ROOT, 'app', 'lib');
const TO = join(ROOT, 'functions', 'src', 'lib');

const COPY = [
  ['availability', 'availability'],
  ['api/url-guard.ts', 'api/url-guard.ts'],
];

rmSync(TO, { recursive: true, force: true });
let files = 0;
for (const [from, to] of COPY) {
  const source = join(FROM, from);
  const target = join(TO, to);
  mkdirSync(dirname(target), { recursive: true });
  // property.ts adapts the app's Property type for the pages; the function has no properties to adapt.
  cpSync(source, target, { recursive: true, filter: (path) => !path.endsWith('.test.ts') && !path.endsWith('/property.ts') });
  files += statSync(source).isDirectory() ? readdirSync(source).length : 1;
}
console.log(`functions-sync: ${files} files copied into functions/src/lib`);
