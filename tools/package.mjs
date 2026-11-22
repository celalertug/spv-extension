// Builds the Chrome Web Store upload: dist/startag-<version>.zip with only what the extension runs
// (manifest.json, NOTICE.txt, src/*.js, data/, the manifest's icons): no tests, tools, node_modules
// or README assets. Checks first that every file the manifest names exists and that every module
// src/ imports is in the package. Needs the `zip` command (macOS, Linux).
// Usage: node tools/package.mjs   (npm run package)
import { readFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const at = (p) => path.join(root, p);
const manifest = JSON.parse(await readFile(at('manifest.json'), 'utf8'));

async function walk(dir) {
  const out = [];
  for (const e of await readdir(at(dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const files = new Set(['manifest.json', 'NOTICE.txt']);
for (const f of await walk('src')) if (f.endsWith('.js')) files.add(f);
for (const f of await walk('data')) if (f.endsWith('.json')) files.add(f);

// Files the manifest names.
const named = [
  ...Object.values(manifest.icons || {}),
  ...Object.values((manifest.action && manifest.action.default_icon) || {}),
  manifest.background && manifest.background.service_worker,
  ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
].filter(Boolean);
named.forEach((f) => files.add(f));

const problems = [];
for (const f of files) {
  try { await stat(at(f)); } catch { problems.push(`missing: ${f}`); }
}
// Relative imports of the packaged modules.
for (const f of [...files].filter((f) => f.endsWith('.js'))) {
  const text = await readFile(at(f), 'utf8');
  for (const m of text.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
    const dep = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
    if (!files.has(dep)) problems.push(`${f} imports ${m[1]}, which is not packaged`);
  }
}
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) problems.push(`bad version "${manifest.version}"`);
if ((manifest.description || '').length > 132) problems.push(`description is ${manifest.description.length} characters (max 132)`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

await mkdir(at('dist'), { recursive: true });
const zip = at(`dist/startag-${manifest.version}.zip`);
await rm(zip, { force: true });
const list = [...files].sort();
execFileSync('zip', ['-X', '-q', '-9', zip, '-@'], { cwd: root, input: list.join('\n') });
const { size } = await stat(zip);
const top = [...new Set(list.map((f) => f.split('/')[0]))].join(', ');
console.log(`${path.relative(root, zip)}: ${list.length} files (${top}), ${(size / 1e6).toFixed(1)} MB`);
