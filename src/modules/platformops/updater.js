// In-app update of an installed DocBook build from its dist zip (worker: platformops).
//
//   upload  → validate the zip (size, zip-slip, symlinks, node_modules, .env, app.js with the dist banner,
//             package.json named "docbook") and extract it into <root>/.updates/<timestamp>/
//   activate→ copy the files the build owns (app.js, package.json, src/, public/, vendor/, INSTALL.md, .env.example)
//             into <root>/.updates/backup-<timestamp>/, copy the staged files over the app, touch tmp/restart.txt
//             (Passenger / LiteSpeed) and exit after the response so the host starts the new version, which runs its
//             migrations on start.
//   rollback→ copy the latest backup back the same way (and consume it), then restart.
// Files are copied over (not deleted first): a file the other version does not have is left in place, so migration
// files of a newer version stay next to an older one after a rollback (knex needs them; the schema changes are
// additive). .env, node_modules and anything outside the app root are never written.
// Available only in the installed dist build (never when running from source).
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { AppError } = require('../../core/errors');

const DEFAULT_ROOT = path.join(__dirname, '..', '..', '..');
const MAX_ZIP_BYTES = 60 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 400 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const OWNED = ['app.js', 'package.json', 'src', 'public', 'vendor', 'INSTALL.md', '.env.example'];
const KEEP_BACKUPS = 3;
const UPDATES = '.updates';

const fail = (code, message, details) => new AppError(code, message, 422, details);

/** True when `text` (the start of app.js) is the bundled build's entry: the shebang + the __DOCBOOK_ROOT banner. */
const hasDistBanner = (text) => {
  const s = String(text || '').replace(/^﻿/, '');
  return s.startsWith('#!/usr/bin/env node') && s.slice(0, 400).includes('__DOCBOOK_ROOT');
};

function readHead(file, bytes = 400) {
  let fd;
  try { fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(bytes); const n = fs.readSync(fd, buf, 0, bytes, 0); return buf.slice(0, n).toString('utf8'); } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * The app root runs the installed dist build (not the source tree). Decided by app.js alone — the file the host starts:
 * a dist unpacked over an older source upload still has leftover src/*.js files, but they are never loaded.
 */
const isDistBuild = (root = DEFAULT_ROOT) => hasDistBanner(readHead(path.join(root, 'app.js')));

function readVersion(dir) {
  try { const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); return p.version || null; } catch { return null; }
}

