// ESM loader hooks: run the Nubnb repo's TypeScript modules in Node 20, unmodified.
// - '@/x' resolves to <ROOT>/x (ROOT = env NUBNB_ROOT, else this repository); extensionless specifiers try .ts, .tsx, /index.ts(x).
// - 'server-only' and stylesheet imports become empty modules.
// - .ts/.tsx are transpiled with the repo's own `typescript` (transpileModule: no type check).
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const require = createRequire(ROOT + '/package.json');
const ts = require('typescript');
const EMPTY = 'data:text/javascript,export default {};';

function tryFile(base) {
  const cands = [base, base + '.ts', base + '.tsx', base + '.mjs', base + '.js', base + '/index.ts', base + '/index.tsx'];
  for (const c of cands) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier === 'server-only' || specifier === 'client-only') return { url: EMPTY, shortCircuit: true };
  if (/\.(css|scss|sass)$/.test(specifier)) return { url: EMPTY, shortCircuit: true };
  if (specifier.startsWith('@/')) {
    const f = tryFile(resolvePath(ROOT, specifier.slice(2)));
    if (f) return { url: pathToFileURL(f).href, shortCircuit: true };
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL && context.parentURL.startsWith('file:')) {
    const f = tryFile(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier));
    if (f) return { url: pathToFileURL(f).href, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith('file:') && /\.(ts|tsx)$/.test(url)) {
    const file = fileURLToPath(url);
    const out = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, sourceMap: false },
    });
    return { format: 'module', source: out.outputText, shortCircuit: true };
  }
  return next(url, context);
}
