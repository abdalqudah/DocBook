// The running version: package version + git commit (APP_COMMIT is set at image build time; otherwise read .git).
const fs = require('fs');
const path = require('path');
const pkg = require('../../../package.json');

let cached;
// build-info.json is written into release zips (scripts/release.js): commit and date of that build.
const buildInfo = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'build-info.json'), 'utf8')); } catch { return {}; } })();
function fromGit() {
  let dir = path.join(__dirname, '..', '..', '..');
  for (let i = 0; i < 4; i += 1) {
    const git = path.join(dir, '.git');
    if (fs.existsSync(path.join(git, 'HEAD'))) {
      const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
      if (!head.startsWith('ref: ')) return head;
      const ref = head.slice(5);
      const loose = path.join(git, ref);
      if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim();
      const packed = path.join(git, 'packed-refs');
      if (fs.existsSync(packed)) { const line = fs.readFileSync(packed, 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`)); if (line) return line.split(' ')[0]; }
      return null;
    }
    dir = path.dirname(dir);
  }
  return null;
}
function commit() {
  if (cached === undefined) cached = (process.env.APP_COMMIT && /^[0-9a-f]{7,40}$/.test(process.env.APP_COMMIT) ? process.env.APP_COMMIT : null) || (/^[0-9a-f]{7,40}$/.test(buildInfo.commit || '') ? buildInfo.commit : null) || (() => { try { return fromGit(); } catch { return null; } })();
  return cached;
}
const version = () => ({ version: pkg.version, commit: commit(), short: commit() ? commit().slice(0, 7) : null, builtAt: buildInfo.built_at || null });

module.exports = { version, commit };