/** Compares dotted versions: <0, 0, >0. */
function compareVersions(a, b) {
  const pa = String(a || '0').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

// ---------------------------------------------------------------- validation (pure: works on the buffer)
/** Normalised entry name, or throws UPDATE_UNSAFE_PATH for anything that could land outside the app root. */
function safeName(raw) {
  const name = String(raw || '');
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw fail('UPDATE_UNSAFE_PATH', 'The zip contains an unsafe path.', { entry: name });
  const clean = name.replace(/^(\.\/)+/, '');
  const parts = clean.split('/').filter((p, i, a) => p !== '' || i === a.length - 1);
  if (parts.some((p) => p === '..' || p === '.')) throw fail('UPDATE_UNSAFE_PATH', 'The zip contains an unsafe path.', { entry: name });
  return clean;
}

const isSymlink = (entry) => ((entry.header.attr >>> 16) & 0o170000) === 0o120000; // eslint-disable-line no-bitwise

/**
 * Checks an uploaded zip and returns { zip, version, name, files, bytes }.
 * Error codes: UPDATE_EMPTY, UPDATE_TOO_BIG, UPDATE_NOT_ZIP, UPDATE_UNSAFE_PATH, UPDATE_SYMLINK, UPDATE_NODE_MODULES,
 * UPDATE_ENV_FILE, UPDATE_UNEXPECTED_FILE, UPDATE_MISSING_APP, UPDATE_NOT_DIST, UPDATE_MISSING_PACKAGE, UPDATE_WRONG_NAME.
 */
function inspectZip(buffer) {
  if (!buffer || !buffer.length) throw fail('UPDATE_EMPTY', 'Choose the zip file.');
  if (buffer.length > MAX_ZIP_BYTES) throw fail('UPDATE_TOO_BIG', 'The file is too big.', { mb: MAX_ZIP_BYTES / 1048576 });
  let zip;
  let entries;
  try { zip = new AdmZip(buffer); entries = zip.getEntries(); } catch { throw fail('UPDATE_NOT_ZIP', 'This is not a zip file.'); }
  if (!entries.length) throw fail('UPDATE_NOT_ZIP', 'This is not a zip file.');
  if (entries.length > MAX_ENTRIES) throw fail('UPDATE_TOO_BIG', 'The file is too big.', { mb: MAX_ZIP_BYTES / 1048576 });
  let bytes = 0; let files = 0;
  const names = new Map();
  for (const e of entries) {
    const name = safeName(e.entryName);
    if (isSymlink(e)) throw fail('UPDATE_SYMLINK', 'The zip contains a link.', { entry: name });
    const parts = name.split('/').filter(Boolean);
    if (parts.includes('node_modules')) throw fail('UPDATE_NODE_MODULES', 'The zip contains node_modules.', { entry: name });
    if (parts.some((p) => /^\.env($|\.)/.test(p) && p !== '.env.example')) throw fail('UPDATE_ENV_FILE', 'The zip contains an .env file.', { entry: name });
    if (!OWNED.includes(parts[0])) throw fail('UPDATE_UNEXPECTED_FILE', 'The zip contains a file that is not part of DocBook.', { entry: name });
    if (!e.isDirectory) { files += 1; bytes += Number(e.header.size) || 0; names.set(name, e); }
  }
  if (bytes > MAX_UNPACKED_BYTES) throw fail('UPDATE_TOO_BIG', 'The file is too big.', { mb: MAX_ZIP_BYTES / 1048576 });
  const app = names.get('app.js');
  if (!app) throw fail('UPDATE_MISSING_APP', 'app.js is missing at the top of the zip.');
  if (!hasDistBanner(app.getData().slice(0, 400).toString('utf8'))) throw fail('UPDATE_NOT_DIST', 'app.js is not a DocBook dist build.');
  const pkgEntry = names.get('package.json');
  if (!pkgEntry) throw fail('UPDATE_MISSING_PACKAGE', 'package.json is missing at the top of the zip.');
  let pkg;
  try { pkg = JSON.parse(pkgEntry.getData().toString('utf8')); } catch { throw fail('UPDATE_MISSING_PACKAGE', 'package.json is missing at the top of the zip.'); }
  if (!pkg || pkg.name !== 'docbook') throw fail('UPDATE_WRONG_NAME', 'package.json does not belong to DocBook.', { name: pkg && pkg.name });
  return { zip, names, version: String(pkg.version || ''), files, bytes };
}

// ---------------------------------------------------------------- file system
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '').replace('Z', ''); // 20261001-101500123
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function updatesDir(root) { const d = path.join(root, UPDATES); fs.mkdirSync(d, { recursive: true }); return d; }

function list(root, kind) {
  const d = path.join(root, UPDATES);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((n) => (kind === 'backup' ? n.startsWith('backup-') : /^\d{8}-\d{6}/.test(n)))
    .filter((n) => fs.statSync(path.join(d, n)).isDirectory()).sort().reverse()
    .map((n) => ({ id: n, dir: path.join(d, n), ...(readJson(path.join(d, n, '.docbook-update.json')) || {}) }));
}

/** Current state for the admin page. */
function status(root = DEFAULT_ROOT) {
  return {
    dist: isDistBuild(root), root, version: readVersion(root), staged: list(root, 'staged')[0] || null, backups: list(root, 'backup'),
    maxMb: MAX_ZIP_BYTES / 1048576, restartFile: path.join(root, 'tmp', 'restart.txt'),
  };
}

function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

