import { WEAPONS } from '../engine/data';
import type { RuleFlags, WeaponId } from '../engine/types';
import { t } from './i18n';

/** One line of what a weapon does, so buying it isn't a guess. Fixed-damage rules show the flat number instead of dice. */
export function weaponStats(id: WeaponId | null, rules: RuleFlags): string {
  if (!id) return t('squad.noGun');
  const w = WEAPONS[id];
  const dmg = rules.fixedDamage ? String(Math.round(w.dice * 3.5) + w.bonus) : `${w.dice}${t('common.die')}6${w.bonus ? `+${w.bonus}` : ''}`;
  const bits = [t('squad.stat.damage', { n: dmg })];
  if (w.kind === 'ranged') {
    bits.push(t('squad.stat.range', { n: w.bands[w.bands.length - 1][0] }));
    if (rules.ammo) bits.push(t('squad.stat.mag', { n: w.mag }));
    if (w.burst && rules.burst) bits.push(t('action.burst'));
    if (w.falloff) bits.push(t('squad.stat.falloff', { n: w.falloff.dist }));
    if (w.heavy) bits.push(t('squad.stat.heavy'));
  }
  if (w.halfArmor) bits.push(t('squad.stat.halfArmor'));
  return bits.join(' · ');
}
