/**
 * Rewrites the REAL src/extension.js so it can be imported under node:
 * `gi://` + `resource:///` imports are redirected to ./stubs.mjs, and the
 * internal classes/helpers are re-exported for the tests.
 *
 * No logic is altered, and the copy is rebuilt from the live source on every
 * run, so the tests can never drift onto a stale fork of the extension.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const here = dirname(new URL(import.meta.url).pathname);
const SRC = process.argv[2] ?? join(here, '..', 'src', 'extension.js');
const OUT = join(here, 'ext-under-test.mjs');

let src = readFileSync(SRC, 'utf8');

const importRe = /^import\s+(?:(\w+)|\*\s+as\s+(\w+)|\{\s*([^}]+?)\s*\})\s+from\s+'(?:gi:\/\/|resource:\/\/\/)[^']+';\s*$/gm;
const names = new Set();
let stripped = 0;
src = src.replace(importRe, (_m, def, star, named) => {
    stripped++;
    if (def) names.add(def);
    else if (star) names.add(star);
    else named.split(',').forEach(n => names.add(n.trim()));
    return '';
});

if (stripped === 0)
    throw new Error('tests/build.mjs: no gi:// or resource:/// imports matched — has src/extension.js changed shape?');

// The top-level class is a default export in the real source (required by the
// GNOME Shell extension loader) — re-declare it as a named class here so it
// can be re-exported alongside everything else in one footer line.
src = src.replace(/^export default class StageManagerExtension/m, 'class StageManagerExtension');

const header = `import { ${[...names].join(', ')} } from './stubs.mjs';\n`;
const footer = `\nexport { MaximizeToWorkspace, StageSidebar, ArcSidebar, StageManagerExtension, _isNormal, _groupByApp };\n`;

writeFileSync(OUT, header + src + footer);
console.log(`built ${OUT} (stripped ${stripped} imports: ${[...names].join(', ')})`);