/** Validates and extracts an uploaded zip into .updates/<timestamp>/ (replacing an earlier staged upload). */
function stage(buffer, { root = DEFAULT_ROOT, by = null } = {}) {
  const info = inspectZip(buffer);
  const base = updatesDir(root);
  for (const s of list(root, 'staged')) rm(s.dir);
  let id = stamp(); let n = 1;
  while (fs.existsSync(path.join(base, id))) { id = `${stamp()}-${n}`; n += 1; }
  const dir = path.join(base, id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const [name, entry] of info.names) {
      const target = path.resolve(dir, name);
      if (!target.startsWith(dir + path.sep)) throw fail('UPDATE_UNSAFE_PATH', 'The zip contains an unsafe path.', { entry: name });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
    }
  } catch (e) { rm(dir); throw e; }
  const meta = { version: info.version, from: readVersion(root), files: info.files, bytes: info.bytes, zipBytes: buffer.length, uploadedAt: new Date().toISOString(), by };
  fs.writeFileSync(path.join(dir, '.docbook-update.json'), JSON.stringify(meta, null, 2));
  return { id, dir, ...meta };
}

function discard(root = DEFAULT_ROOT) {
  const s = list(root, 'staged')[0];
  if (!s) throw fail('UPDATE_NOTHING_STAGED', 'There is no uploaded update.');
  rm(s.dir);
  return s;
}

/** Copies the owned files that exist in `from` over `to`. */
function copyOwned(from, to) {
  for (const item of OWNED) {
    const src = path.join(from, item);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(to, item), { recursive: true, force: true, dereference: false, errorOnExist: false });
  }
}

function prune(root) {
  for (const b of list(root, 'backup').slice(KEEP_BACKUPS)) rm(b.dir);
}

function touchRestart(root) {
  try {
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tmp', 'restart.txt'), `restart requested ${new Date().toISOString()}\n`);
  } catch { /* best effort: the process exit below restarts it under pm2 / Passenger anyway */ }
}

function requireDist(root) {
  if (!isDistBuild(root)) throw new AppError('UPDATE_SOURCE_BUILD', 'Updates are available only in the installed dist build.', 409);
}

/** Backs up the current files, copies the staged update over them and requests a restart. */
function activate({ root = DEFAULT_ROOT, by = null } = {}) {
  requireDist(root);
  const s = list(root, 'staged')[0];
  if (!s) throw fail('UPDATE_NOTHING_STAGED', 'There is no uploaded update.');
  if (!hasDistBanner(readHead(path.join(s.dir, 'app.js')))) throw fail('UPDATE_NOT_DIST', 'app.js is not a DocBook dist build.');
  let backupId = `backup-${stamp()}`;
  for (let n = 1; fs.existsSync(path.join(updatesDir(root), backupId)); n += 1) backupId = `backup-${stamp()}-${n}`;
  const backup = path.join(updatesDir(root), backupId);
  fs.mkdirSync(backup, { recursive: true });
  const from = readVersion(root);
  copyOwned(root, backup);
  fs.writeFileSync(path.join(backup, '.docbook-update.json'), JSON.stringify({ version: from, createdAt: new Date().toISOString(), replacedBy: s.version, by }, null, 2));
  try {
    copyOwned(s.dir, root);
  } catch (e) {
    // Never leave a half-copied app: put the backup back before reporting the error.
    try { copyOwned(backup, root); } catch { /* reported below */ }
    throw new AppError('UPDATE_COPY_FAILED', `The update could not be copied: ${e.message}`, 500);
  }
  rm(s.dir);
  prune(root);
  touchRestart(root);
  return { from, to: s.version, backup: backupId };
}

/** Restores the latest backup over the app (the backup is used up) and requests a restart. */
function rollback({ root = DEFAULT_ROOT } = {}) {
  requireDist(root);
  const b = list(root, 'backup')[0];
  if (!b) throw fail('UPDATE_NO_BACKUP', 'There is no backup to restore.');
  if (!hasDistBanner(readHead(path.join(b.dir, 'app.js')))) throw fail('UPDATE_NOT_DIST', 'app.js is not a DocBook dist build.');
  const from = readVersion(root);
  copyOwned(b.dir, root);
  rm(b.dir);
  touchRestart(root);
  return { from, to: b.version || readVersion(root), backup: b.id };
}

