import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DICTIONARIES } from '../src/ui/i18n';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('translations', () => {
  const en = DICTIONARIES.en;
  const pl = DICTIONARIES.pl;

  it('has every English key in Polish and the reverse', () => {
    expect(Object.keys(pl).filter((k) => !(k in en))).toEqual([]);
    expect(Object.keys(en).filter((k) => !(k in pl))).toEqual([]);
  });

  it('uses the same placeholders in both languages', () => {
    const vars = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort().join();
    for (const k of Object.keys(en)) expect(`${k}: ${vars(pl[k])}`).toBe(`${k}: ${vars(en[k])}`);
  });

  it('has every key the code asks for by exact name', () => {
    const missing: string[] = [];
    for (const f of [...sourceFiles('src/ui'), ...sourceFiles('src/net')]) {
      if (f.endsWith('i18n.ts')) continue;
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\bt\('([\w.-]+)'/g)) if (!(m[1] in en)) missing.push(`${f}: ${m[1]}`);
      for (const m of text.matchAll(/'((?:table\.problem|net)\.[\w.-]+)'/g)) if (!(m[1] in en)) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it('has names for all game data ids used in dynamic keys', () => {
    const groups: Record<string, string[]> = {
      weapon: ['pistol', 'smg', 'rifle', 'shotgun', 'sniper', 'dronegun', 'shiv', 'monoblade', 'hammer', 'claws', 'ram'],
      role: ['breaker', 'razor', 'longeye', 'wire', 'patcher', 'wrench', 'sapper', 'punk', 'drone'],
      injury: ['bleeding', 'brokenArm', 'brokenLeg', 'concussed', 'shaken', 'optics'],
      'log.fumble': ['jam', 'guard', 'friendly', 'wasted', 'none'],
      mod: ['aimStat', 'firearms', 'smartlink', 'meridian', 'coordinated', 'optics', 'aiming', 'burst', 'overwatch', 'aimedShot', 'quickStat', 'meleeSkill', 'choir', 'solidarity', 'wounded', 'glitched', 'pinned', 'brokenArm', 'concussed', 'secondAttack', 'range', 'heavyCover', 'lightCover', 'evade', 'defence', 'braced'],
      reason: ['noWeapon', 'jammed', 'noAmmo', 'heavyMoved', 'heavyTwice', 'noLos', 'outOfRange', 'notAdjacent'],
      'net.closed': ['host-closed', 'host-gone', 'kicked', 'idle', 'shutdown', 'gone', 'version'],
    };
    const missing = Object.entries(groups).flatMap(([g, ids]) => ids.map((i) => `${g}.${i}`).filter((k) => !(k in en)));
    expect(missing).toEqual([]);
  });
});
