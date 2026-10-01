// Make app/lib/pdf/logo.ts from public/logo-nubnb.png (dispatch 23E): the
// mark scaled to 400 px wide, flattened on white, as raw RGB rows deflated
// once here, so the PDF writer embeds it as a Flate-compressed image
// XObject without compressing anything at run time. Run after the logo
// changes: node scripts/make-pdf-logo.mjs
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const SOURCE = new URL('../public/logo-nubnb.png', import.meta.url);
const TARGET = new URL('../app/lib/pdf/logo.ts', import.meta.url);
const WIDTH = 400;

const source = readFileSync(SOURCE);
const { data, info } = await sharp(source).resize({ width: WIDTH, kernel: 'lanczos3' }).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
if (info.channels !== 3) throw new Error(`expected 3 channels, got ${info.channels}`);
const deflated = deflateSync(data, { level: 9 });
const base64 = deflated.toString('base64');
const lines = base64.match(/.{1,120}/g) ?? [];
const out = `/**
 * The NuBNB Suites mark for the PDF writer (dispatch 23E): public/logo-nubnb.png
 * (sha256 ${createHash('sha256').update(source).digest('hex').slice(0, 16)}…) scaled to ${info.width} × ${info.height}, flattened on white,
 * raw RGB rows deflated once by scripts/make-pdf-logo.mjs. The writer embeds
 * these bytes as a /FlateDecode /DeviceRGB image XObject; nothing is
 * compressed at run time, and the same bytes go into every statement.
 *
 * Generated: do not edit by hand. ${deflated.length} bytes deflated from ${data.length}.
 */

export const LOGO_WIDTH = ${info.width};
export const LOGO_HEIGHT = ${info.height};

const LOGO_BASE64 =
${lines.map((line) => `  '${line}'`).join(' +\n')};

let cached: Uint8Array | null = null;

/** The deflated RGB rows, decoded once. Client-safe: atob is in every browser and in Node 16+. */
export function logoBytes(): Uint8Array {
  if (cached) return cached;
  const binary = atob(LOGO_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  cached = bytes;
  return bytes;
}
`;
writeFileSync(TARGET, out);
console.log(`wrote app/lib/pdf/logo.ts: ${info.width}x${info.height}, raw ${data.length} bytes, deflated ${deflated.length} bytes, base64 ${base64.length} chars`);
