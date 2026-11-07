import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanEnv, isNewer, latestVersion, runUpdate, usableSource } from '../electron/update';

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('update check', () => {
  it('compares versions as numbers, and only offers something newer', () => {
    expect(isNewer('0.6.8', '0.6.7')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.6.7', '0.6.7')).toBe(false);
    expect(isNewer('0.6.6', '0.6.7')).toBe(false);
    expect(isNewer('nonsense', '0.6.7')).toBe(false);
    expect(isNewer('0.6.8-rc; rm -rf /', '0.6.7')).toBe(false);
  });

  it('stays quiet when the repo can’t be read', async () => {
    expect(await latestVersion(reply(200, { version: '1.2.3' }))).toBe('1.2.3');
    expect(await latestVersion(reply(404, {}))).toBeNull();
    expect(await latestVersion(reply(200, { version: 'x; evil' }))).toBeNull();
    expect(await latestVersion(reply(200, { version: 5 }))).toBeNull();
    expect(await latestVersion((async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
  });

  it('keeps an AppImage’s own settings away from the tools it runs', () => {
    const env = cleanEnv({ APPIMAGE: '/a', LD_LIBRARY_PATH: '/x', PATH: '/tmp/.mount_ZeroMa1/usr/bin:/usr/bin', HOME: '/h' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/h' });
  });
});

describe('running an update', () => {
  const git = (cwd: string, cmd: string) => execSync(`git -c user.name=t -c user.email=t@t ${cmd}`, { cwd, stdio: 'pipe' });

  /** A real repo and clone, with an install script that just leaves a mark. */
  function setup(script: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-update-'));
    const origin = path.join(root, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init -q -b main');
    fs.writeFileSync(path.join(origin, 'install.sh'), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(origin, 'version'), '1');
    git(origin, 'add -A');
    git(origin, 'commit -qm one');
    const clone = path.join(root, 'clone');
    git(root, `clone -q ${origin} clone`);
    return { root, origin, clone, log: path.join(root, 'update.log') };
  }
  const push = (origin: string, v: string) => {
    fs.writeFileSync(path.join(origin, 'version'), v);
    git(origin, 'add -A');
    git(origin, 'commit -qm next');
  };

  it('pulls, then installs the new code', async () => {
    const { root, origin, clone, log } = setup('cat version > installed');
    expect(usableSource(clone)).toBe(true);
    push(origin, '2');
    expect(await runUpdate(clone, log, process.env)).toBe(true);
    expect(fs.readFileSync(path.join(clone, 'installed'), 'utf8')).toBe('2');
    fs.rmSync(root, { recursive: true });
  });

  it('reports failure and writes a log when the script fails', async () => {
    const { root, origin, clone, log } = setup('echo broken-build; exit 3');
    push(origin, '2');
    expect(await runUpdate(clone, log, process.env)).toBe(false);
    expect(fs.readFileSync(log, 'utf8')).toContain('broken-build');
    fs.rmSync(root, { recursive: true });
  });

  it('won’t run the script if local changes block the pull', async () => {
    const { root, origin, clone, log } = setup('touch ran');
    push(origin, '2');
    fs.writeFileSync(path.join(clone, 'version'), 'my own edit');
    expect(await runUpdate(clone, log, process.env)).toBe(false);
    expect(fs.existsSync(path.join(clone, 'ran'))).toBe(false);
    expect(fs.readFileSync(path.join(clone, 'version'), 'utf8')).toBe('my own edit');
    fs.rmSync(root, { recursive: true });
  });

  it('refuses a folder that isn’t a clone', () => {
    expect(usableSource(os.tmpdir())).toBe(false);
    expect(usableSource('relative/path')).toBe(false);
  });
});
