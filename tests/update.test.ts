import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { RELEASE_FEED, cleanEnv, downloadChecked, isNewer, latestRelease, latestVersion, runUpdate, usableSource } from '../electron/update';

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

describe('updating from a release', () => {
  const sha = 'a'.repeat(64);
  const release = (over: Record<string, unknown> = {}, asset: Record<string, unknown> = {}) => ({
    tag_name: 'v0.7.0', draft: false, prerelease: false, html_url: 'https://github.com/Dravilias/Zero-Margin/releases/tag/v0.7.0',
    assets: [
      { name: 'ZeroMargin-0.7.0-linux-x86_64.AppImage', size: 5, digest: `sha256:${sha}`, browser_download_url: 'https://github.com/Dravilias/Zero-Margin/releases/download/v0.7.0/ZeroMargin-0.7.0-linux-x86_64.AppImage' },
      { name: 'ZeroMargin-0.7.0-win-x64-setup.exe', size: 1234, digest: `sha256:${sha}`, browser_download_url: 'https://github.com/Dravilias/Zero-Margin/releases/download/v0.7.0/ZeroMargin-0.7.0-win-x64-setup.exe', ...asset },
    ],
    ...over,
  });

  it('finds the Windows installer in the newest release', async () => {
    const r = await latestRelease(reply(200, release()));
    expect(r).toEqual({
      version: '0.7.0', page: 'https://github.com/Dravilias/Zero-Margin/releases/tag/v0.7.0',
      windows: { name: 'ZeroMargin-0.7.0-win-x64-setup.exe', url: 'https://github.com/Dravilias/Zero-Margin/releases/download/v0.7.0/ZeroMargin-0.7.0-win-x64-setup.exe', size: 1234, sha256: sha },
    });
  });

  it('won’t take an installer from anywhere else, without a checksum, or under another name', async () => {
    expect((await latestRelease(reply(200, release({}, { browser_download_url: 'https://evil.example/ZeroMargin-0.7.0-win-x64-setup.exe' }))))!.windows).toBeNull();
    expect((await latestRelease(reply(200, release({}, { browser_download_url: 'https://github.com/someone/else/releases/download/v0.7.0/x.exe' }))))!.windows).toBeNull();
    expect((await latestRelease(reply(200, release({}, { digest: null }))))!.windows).toBeNull();
    expect((await latestRelease(reply(200, release({}, { digest: 'md5:abc' }))))!.windows).toBeNull();
    expect((await latestRelease(reply(200, release({}, { name: 'ZeroMargin-0.6.9-win-x64-setup.exe' }))))!.windows).toBeNull();
    expect((await latestRelease(reply(200, release({}, { size: 0 }))))!.windows).toBeNull();
    // A release with no installer still says which version is out, so the menu can link to it.
    expect((await latestRelease(reply(200, release({ assets: [] }))))!.version).toBe('0.7.0');
    expect(await latestRelease(reply(200, release({ draft: true })))).toBeNull();
    expect(await latestRelease(reply(200, release({ tag_name: 'v0.7.0; rm -rf /' })))).toBeNull();
    expect(await latestRelease(reply(404, {}))).toBeNull();
    expect(await latestRelease((async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
    // Only a test feed, set on purpose on the player's own PC, may point somewhere else.
    expect((await latestRelease(reply(200, release({}, { browser_download_url: 'http://10.0.2.2:8765/x.exe' })), 'http://10.0.2.2:8765/feed.json'))!.windows).not.toBeNull();
    expect(RELEASE_FEED).toBe('https://api.github.com/repos/Dravilias/Zero-Margin/releases/latest');
  });

  it('keeps a download only if its size and checksum match', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-download-'));
    const data = Buffer.from('pretend installer '.repeat(500));
    const real = createHash('sha256').update(data).digest('hex');
    const serve = (bytes: Buffer) => (async () => new Response(new Uint8Array(bytes), { status: 200 })) as unknown as typeof fetch;
    const file = { name: 'setup.exe', url: 'https://github.com/x', size: data.length, sha256: real };
    const seen: number[] = [];
    const dest = path.join(dir, 'setup.exe');
    expect(await downloadChecked(file, dest, (n) => seen.push(n), serve(data))).toEqual({ ok: true });
    expect(fs.readFileSync(dest).equals(data)).toBe(true);
    expect(seen.at(-1)).toBe(data.length);

    const bad = path.join(dir, 'bad.exe');
    expect((await downloadChecked({ ...file, sha256: 'b'.repeat(64) }, bad, undefined, serve(data))).ok).toBe(false);
    expect((await downloadChecked(file, bad, undefined, serve(data.subarray(1)))).ok).toBe(false);
    expect((await downloadChecked(file, bad, undefined, serve(Buffer.concat([data, Buffer.from('extra')])))).ok).toBe(false);
    expect((await downloadChecked(file, bad, undefined, (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch)).ok).toBe(false);
    // Nothing half-downloaded or wrong is left lying around to be run by mistake.
    expect(fs.readdirSync(dir)).toEqual(['setup.exe']);
    fs.rmSync(dir, { recursive: true, force: true });
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