/** Exits after the response has been sent so the host (Passenger, pm2, systemd…) starts the new files. */
function restartAfter(res, delayMs = 400) {
  if (process.env.NODE_ENV === 'test') return;
  res.on('finish', () => setTimeout(() => process.exit(0), delayMs));
}

// ---------------------------------------------------------------- one-step install (same flow as RemoteWay's system update)
// Upload the package in a normal form → validate → back up the running files → write the new files → restart.
// Lenient like RemoteWay: a zip whose files sit inside one top folder (e.g. "docbook/") is accepted, and files that are
// not part of the build (__MACOSX, .DS_Store, notes…) are skipped instead of rejecting the package. Unsafe paths,
// links, node_modules and .env files are still refused.
const SKIP_TOPS = new Set(['__MACOSX', 'node_modules', 'tmp', '.updates', '.git']);
const LOG = 'update-log.json';

function inspectPackage(buffer) {
  if (!buffer || !buffer.length) throw fail('UPDATE_EMPTY', 'Choose the zip file.');
  if (buffer.length > MAX_ZIP_BYTES) throw fail('UPDATE_TOO_BIG', 'The file is too big.', { mb: MAX_ZIP_BYTES / 1048576 });
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw fail('UPDATE_NOT_ZIP', 'This is not a zip file.');
  let entries;
  try { entries = new AdmZip(buffer).getEntries(); } catch { throw fail('UPDATE_NOT_ZIP', 'This is not a zip file.'); }
  if (!entries.length) throw fail('UPDATE_NOT_ZIP', 'This is not a zip file.');
  if (entries.length > MAX_ENTRIES) throw fail('UPDATE_TOO_BIG', 'The file is too big.', { mb: MAX_ZIP_BYTES / 1048576 });
  const all = entries.map((e) => ({ e, name: String(e.entryName || '').replace(/^(\.\/)+/, '') })).filter((x) => !x.name.startsWith('__MACOSX/'));
  // One wrapper folder around everything (a re-zipped folder) → strip it.
  const tops = new Set(all.map((x) => x.name.split('/')[0]));
  const prefix = tops.size === 1 && !all.some((x) => x.name === 'app.js') && all.some((x) => x.name.endsWith('/app.js')) ? `${[...tops][0]}/` : '';
  const files = new Map();
  let bytes = 0;
  for (const { e, name } of all) {
    if (e.isDirectory || !name.startsWith(prefix)) continue;
    const rel = safeName(name.slice(prefix.length));
    const parts = rel.split('/').filter(Boolean);
    if (!parts.length || SKIP_TOPS.has(parts[0]) || parts.includes('.DS_Store')) continue;
    if (parts.includes('node_modules')) continue;
    if (parts.some((p) => /^\.env($|\.)/.test(p) && p !== '.env.example')) continue; // never overwrite settings
    if (!OWNED.includes(parts[0])) continue; // not part of the build: ignored
    if (isSymlink(e)) throw fail('UPDATE_SYMLINK', 'The zip contains a link.', { entry: rel });
    bytes += Number(e.header.size) || 0;
    if (bytes > MAX_UNPACKED_BYTES) throw fail('UPDATE_TOO_BIG', 'The file is too big.', { mb: MAX_ZIP_BYTES / 1048576 });
    files.set(rel, e);
  }
  const app = files.get('app.js');
  if (!app) throw fail('UPDATE_MISSING_APP', 'app.js is missing at the top of the zip.');
  if (!hasDistBanner(app.getData().slice(0, 400).toString('utf8'))) throw fail('UPDATE_NOT_DIST', 'app.js is not a DocBook dist build.');
  const pkgEntry = files.get('package.json');
  if (!pkgEntry) throw fail('UPDATE_MISSING_PACKAGE', 'package.json is missing at the top of the zip.');
  let pkg;
  try { pkg = JSON.parse(pkgEntry.getData().toString('utf8')); } catch { throw fail('UPDATE_MISSING_PACKAGE', 'package.json is missing at the top of the zip.'); }
  if (!pkg || pkg.name !== 'docbook') throw fail('UPDATE_WRONG_NAME', 'package.json does not belong to DocBook.', { name: pkg && pkg.name });
  return { files, version: String(pkg.version || ''), count: files.size, bytes, sha256: require('crypto').createHash('sha256').update(buffer).digest('hex') }; // eslint-disable-line global-require
}

