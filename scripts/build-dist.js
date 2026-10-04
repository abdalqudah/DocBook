// Builds dist/docbook: one bundled app.js (all libraries inside, no node_modules and no `npm install` needed)
// plus the files it reads at run time (views, locales, migrations, public assets, PDF fonts).
//   npm run build   →   dist/docbook/  and  dist/docbook-<version>-dist.zip
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild'); // eslint-disable-line import/no-extraneous-dependencies

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'docbook');
const { version } = require('../package.json');

// Where a library's data files live in the build (instead of node_modules).
const REMAP = [
  ['node_modules/@expo-google-fonts/', 'vendor/fonts/'],
  ['node_modules/pdfkit/js', 'vendor/pdfkit'],
  ['node_modules/@jsquash/webp/codec/', 'vendor/webp/'],
  ['node_modules/@jsquash/jpeg/codec/', 'vendor/jpeg/'],
];
const remap = (rel) => REMAP.reduce((p, [from, to]) => (p.startsWith(from) ? to + p.slice(from.length) : p), rel);
const at = (rel) => `require("path").join(__DOCBOOK_ROOT, ${JSON.stringify(rel)})`;

// Every module's __dirname / require.resolve() points at its place in the build, relative to app.js.
const paths = {
  name: 'paths',
  setup(build) {
    build.onLoad({ filter: /\.(c?js)$/ }, (args) => {
      let src = fs.readFileSync(args.path, 'utf8');
      if (!/__dirname|require\.resolve\(/.test(src)) return null;
      const rel = remap(path.relative(ROOT, path.dirname(args.path)).split(path.sep).join('/'));
      src = src.replace(/require\.resolve\((['"])([^'"]+)\1\)/g, (m, q, id) => at(remap(`node_modules/${id}`)))
        .replace(/\b__dirname\b/g, at(rel));
      return { contents: src, loader: 'js' };
    });
  },
};

// Knex dialects and optional drivers that DocBook never loads.
const EXTERNAL = ['sqlite3', 'better-sqlite3', 'tedious', 'oracledb', 'mysql', 'pg-query-stream', 'pg-native', 'cloudflare:sockets', 'mariadb', 'mariadb/callback'];

function copy(from, to, filter) {
  fs.cpSync(path.join(ROOT, from), path.join(OUT, to), { recursive: true, filter });
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'dist-entry.js')],
    outfile: path.join(OUT, 'app.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    minify: true,
    keepNames: true,
    legalComments: 'none',
    external: EXTERNAL,
    // The image codecs (emscripten) build a URL from import.meta.url even though their WebAssembly is handed to them.
    define: { 'import.meta.url': '"file:///docbook/app.js"' },
    banner: { js: '#!/usr/bin/env node\nconst __DOCBOOK_ROOT = __dirname;' },
    plugins: [paths],
    logLevel: 'warning',
  });

  copy('src/views', 'src/views');
  copy('src/locales', 'src/locales');
  copy('src/db/migrations', 'src/db/migrations');
  copy('public', 'public');
  copy('node_modules/pdfkit/js/data', 'vendor/pdfkit/data');
  // Image compression on upload (core/imageopt): the WebAssembly codecs, read from disk at start.
  for (const f of ['enc/webp_enc.wasm', 'enc/webp_enc_simd.wasm', 'dec/webp_dec.wasm']) copy(`node_modules/@jsquash/webp/codec/${f}`, `vendor/webp/${f}`);
  copy('node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm', 'vendor/jpeg/dec/mozjpeg_dec.wasm');
  for (const [pkg, file] of [['noto-naskh-arabic', 'NotoNaskhArabic'], ['noto-sans', 'NotoSans']]) {
    for (const w of ['400Regular', '700Bold']) copy(`node_modules/@expo-google-fonts/${pkg}/${w}/${file}_${w}.ttf`, `vendor/fonts/${pkg}/${w}/${file}_${w}.ttf`);
  }
  copy('.env.example', '.env.example');
  copy('docs/INSTALL.md', 'INSTALL.md');
  fs.writeFileSync(path.join(OUT, 'package.json'), `${JSON.stringify({
    name: 'docbook', version, private: true, main: 'app.js', engines: { node: '>=20' },
    scripts: { start: 'node app.js', migrate: 'node app.js migrate' },
  }, null, 2)}\n`);

  // CloudLinux NodeJS Selector keeps an app's modules in its own virtual environment and links it as
  // "node_modules" in the app root, so the build must never contain anything with that name.
  const clash = execFileSync('find', ['.', '-name', 'node_modules'], { cwd: OUT, encoding: 'utf8' }).trim();
  if (clash) throw new Error(`dist must not contain node_modules:\n${clash}`);

  // Files sit at the top of the zip, so it extracts straight into the application root.
  const zip = path.join(ROOT, 'dist', `docbook-${version}-dist.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: OUT });
  console.log(`Built ${path.relative(ROOT, OUT)} and ${path.relative(ROOT, zip)}`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
