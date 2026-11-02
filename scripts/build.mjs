import { build } from 'esbuild';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

// Release: `node scripts/build.mjs` → dist/. Debug code is compiled out.
// Dev: `node scripts/build.mjs --dev` → dist-dev/. The debug log is always on.
const dev = process.argv.includes('--dev');
const outdir = dev ? 'dist-dev' : 'dist';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: ['src/main.ts', 'src/content.ts', 'src/background.ts', 'src/popup.ts'],
  outdir,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  define: { __DEV__: String(dev) },
});
for (const file of ['content.css', 'popup.html', 'popup.css']) await copyFile(`src/${file}`, `${outdir}/${file}`);
await cp('src/icons', `${outdir}/icons`, { recursive: true });
const icons = Object.fromEntries([16, 32, 48, 128].map(size => [size, `icons/icon${size}.png`]));
const matches = ['https://x.com/*', 'https://twitter.com/*'];
await writeFile(`${outdir}/manifest.json`, JSON.stringify({
  manifest_version: 3,
  name: dev ? 'OwnYourTimeline (dev)' : 'OwnYourTimeline',
  version,
  description: 'Filter your X Home feed with a plain-language instruction, classified by TypeSafe Jev.',
  minimum_chrome_version: '120',
  icons,
  permissions: ['storage'],
  host_permissions: ['https://api.typesafe.ai/*', 'https://pbs.twimg.com/*'],
  background: { service_worker: 'background.js' },
  action: { default_popup: 'popup.html', default_title: 'OwnYourTimeline', default_icon: icons },
  content_scripts: [
    { matches, js: ['main.js'], world: 'MAIN', run_at: 'document_start' },
    { matches, css: ['content.css'], js: ['content.js'], run_at: 'document_start' },
  ],
}, null, 2) + '\n');
console.log(`Built ${dev ? 'dev' : 'release'} extension in ${outdir}/`);