function readLog(root = DEFAULT_ROOT) { return readJson(path.join(root, UPDATES, LOG)) || []; }
function writeLog(root, entry) {
  const f = path.join(updatesDir(root), LOG);
  fs.writeFileSync(f, JSON.stringify([entry, ...readLog(root)].slice(0, 20), null, 2));
}

function listBackups(root = DEFAULT_ROOT) {
  return list(root, 'backup').map((b) => ({ id: b.id, version: b.version || readVersion(b.dir) || '?', createdAt: b.createdAt || fs.statSync(b.dir).mtime, replacedBy: b.replacedBy || null }));
}

function makeBackup(root, meta) {
  let id = `backup-${stamp()}`;
  for (let n = 1; fs.existsSync(path.join(updatesDir(root), id)); n += 1) id = `backup-${stamp()}-${n}`;
  const dir = path.join(updatesDir(root), id);
  fs.mkdirSync(dir, { recursive: true });
  copyOwned(root, dir);
  fs.writeFileSync(path.join(dir, '.docbook-update.json'), JSON.stringify({ version: readVersion(root), createdAt: new Date().toISOString(), ...meta }, null, 2));
  return { id, dir };
}

/** Validates the package, backs up the running files, writes the new ones and requests a restart. */
function install(buffer, { root = DEFAULT_ROOT, by = null, fileName = '' } = {}) {
  requireDist(root);
  const info = inspectPackage(buffer);
  const from = readVersion(root);
  const backup = makeBackup(root, { replacedBy: info.version, by });
  try {
    const rootAbs = path.resolve(root);
    for (const [rel, e] of info.files) {
      const dest = path.resolve(rootAbs, rel);
      if (!dest.startsWith(rootAbs + path.sep)) throw fail('UPDATE_UNSAFE_PATH', 'The zip contains an unsafe path.', { entry: rel });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.getData());
      try { fs.chmodSync(dest, 0o644); } catch { /* keep going */ }
    }
  } catch (e) {
    try { copyOwned(backup.dir, root); } catch { /* reported below */ }
    writeLog(root, { at: new Date().toISOString(), by, action: 'update', from, to: info.version, ok: false, error: e.message, file: String(fileName).slice(0, 120) });
    throw e.code ? e : new AppError('UPDATE_COPY_FAILED', `The update could not be copied: ${e.message}`, 500);
  }
  prune(root);
  const entry = { at: new Date().toISOString(), by, action: 'update', from, to: info.version, ok: true, files: info.count, sha256: info.sha256, file: String(fileName).slice(0, 120) };
  writeLog(root, entry);
  touchRestart(root);
  return entry;
}

/** Puts a chosen backup back (the current files are backed up first) and requests a restart. */
function restore(backupId, { root = DEFAULT_ROOT, by = null } = {}) {
  requireDist(root);
  const id = path.basename(String(backupId || ''));
  const b = list(root, 'backup').find((x) => x.id === id);
  if (!b) throw fail('UPDATE_NO_BACKUP', 'There is no backup to restore.');
  if (!hasDistBanner(readHead(path.join(b.dir, 'app.js')))) throw fail('UPDATE_NOT_DIST', 'app.js is not a DocBook dist build.');
  const from = readVersion(root);
  const to = b.version || readVersion(b.dir);
  makeBackup(root, { replacedBy: to, by, beforeRestore: true });
  copyOwned(b.dir, root);
  prune(root);
  const entry = { at: new Date().toISOString(), by, action: 'restore', from, to, ok: true };
  writeLog(root, entry);
  touchRestart(root);
  return entry;
}

module.exports = {
  inspectPackage, install, restore, listBackups, readLog,
  DEFAULT_ROOT, MAX_ZIP_BYTES, OWNED, KEEP_BACKUPS,
  hasDistBanner, isDistBuild, compareVersions, safeName, inspectZip, status, stage, discard, activate, rollback, restartAfter,
};
