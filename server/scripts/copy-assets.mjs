// SQL migrations and eval fixtures are data, not TypeScript, so tsc does not
// emit them. Mirror them into dist/ so the built server can read them.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [
  ['src/db/migrations', 'dist/db/migrations'],
  ['src/eval/golden.json', 'dist/eval/golden.json'],
];

for (const [from, to] of pairs) {
  await mkdir(dirname(resolve(root, to)), { recursive: true });
  await cp(resolve(root, from), resolve(root, to), { recursive: true });
  console.log(`[build] copied ${from} -> ${to}`);
}
