#!/usr/bin/env python3
"""GEC server updater.

Runs on the server as root (systemd timer every minute + a path unit that fires as soon as the app writes
runtime/request.json). The web app never runs commands itself: the "Update" button only writes a request file.

Each run:
  * writes a heartbeat and the current version to runtime/updater.json (the page shows "connected");
  * checks Git for new commits every CHECK_EVERY_MIN minutes, or at once when asked;
  * on an update request: refuses local changes, takes a backup, fast-forwards to the remote branch, rebuilds and
    restarts, waits for /healthz, and rolls the code back (and restarts again) if the new version does not come up.

Settings (environment, e.g. in /etc/default/gec-updater):
  APP_DIR          folder with docker-compose.yml (default: the folder above this script)
  UPDATE_MODE      docker (default) | systemd
  APP_SERVICE      systemd service name in systemd mode (default gec)
  UPDATE_BRANCH    branch to follow (default: the checked-out branch)
  HEALTH_URL       default http://127.0.0.1:3000/healthz
  CHECK_EVERY_MIN  default 30
  SKIP_BACKUP      1 to skip deploy/backup.sh (not recommended)
"""
import datetime
import fcntl
import json
import os
import subprocess
import sys
import time
import urllib.request

APP_DIR = os.path.abspath(os.environ.get('APP_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
RUNTIME = os.path.join(APP_DIR, 'runtime')
STATE = os.path.join(RUNTIME, 'updater.json')
REQUEST = os.path.join(RUNTIME, 'request.json')
LOGFILE = os.path.join(RUNTIME, 'update.log')
MODE = os.environ.get('UPDATE_MODE', 'docker')
SERVICE = os.environ.get('APP_SERVICE', 'gec')
HEALTH_URL = os.environ.get('HEALTH_URL', 'http://127.0.0.1:3000/healthz')
CHECK_EVERY = int(os.environ.get('CHECK_EVERY_MIN', '30')) * 60
APP_UID = int(os.environ.get('APP_UID', '1000'))  # the "node" user inside the container writes request.json


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sh(args, cwd=None, env=None, timeout=1800):
    p = subprocess.run(args, cwd=cwd or APP_DIR, env={**os.environ, **(env or {})}, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr).strip()


def git(*args, timeout=300):
    return sh(['git', '-c', 'safe.directory=*', '-C', REPO, *args], timeout=timeout)


def load():
    try:
        with open(STATE) as f:
            return json.load(f)
    except Exception:
        return {}


def save(state):
    tmp = STATE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(state, f, indent=2)
    os.chmod(tmp, 0o644)
    os.replace(tmp, STATE)


def head():
    _, out = git('log', '-1', '--format=%H%x1f%cI%x1f%s')
    parts = out.split('\x1f')
    return {'commit': parts[0], 'date': parts[1] if len(parts) > 1 else '', 'subject': parts[2] if len(parts) > 2 else ''}


def check(state):
    code, out = git('fetch', '--quiet', 'origin', BRANCH, timeout=180)
    state['checked_at'] = now()
    if code != 0:
        state['check_error'] = out[-300:]
        return
    state['check_error'] = None
    _, log = git('log', f'HEAD..origin/{BRANCH}', '--format=%H%x1f%cI%x1f%s', '-n', '50')
    state['pending'] = [dict(zip(['commit', 'date', 'subject'], line.split('\x1f'))) for line in log.splitlines() if line]


def healthy(expect_commit=None, wait=240):
    deadline = time.time() + wait
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(HEALTH_URL, timeout=5) as r:
                if r.status == 200 and b'"ok"' in r.read():
                    if not expect_commit or MODE != 'docker':
                        return True
                    code, out = sh(['docker', 'compose', 'exec', '-T', 'app', 'printenv', 'APP_COMMIT'])
                    if code == 0 and out.strip() == expect_commit:
                        return True
        except Exception:
            pass
        time.sleep(5)
    return False


def deploy(commit, log):
    if MODE == 'docker':
        code, out = sh(['docker', 'compose', 'up', '-d', '--build', '--remove-orphans'], env={'GIT_COMMIT': commit}, timeout=3600)
    else:
        code, out = sh(['npm', 'ci', '--omit=dev'], timeout=1800)
        log(out[-2000:])
        if code == 0:
            code, out = sh(['systemctl', 'restart', SERVICE])
    log(out[-4000:])
    return code == 0


def update(state, req):
    run = {'id': req.get('id'), 'requested_by': req.get('requested_by'), 'requested_at': req.get('requested_at'), 'started_at': now(), 'log': []}
    state.update({'state': 'running', 'run': run})

    def log(msg):
        for line in str(msg).splitlines() or ['']:
            stamp = datetime.datetime.now().strftime('%H:%M:%S')
            run['log'].append(f'{stamp} {line}')
            with open(LOGFILE, 'a') as f:
                f.write(f'{now()} {line}\n')
        run['log'] = run['log'][-200:]
        state['heartbeat_at'] = now()
        save(state)

    def finish(result, message):
        run.update({'result': result, 'message': message, 'finished_at': now()})
        state['state'] = result
        state['current_commit'] = head()['commit']
        log(message)

    log(f'Update requested by {req.get("requested_by") or "?"}')
    code, dirty = git('status', '--porcelain', '--untracked-files=no')
    if code != 0 or dirty.strip():
        return finish('failed', 'Stopped: the server copy has local changes. Commit or discard them, then try again.\n' + dirty[:500])
    previous = head()['commit']
    run['from'] = previous
    log('1/5 Checking for the new version…')
    check(state)
    if state.get('check_error'):
        return finish('failed', 'Stopped: could not reach the Git server. ' + state['check_error'])
    if not state.get('pending'):
        return finish('done', 'Already up to date.')
    if os.environ.get('SKIP_BACKUP') != '1' and MODE == 'docker':
        log('2/5 Backing up the database and uploaded files…')
        code, out = sh([os.path.join(APP_DIR, 'deploy', 'backup.sh')], timeout=3600)
        log(out[-1500:])
        if code != 0:
            return finish('failed', 'Stopped before changing anything: the backup failed.')
    else:
        log('2/5 Backup skipped (SKIP_BACKUP=1 or systemd mode — make sure you have one).')
    log('3/5 Downloading the new version…')
    code, out = git('merge', '--ff-only', f'origin/{BRANCH}')
    log(out[-1500:])
    if code != 0:
        return finish('failed', 'Stopped: the update cannot be applied automatically (branches have diverged). Nothing was changed.')
    target = head()['commit']
    run['to'] = target
    log(f'4/5 Building and restarting ({target[:7]})…')
    if deploy(target, log) and healthy(target):
        state['pending'] = []
        return finish('done', f'5/5 Updated to {target[:7]} and the system is healthy.')
    log('The new version did not start correctly — rolling back…')
    git('reset', '--hard', previous)
    if deploy(previous, log) and healthy(previous):
        check(state)
        return finish('rolled_back', f'Rolled back to {previous[:7]}. The system is running the previous version. '
                                     'Database changes made by the new version stay; the backup taken before the update is in /var/backups/gec.')
    return finish('failed', 'Rollback did not come up healthy either. Check the app logs on the server (docker compose logs app, or journalctl -u ' + SERVICE + '), or restore the backup.')


def main():
    os.makedirs(RUNTIME, exist_ok=True)
    try:
        os.chown(RUNTIME, APP_UID, APP_UID)
    except Exception:
        pass
    lock = open(os.path.join(RUNTIME, '.lock'), 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return  # another run is busy (e.g. an update in progress)
    state = load()
    if state.get('state') == 'running':  # a previous run died mid-way (reboot)
        state['state'] = 'failed'
        state.setdefault('run', {})['message'] = 'The previous update was interrupted (server restart). Check the system, then try again.'
    cur = head()
    state.update({'heartbeat_at': now(), 'mode': MODE, 'branch': BRANCH, 'current_commit': cur['commit'], 'current_date': cur['date'], 'current_subject': cur['subject']})
    req = None
    if os.path.exists(REQUEST):
        try:
            with open(REQUEST) as f:
                req = json.load(f)
        except Exception:
            req = None
        os.remove(REQUEST)
    last = state.get('checked_at')
    stale = not last or (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(last)).total_seconds() > CHECK_EVERY
    if (req and req.get('action') == 'check') or stale:
        check(state)
    save(state)
    if req and req.get('action') == 'update':
        update(state, req)
        state['heartbeat_at'] = now()
        save(state)


if __name__ == '__main__':
    code, REPO = sh(['git', '-c', 'safe.directory=*', '-C', APP_DIR, 'rev-parse', '--show-toplevel'])
    if code != 0:
        sys.exit(f'Not a git checkout: {APP_DIR}')
    BRANCH = os.environ.get('UPDATE_BRANCH') or sh(['git', '-c', 'safe.directory=*', '-C', REPO, 'rev-parse', '--abbrev-ref', 'HEAD'])[1]
    main()
