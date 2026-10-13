// Use: node --import ./tests/tools/ts-hook.mjs your-script.mjs   (then `await import(`${ROOT}/app/lib/...ts`)`)
import { register } from 'node:module';
register(new URL('./ts-loader.mjs', import.meta.url).href, import.meta.url);
