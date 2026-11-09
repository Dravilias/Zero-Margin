import { FACTIONS, RECRUITABLE, ROLES, WEAPONS } from '../engine/data';
import {
  adjacentFree, chargeTile, grenadeRange, hackPreview, hackTargets, hackableTerminals, losBetween, moveOf, patchTargets,
  pathTo, previewAttack, reachable, repairTargets, rulesOf, stoppable, unitById, unitOptions, type UnitOptions,
} from '../engine/game';
import { canStand, dist, inRect, tileAt } from '../engine/map';
import type { Action, AttackPreview, GameEvent, GameState, GrenadeKind, HitLoc, ProgramId, RoleId, Unit } from '../engine/types';
import { GuestSession, type GameSession, type GameUpdate } from '../net/sessions';
import { sfx } from './audio';
import { playMusic } from './music';
import { Board, NO_HIGHLIGHTS, type Highlights } from './board';
import { DiceTray, type DieRequest } from './dice';
import { clear, copyText, el } from './dom';
import { t } from './i18n';
import { actionIcon, crewIcon, roleIcon } from './icons';
import { speedFactor } from './settings';
import type { GameCoach } from './tutorial';

type Mode =
  | { k: 'default' }
  | { k: 'grenade'; kind: GrenadeKind }
  | { k: 'hack'; program: ProgramId }
  | { k: 'patch' }
  | { k: 'repair' }
  | { k: 'drone' }
  | { k: 'suppress' }
  | { k: 'reinforce'; role: RoleId };

export interface GameNav {
  toMenu(): void;
  rematch?: () => void;
  /** Tutorial only: start the lesson again after losing. */
  retry?: () => void;
  /** Tutorial only: the player finished the lesson. */
  tutorialDone?: () => void;
  /** Campaign only: the battle is over and the campaign carries on. */
  missionOver?: () => void;
}

const AMBER = '#e0ac5c';
const RED = '#ff4d4d';
const GREEN = '#6fd3a0';
const CYAN = '#8fb4cc';
const VIOLET = '#a795d6';
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms * speedFactor()));
const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

export class GameView {
  private display: GameState;
  private queue: GameUpdate[] = [];
  private pumping = false;
  private disposed = false;
  private layoutObserver: ResizeObserver | null = null;
  private pending = false;
  private selected: string | null = null;
  private mode: Mode = { k: 'default' };
  private burst = false;
  private aimedAt: HitLoc | null = null;
  private meleePref = false;
  private hoverTile: { x: number; y: number } | null = null;
  private board!: Board;
  private dice!: DiceTray;
  private els: Record<string, HTMLElement> = {};
  private overShown = false;
  private keyHandler: (e: KeyboardEvent) => void;

  constructor(private root: HTMLElement, private session: GameSession, private nav: GameNav, private coach?: GameCoach) {
    this.display = structuredClone(session.state);
    playMusic('battle');
    this.build();
    session.onUpdate = (u) => this.enqueue(u);
    session.onChat = (from, text) => this.logLine(`${from}: ${text}`, 'chat');
    session.onNotice = (key, name) => this.toast(t(key, { name: name ?? '' }));
    session.onStatus = (status) => {
      if (status === 'reconnecting') this.showBanner(t('net.reconnecting'));
      else if (status === 'open') {
        this.showBanner(null);
        this.toast(t('net.reconnected'));
      }
    };
    session.onClosed = (reason) => this.closedDialog(reason);
    if (session instanceof GuestSession) {
      session.onRejected = () => {
        this.pending = false;
        this.refresh();
      };
    }
    this.coach?.attach({
      changed: () => {
        this.refresh();
        this.session.idle();
      },
      toast: (text) => this.toast(text),
    });
    this.keyHandler = (e) => this.onKey(e);
    window.addEventListener('keydown', this.keyHandler);
    this.board.setState(this.display);
    this.refresh();
    if (!this.coach) this.logLine(t(`scenario.${this.display.cfg.scenario}`), 'head');
    session.idle();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    playMusic('menu');
    window.removeEventListener('keydown', this.keyHandler);
    this.layoutObserver?.disconnect();
    this.board.destroy();
    this.dice.destroy();
    // A campaign's connection can outlive this screen, so nothing it holds should keep the screen alive.
    const s = this.session;
    s.onUpdate = null;
    s.onChat = null;
    s.onNotice = null;
    s.onStatus = null;
    s.onClosed = null;
    if (s instanceof GuestSession) s.onRejected = null;
    this.queue = [];
  }

  /* ---------- Layout ---------- */

  private build(): void {
    const s = this.display;
    clear(this.root);
    const boardWrap = el('div.board-wrap');
    const diceWrap = el('div.dice-tray');
    this.els.diceWrap = diceWrap;
    this.els.top = el('div.topbar');
    this.els.turn = el('div.turnbar');
    this.els.rosters = el('div.rosters');
    this.els.diceLine = el('div.dice-line');
    this.els.log = el('div.log');
    this.els.sheet = el('div.sheet');
    this.els.actions = el('div.actions');
    this.els.preview = el('div.preview');
    this.els.toasts = el('div.toasts');
    this.els.banner = el('div.net-banner', { hidden: true });
    this.els.bigBanner = el('div.big-banner');
    let chat: HTMLElement | null = null;
    const narrates = this.isGameMaster();
    if (this.session.online || narrates) {
      const input = el('input.chat-input', {
        placeholder: t(narrates ? 'camp.gmSay' : 'game.chatPlaceholder'), maxlength: 200,
        onkeydown: (e: KeyboardEvent) => {
          e.stopPropagation();
          if (e.key === 'Enter' && input.value.trim()) {
            this.session.chat(input.value.trim());
            input.value = '';
          }
        },
      }) as HTMLInputElement;
      chat = input;
    }
    const game = el('div.game', { class: this.coach ? 'has-coach' : '' },
      boardWrap,
      this.els.top,
      el('div.hud-left', {}, this.els.rosters, this.els.sheet),
      el('div.hud-right', {}, diceWrap, this.els.diceLine, this.els.log, chat, this.els.preview),
      el('div.hud-center', {}, this.coach ? this.coach.card : null, this.els.turn),
      this.els.actions,
      this.els.bigBanner,
      this.els.toasts,
      this.els.banner,
    );
    this.root.append(game);
    this.board = new Board(boardWrap);
    this.dice = new DiceTray(diceWrap);
    this.board.onTileClick = (x, y) => this.onTile(x, y);
    this.board.onTileHover = (x, y) => this.onHover(x, y);
    this.layoutBoard(game);
    this.layoutObserver = new ResizeObserver(() => this.layoutBoard(game));
    this.layoutObserver.observe(game);
    void s;
  }

  /** Fits the board into the space the HUD leaves free; the city carries on behind the panels. */
  private layoutBoard(game: HTMLElement): void {
    const area = game.getBoundingClientRect();
    const left = this.els.rosters.parentElement!.getBoundingClientRect().right - area.left + 6;
    const right = area.right - this.els.log.parentElement!.getBoundingClientRect().left + 6;
    const center = this.coach ? this.coach.card.getBoundingClientRect().bottom : this.els.top.getBoundingClientRect().bottom;
    const top = center - area.top + (this.coach ? 8 : 30);
    const bottom = area.bottom - this.els.actions.getBoundingClientRect().top + 8;
    this.board.setInsets({ left, right, top, bottom });
  }

  private sideName(side: number): string {
    const c = this.display.cfg.sides[side];
    return c.name || t(`faction.${c.faction}`);
  }

  private unitName(id?: string | null): string {
    if (!id) return '';
    return unitById(this.display, id)?.name ?? '';
  }

  /** It's a local player's turn and nothing is animating, so options and odds can be shown. */
  private canSee(): boolean {
    const s = this.display;
    return (
      !this.pending && !this.pumping && this.queue.length === 0 && s.phase !== 'over' &&
      this.session.localSides.has(s.activeSide) && s.cfg.sides[s.activeSide].control === 'human' &&
      (!s.activeUnit || this.session.mayControl(s.activeUnit))
    );
  }

  /** This player runs the enemy side in a campaign. */
  private isGameMaster(): boolean {
    const s = this.display;
    return s.gmBudget !== undefined && this.session.localSides.has(1) && s.cfg.sides[1]?.control === 'human';
  }

  private canAct(): boolean {
    return this.canSee() && (!this.coach || this.coach.playerMayAct());
  }

  private activeUnit(): Unit | null {
    return this.display.activeUnit ? unitById(this.display, this.display.activeUnit) ?? null : null;
  }

  private submit(action: Action): void {
    if (!this.canAct()) return;
    if (this.coach && !this.coach.allows(action)) {
      this.coach.nudge();
      this.refresh();
      return;
    }
    sfx.click();
    this.mode = { k: 'default' };
    this.pending = !this.session.isHost;
    this.session.submit(action, this.display.activeSide);
    this.refresh();
  }

  /* ---------- Events and animation ---------- */

  private enqueue(u: GameUpdate): void {
    this.queue.push(u);
    this.pending = false;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    this.refresh();
    while (this.queue.length && !this.disposed) {
      const { events, state } = this.queue.shift()!;
      for (const e of events) {
        if (this.disposed) return;
        // A bad animation mustn't freeze the game: the real state below still replaces whatever it left behind.
        try {
          await this.playEvent(e);
        } catch (err) {
          console.error('Could not show game event', e, err);
          this.toast(t('game.eventError'));
        }
      }
      // After the animations, the real state replaces anything patched along the way.
      this.display = structuredClone(state);
      this.board.setState(this.display);
      if (this.queue.length) this.refreshPanels();
    }
    this.pumping = false;
    if (this.disposed) return;
    this.coach?.sync(this.display);
    this.refresh();
    if (this.display.phase === 'over') this.showOver();
    else this.session.idle();
  }

  private patchUnit(id: string, patch: Partial<Unit>): Unit | undefined {
    const u = unitById(this.display, id);
    if (u) Object.assign(u, patch);
    return u;
  }

  private rollLine(label: string, nat: number, extra: number, mod: number, tn: number, ok: boolean): void {
    const total = nat + extra + mod;
    const dice = extra === 0 ? `${nat}` : `${nat}${extra > 0 ? ' + ' : ' − '}${Math.abs(extra)}`;
    this.els.diceLine.replaceChildren(
      el('span.dl-label', {}, label),
      el('span.dl-math', {}, `${dice} ${signed(mod)} = ${total}`),
      el('span.dl-tn', {}, `vs ${tn}`),
      el(ok ? 'span.dl-ok' : 'span.dl-fail', {}, ok ? '✓' : '✗'),
    );
  }

  private d10s(nat: number, extra: number, color: string): DieRequest[] {
    const out: DieRequest[] = [{ sides: 10, value: nat, color }];
    if (extra > 0) out.push({ sides: 10, value: extra, color: GREEN });
    if (extra < 0) out.push({ sides: 10, value: -extra, color: RED, ink: '#fff' });
    return out;
  }

  private async playEvent(e: GameEvent): Promise<void> {
    const s = this.display;
    switch (e.t) {
      case 'deployed':
        s.ready[e.side] = true;
        break;
      case 'round': {
        s.round = e.round;
        s.phase = 'battle';
        s.order = e.order;
        const order = e.order.map((x) => this.sideName(x)).join(' → ');
        this.logLine(t('log.round', { round: e.round, order }), 'head');
        this.bigBanner(t('game.round', { round: e.round, max: s.cfg.maxRounds }), order);
        this.refreshPanels();
        await wait(750);
        break;
      }
      case 'turn':
        s.activeSide = e.side;
        s.activeUnit = null;
        if (this.session.localSides.has(e.side)) sfx.turn();
        this.refreshPanels();
        break;
      case 'activate': {
        this.resetAttackChoices();
        s.activeUnit = e.unit;
        this.patchUnit(e.unit, { activated: true, ap: e.ap, overwatch: false, braced: false });
        this.selected = e.unit;
        this.refreshPanels();
        if (s.cfg.sides[s.activeSide].control === 'ai') await wait(150);
        break;
      }
      case 'endActivation':
        this.resetAttackChoices();
        this.patchUnit(e.unit, { ap: 0, glitch: false, pinned: false });
        s.activeUnit = null;
        break;
      case 'move': {
        const u = unitById(s, e.unit);
        if (!u) break;
        const last = e.path[e.path.length - 1];
        const promise = this.board.moveToken(u.id, e.path);
        u.x = last[0];
        u.y = last[1];
        await promise;
        break;
      }
      case 'attack': {
        const a = unitById(s, e.unit);
        const v = unitById(s, e.target);
        if (!a || !v) break;
        const label = e.overwatch ? t('mod.overwatch') : t(`weapon.${e.weapon}`);
        this.rollLine(label, e.roll.nat, e.roll.extra, e.roll.mod, e.roll.tn, e.hit);
        await this.dice.roll(this.d10s(e.roll.nat, e.roll.extra, CYAN));
        const key = e.crit ? 'log.attack.crit' : e.hit ? 'log.attack.hit' : 'log.attack.miss';
        const text = t(key, { unit: a.name, target: v.name, weapon: t(`weapon.${e.weapon}`), roll: e.roll.total, tn: e.roll.tn });
        this.logLine((e.overwatch ? t('log.attack.ow') : '') + text, e.hit ? (e.crit ? 'crit' : 'hit') : 'miss');
        const color = FACTIONS[a.faction].color;
        if (e.kind === 'melee') await this.board.melee(a.id, a.x, a.y, v.x, v.y, e.hit);
        else await this.board.shot(a.x, a.y, v.x, v.y, e.hit, !!WEAPONS[e.weapon].heavy || e.weapon === 'shotgun', color);
        if (!e.hit) this.board.float(v.x, v.y, 'MISS', '#c5d0e0');
        if (e.crit) this.board.float(v.x, v.y, 'CRIT', AMBER, true);
        break;
      }
      case 'damage': {
        const v = unitById(s, e.target);
        if (!v) break;
        if (e.dice.length) {
          await this.dice.roll(e.dice.map((value) => ({ sides: 6 as const, value, color: '#e8eef8' })));
        }
        v.hp = e.hp;
        if (e.dealt > 0) {
          this.board.float(v.x, v.y, `-${e.dealt}`, RED, e.dealt >= 10);
          this.board.hitShake(v.id);
          const loc = e.loc ? t(`loc.${e.loc}`) : '';
          this.logLine(t(e.loc ? 'log.damageLoc' : 'log.damage', { target: v.name, dealt: e.dealt, raw: e.raw, armor: e.armor, loc }), 'dmg');
        } else {
          this.board.float(v.x, v.y, '0', '#c5d0e0');
          this.logLine(t('log.blocked', { target: v.name }), 'miss');
        }
        this.refreshPanels();
        await wait(200);
        break;
      }
      case 'armorWear':
        this.patchUnit(e.target, e.head ? { armorHead: e.armor } : { armor: e.armor });
        this.logLine(t('log.armorWear', { target: this.unitName(e.target), armor: e.armor }));
        break;
      case 'injury': {
        const v = unitById(s, e.target);
        if (!v) break;
        if (!v.injuries.includes(e.injury)) v.injuries.push(e.injury);
        this.board.float(v.x, v.y, t(`injury.${e.injury}`), AMBER);
        this.logLine(t('log.injury', { target: v.name, injury: t(`injury.${e.injury}`) }), 'crit');
        await wait(220);
        break;
      }
      case 'down': {
        const v = unitById(s, e.unit);
        if (!v) break;
        v.state = e.dead ? 'dead' : 'down';
        v.hp = 0;
        sfx.down();
        this.logLine(t(e.dead ? 'log.dead' : 'log.down', { unit: v.name }), 'dead');
        this.refreshPanels();
        await wait(350);
        break;
      }
      case 'aim':
        this.patchUnit(e.unit, { aiming: e.bonus });
        this.floatOn(e.unit, `+${e.bonus}`, CYAN);
        this.logLine(t('log.aim', { unit: this.unitName(e.unit), n: e.bonus }));
        await wait(200);
        break;
      case 'reload':
        this.patchUnit(e.unit, { ammo: e.ammo });
        this.floatOn(e.unit, t('action.reload'), CYAN);
        this.logLine(t('log.reload', { unit: this.unitName(e.unit) }));
        await wait(200);
        break;
      case 'brace':
        this.patchUnit(e.unit, { braced: true });
        this.floatOn(e.unit, t('action.brace'), CYAN);
        this.logLine(t('log.brace', { unit: this.unitName(e.unit) }));
        await wait(200);
        break;
      case 'overwatch':
        this.patchUnit(e.unit, { overwatch: true });
        this.floatOn(e.unit, t('action.overwatch'), AMBER);
        this.logLine(t('log.overwatch', { unit: this.unitName(e.unit) }));
        await wait(200);
        break;
      case 'clearJam':
        this.patchUnit(e.unit, { jammed: false });
        this.logLine(t('log.clearJam', { unit: this.unitName(e.unit) }));
        await wait(150);
        break;
      case 'fumble':
        this.floatOn(e.unit, '!!', RED);
        this.logLine(t(`log.fumble.${e.kind}`, { unit: this.unitName(e.unit), ally: this.unitName(e.ally) }), 'crit');
        await wait(280);
        break;
      case 'suppress': {
        const u = unitById(s, e.unit);
        this.logLine(t('log.suppress', { unit: this.unitName(e.unit) }));
        if (u) await this.board.shot(u.x, u.y, e.x, e.y, false, true, FACTIONS[u.faction].color);
        break;
      }
      case 'grenade': {
        const u = unitById(s, e.unit);
        if (!u) break;
        if (e.roll) {
          this.rollLine(t(`grenade.${e.kind}`), e.roll.nat, e.roll.extra, e.roll.mod, e.roll.tn, e.hit);
          await this.dice.roll(this.d10s(e.roll.nat, e.roll.extra, AMBER));
        }
        this.logLine(t(e.hit ? 'log.grenade' : 'log.grenadeMiss', { unit: u.name, kind: t(`grenade.${e.kind}`) }));
        await this.board.blast(e.landX, e.landY, e.kind === 'emp' ? 2 : 1, e.kind, u.x, u.y);
        break;
      }
      case 'hack': {
        const u = unitById(s, e.unit);
        if (!u) break;
        this.rollLine(t(`program.${e.program}`), e.roll.nat, e.roll.extra, e.roll.mod, e.roll.tn, e.ok);
        await this.dice.roll(this.d10s(e.roll.nat, e.roll.extra, VIOLET));
        const target = e.target ? unitById(s, e.target) : undefined;
        const term = e.terminal !== undefined ? s.terminals.find((x) => x.id === e.terminal) : undefined;
        const tx = target?.x ?? term?.x ?? u.x;
        const ty = target?.y ?? term?.y ?? u.y;
        await this.board.arc(u.x, u.y, tx, ty, e.ok ? VIOLET : '#5f708a');
        this.board.float(tx, ty, e.ok ? t(`program.${e.program}`) : 'ICE', e.ok ? VIOLET : '#c5d0e0');
        this.logLine(t(e.ok ? 'log.hack.ok' : 'log.hack.fail', {
          unit: u.name, program: t(`program.${e.program}`), target: target?.name ?? t('log.hackTerminal'), roll: e.roll.total, tn: e.roll.tn,
        }), e.ok ? 'hit' : 'miss');
        break;
      }
      case 'patch': {
        const v = unitById(s, e.target);
        if (!v) break;
        if (e.roll) {
          this.rollLine(t('action.patch'), e.roll.nat, e.roll.extra, e.roll.mod, e.roll.tn, e.ok);
          await this.dice.roll(this.d10s(e.roll.nat, e.roll.extra, GREEN));
        }
        if (e.ok) {
          sfx.heal();
          v.hp = e.hp;
          if (e.revived) v.state = 'ok';
          this.board.float(v.x, v.y, `+${e.healed}`, GREEN);
        }
        const key = !e.ok ? 'log.patch.fail' : e.revived ? 'log.patch.revive' : 'log.patch.ok';
        this.logLine(t(key, { unit: this.unitName(e.unit), target: v.name, n: e.revived ? e.hp : e.healed }), e.ok ? 'heal' : 'miss');
        this.refreshPanels();
        await wait(250);
        break;
      }
      case 'repair':
        sfx.heal();
        this.patchUnit(e.target, { hp: e.hp, armor: e.armor });
        this.floatOn(e.target, t('action.repair'), GREEN);
        this.logLine(t('log.repair', { unit: this.unitName(e.unit), target: this.unitName(e.target) }), 'heal');
        await wait(220);
        break;
      case 'stim':
        sfx.heal();
        this.patchUnit(e.unit, { hp: e.hp });
        this.floatOn(e.unit, `+${e.healed}`, GREEN);
        this.logLine(t('log.stim', { unit: this.unitName(e.unit), n: e.healed }), 'heal');
        await wait(220);
        break;
      case 'spike':
        this.floatOn(e.unit, '+1', CYAN);
        this.logLine(t('log.spike', { unit: this.unitName(e.unit) }));
        await wait(180);
        break;
      case 'drone':
        s.units.push(structuredClone(e.drone));
        this.logLine(t('log.drone', { unit: this.unitName(e.unit) }));
        this.refreshPanels();
        await wait(220);
        break;
      case 'reinforce':
        s.units.push(structuredClone(e.unit));
        s.gmBudget = { ...s.gmBudget, [e.unit.side]: e.left };
        this.logLine(t('log.reinforce', { unit: e.unit.name, role: t(`role.${e.unit.role}`) }));
        this.refreshPanels();
        await wait(220);
        break;
      case 'luck':
        this.patchUnit(e.unit, { luck: e.left, luckBonus: (unitById(s, e.unit)?.luckBonus ?? 0) + 2 });
        this.logLine(t('log.luck', { unit: this.unitName(e.unit) }));
        break;
      case 'focus':
        this.patchUnit(e.unit, { focus: e.focus });
        break;
      case 'snap':
        this.patchUnit(e.unit, { side: e.side, team: e.team });
        this.logLine(t('log.snap', { unit: this.unitName(e.unit) }), 'dead');
        this.refreshPanels();
        await wait(500);
        break;
      case 'recover':
        this.patchUnit(e.unit, { side: e.side, team: e.team });
        this.logLine(t('log.recover', { unit: this.unitName(e.unit) }));
        break;
      case 'jackIn':
        this.patchUnit(e.unit, { net: e.net });
        this.logLine(t('log.jackIn', { unit: this.unitName(e.unit), n: e.net }));
        break;
      case 'ward':
        this.patchUnit(e.target, { rez: e.rez });
        this.logLine(t('log.ward', { unit: this.unitName(e.target), n: e.rez }));
        break;
      case 'hunter':
        this.patchUnit(e.unit, { hp: e.hp });
        this.logLine(t('log.hunter', { unit: this.unitName(e.unit), n: e.dealt }), 'dmg');
        this.refreshPanels();
        await wait(350);
        break;
      case 'capture': {
        const term = s.terminals.find((x) => x.id === e.terminal);
        if (term) {
          term.owner = e.team;
          this.board.float(term.x, term.y, t('action.capture'), AMBER);
        }
        this.logLine(t('log.capture', { unit: this.unitName(e.unit) }), 'hit');
        await wait(250);
        break;
      }
      case 'core':
        if (s.core) {
          s.core.x = e.x;
          s.core.y = e.y;
          s.core.carrier = e.what === 'grab' ? e.unit : e.what === 'drop' ? null : s.core.carrier;
        }
        this.logLine(t(`log.core.${e.what}`, { unit: this.unitName(e.unit) }), 'crit');
        await wait(280);
        break;
      case 'nerve':
        this.logLine(t(e.ok ? 'log.nerve.ok' : 'log.nerve.fail', { unit: this.unitName(e.unit) }), e.ok ? undefined : 'crit');
        if (!e.ok) {
          this.patchUnit(e.unit, { pinned: true });
          this.floatOn(e.unit, t('game.status.pinned'), RED);
          await wait(240);
        }
        break;
      case 'bleed':
        this.patchUnit(e.unit, { hp: e.hp });
        this.floatOn(e.unit, `-${e.amount}`, RED);
        this.logLine(t('log.bleed', { unit: this.unitName(e.unit), n: e.amount }), 'dmg');
        await wait(220);
        break;
      case 'deathRoll':
        this.logLine(t(e.ok ? 'log.deathRoll.ok' : 'log.deathRoll.fail', { unit: this.unitName(e.unit), count: e.count }), e.ok ? undefined : 'crit');
        await wait(160);
        break;
      case 'vp': {
        s.vp[e.team] = e.total;
        const names = s.cfg.sides.flatMap((c, i) => (c.team === e.team ? [this.sideName(i)] : [])).join(' + ');
        this.logLine(t(e.why === 'kill' ? 'log.vp.kill' : 'log.vp.terminal', { name: names, n: e.amount }), 'vp');
        this.refreshTop();
        break;
      }
      case 'concede':
        this.logLine(t('log.concede', { side: this.sideName(e.side) }), 'head');
        break;
      case 'gameover':
        s.phase = 'over';
        s.winner = e.winner;
        s.reason = e.reason;
        this.logLine(t('log.gameover'), 'head');
        break;
      default:
        break;
    }
  }

  private floatOn(id: string, text: string, color: string): void {
    const u = unitById(this.display, id);
    if (u) this.board.float(u.x, u.y, text, color);
  }

  /* ---------- Input ---------- */

  private onHover(x: number, y: number): void {
    this.hoverTile = x < 0 ? null : { x, y };
    if (this.coach && this.canSee()) this.coach.hovered(x < 0 ? null : this.unitAt(x, y)?.id ?? null);
    this.board.setHighlights(this.highlights());
    this.renderPreview();
  }

  private unitAt(x: number, y: number): Unit | undefined {
    return this.display.units.find((u) => u.state !== 'dead' && u.x === x && u.y === y);
  }

  /** Burst only applies if this unit's weapon can actually fire one right now. */
  private burstFor(u: Unit): 'burst' | undefined {
    const w = u.ranged ? WEAPONS[u.ranged] : null;
    const rules = rulesOf(this.display);
    return this.burst && w?.burst && rules.burst && !u.jammed && (!rules.ammo || u.ammo >= 3) ? 'burst' : undefined;
  }

  /** Firing and melee choices belong to one activation, not to whoever acts next. */
  private resetAttackChoices(): void {
    this.burst = false;
    this.meleePref = false;
    this.aimedAt = null;
  }

  /** The attack a click on this enemy would make, or null if none is possible. */
  private attackOn(u: Unit, v: Unit): { kind: 'shoot' | 'melee' | 'charge'; pv: AttackPreview } | null {
    const s = this.display;
    const ranged = u.ranged ? previewAttack(s, u, v, 'ranged', { mode: this.burstFor(u), aimedAt: this.aimedAt ?? undefined }) : null;
    const melee = previewAttack(s, u, v, 'melee');
    const value = (p: AttackPreview) => p.chance * Math.max(0.5, p.avgDmg);
    if (this.meleePref && melee.ok) return { kind: 'melee', pv: melee };
    if (ranged?.ok && melee.ok) return value(melee) > value(ranged) ? { kind: 'melee', pv: melee } : { kind: 'shoot', pv: ranged };
    // A leftover melee preference must never stop a legal shot.
    if (ranged?.ok) return { kind: 'shoot', pv: ranged };
    if (melee.ok) return { kind: 'melee', pv: melee };
    if (u.role === 'razor' && !u.charged) {
      const tile = chargeTile(s, u, v);
      if (tile) {
        const pv = previewAttack(s, u, v, 'melee', { fx: tile[0], fy: tile[1], hypothetical: true });
        if (pv.ok) return { kind: 'charge', pv };
      }
    }
    return null;
  }

  private onTile(x: number, y: number): void {
    const s = this.display;
    const clicked = this.unitAt(x, y);
    if (!this.canAct()) {
      if (clicked) {
        this.selected = clicked.id;
        this.refresh();
      }
      return;
    }
    if (s.phase === 'deploy') {
      if (clicked && clicked.side === s.activeSide && (!this.selected || clicked.id !== this.selected)) {
        const sel = this.selected ? unitById(s, this.selected) : null;
        if (sel && sel.side === s.activeSide && this.session.mayControl(sel.id) && this.session.mayControl(clicked.id)) {
          this.submit({ type: 'place', unitId: sel.id, x, y });
          return;
        }
        this.selected = clicked.id;
        sfx.click();
        this.refresh();
        return;
      }
      const sel = this.selected ? unitById(s, this.selected) : null;
      if (sel && sel.side === s.activeSide && this.session.mayControl(sel.id) && inRect(s.map.zones[s.activeSide], x, y) && canStand(tileAt(s.map, x, y))) {
        this.submit({ type: 'place', unitId: sel.id, x, y });
      }
      return;
    }

    const u = this.activeUnit();
    if (!u) {
      if (this.mode.k === 'reinforce') {
        if (inRect(s.map.zones[s.activeSide], x, y) && canStand(tileAt(s.map, x, y)) && !clicked) this.submit({ type: 'reinforce', role: this.mode.role, x, y });
        return;
      }
      if (clicked && clicked.side === s.activeSide && clicked.state === 'ok' && !clicked.activated && this.session.mayControl(clicked.id)) {
        this.selected = clicked.id;
        this.submit({ type: 'select', unitId: clicked.id });
      } else if (clicked) {
        this.selected = clicked.id;
        this.refresh();
      }
      return;
    }

    switch (this.mode.k) {
      case 'grenade': {
        const tiles = this.tilesInRange(u, grenadeRange(u));
        if (tiles.has(x + y * s.map.w)) this.submit({ type: 'grenade', kind: this.mode.kind, x, y });
        return;
      }
      case 'suppress': {
        const tiles = this.tilesInRange(u, 14);
        if (tiles.has(x + y * s.map.w)) this.submit({ type: 'suppress', x, y });
        return;
      }
      case 'drone':
        if (adjacentFree(s, u).some(([a, b]) => a === x && b === y)) this.submit({ type: 'drone', x, y });
        return;
      case 'hack': {
        const program = this.mode.program;
        if (program === 'terminal') {
          const term = s.terminals.find((m) => m.x === x && m.y === y);
          if (term && hackableTerminals(s, u).includes(term.id)) this.submit({ type: 'hack', program, terminalId: term.id });
        } else if (clicked && hackTargets(s, u, program).some((v) => v.id === clicked.id)) {
          this.submit({ type: 'hack', program, targetId: clicked.id });
        }
        return;
      }
      case 'patch':
        if (clicked && patchTargets(s, u).some((v) => v.id === clicked.id)) this.submit({ type: 'patch', targetId: clicked.id });
        return;
      case 'repair':
        if (clicked && repairTargets(s, u).some((v) => v.id === clicked.id)) this.submit({ type: 'repair', targetId: clicked.id });
        return;
      default:
        break;
    }

    if (clicked && clicked.team !== u.team && clicked.state === 'ok') {
      const atk = this.attackOn(u, clicked);
      if (atk && u.ap >= 1) {
        if (atk.kind === 'shoot') this.submit({ type: 'shoot', targetId: clicked.id, mode: this.burstFor(u), aimedAt: this.aimedAt ?? undefined });
        else if (atk.kind === 'melee') this.submit({ type: 'melee', targetId: clicked.id });
        else this.submit({ type: 'charge', targetId: clicked.id });
        return;
      }
      this.selected = clicked.id;
      this.refresh();
      return;
    }
    if (u.ap >= 1) {
      const reach = reachable(s, u);
      if (stoppable(s, u, reach).includes(x + y * s.map.w)) {
        this.submit({ type: 'move', x, y });
        return;
      }
    }
    if (clicked) {
      this.selected = clicked.id;
      this.refresh();
    }
  }

  private tilesInRange(u: Unit, range: number): Set<number> {
    const s = this.display;
    const out = new Set<number>();
    for (let y = 0; y < s.map.h; y++) {
      for (let x = 0; x < s.map.w; x++) {
        if (tileAt(s.map, x, y) === '#') continue;
        const d = dist(u.x, u.y, x, y);
        if (d > range) continue;
        if (d > 2 && !losBetween(s, u.x, u.y, x, y).visible) continue;
        out.add(x + y * s.map.w);
      }
    }
    return out;
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (this.coach?.isInfo() && (e.key === 'Enter' || e.code === 'Space') && !this.pumping && !this.root.querySelector('.modal-back')) {
      e.preventDefault();
      this.coach.next();
      return;
    }
    if (e.key === 'Escape') {
      if (this.mode.k !== 'default') {
        this.mode = { k: 'default' };
        this.refresh();
      }
    } else if (e.code === 'Space') {
      e.preventDefault();
      if (this.canAct() && this.activeUnit()) this.submit({ type: 'end' });
      else if (this.canAct() && this.display.phase === 'deploy') this.submit({ type: 'ready' });
    } else if (/^[1-9]$/.test(e.key)) {
      const btn = this.els.actions.querySelector<HTMLButtonElement>(`[data-key="${e.key}"]`);
      if (btn && !btn.disabled) btn.click();
    }
  }

  /* ---------- Highlights and panels ---------- */

  private highlights(): Highlights {
    const s = this.display;
    if (!this.canSee()) return NO_HIGHLIGHTS;
    const hl: Highlights = { move: null, tiles: null, radius: 0, targets: new Map(), terminals: new Map(), zone: null, path: null };
    if (s.phase === 'deploy') {
      const z = s.map.zones[s.activeSide];
      hl.zone = { ...z, color: FACTIONS[s.cfg.sides[s.activeSide].faction].color };
      return hl;
    }
    const u = this.activeUnit();
    if (!u) {
      if (this.mode.k === 'reinforce') {
        hl.zone = { ...s.map.zones[s.activeSide], color: FACTIONS[s.cfg.sides[s.activeSide].faction].color };
        return hl;
      }
      for (const v of s.units) {
        if (v.side === s.activeSide && v.state === 'ok' && !v.activated && this.session.mayControl(v.id)) hl.targets.set(v.id, { chance: -1, color: '#ffffff' });
      }
      return hl;
    }
    const m = this.mode;
    if (m.k === 'grenade') {
      hl.tiles = this.tilesInRange(u, grenadeRange(u));
      hl.radius = m.kind === 'emp' ? 2 : 1;
      return hl;
    }
    if (m.k === 'suppress') {
      hl.tiles = this.tilesInRange(u, 14);
      hl.radius = 1;
      return hl;
    }
    if (m.k === 'drone') {
      hl.tiles = new Set(adjacentFree(s, u).map(([x, y]) => x + y * s.map.w));
      return hl;
    }
    if (m.k === 'hack') {
      if (m.program === 'terminal') {
        for (const id of hackableTerminals(s, u)) hl.terminals.set(id, hackPreview(s, u, 'terminal', undefined, id).chance);
      } else {
        for (const v of hackTargets(s, u, m.program)) hl.targets.set(v.id, { chance: hackPreview(s, u, m.program, v.id).chance, color: VIOLET });
      }
      return hl;
    }
    if (m.k === 'patch') {
      for (const v of patchTargets(s, u)) hl.targets.set(v.id, { chance: -1, color: GREEN });
      return hl;
    }
    if (m.k === 'repair') {
      for (const v of repairTargets(s, u)) hl.targets.set(v.id, { chance: -1, color: GREEN });
      return hl;
    }
    if (u.ap >= 1) {
      const reach = reachable(s, u);
      const tiles = stoppable(s, u, reach);
      hl.move = new Set(tiles);
      for (const v of s.units) {
        if (v.team === u.team || v.state !== 'ok') continue;
        const atk = this.attackOn(u, v);
        if (atk) hl.targets.set(v.id, { chance: atk.pv.chance, color: atk.kind === 'shoot' ? RED : AMBER });
      }
      const h = this.hoverTile;
      if (h && hl.move.has(h.x + h.y * s.map.w)) hl.path = pathTo(s, reach, h.x, h.y);
    }
    return hl;
  }

  private refresh(): void {
    this.board.setSelection(this.selected, this.display.activeUnit);
    this.board.setHighlights(this.highlights());
    this.refreshPanels();
  }

  private refreshPanels(): void {
    this.board.setSelection(this.selected, this.display.activeUnit);
    this.refreshTop();
    this.renderTurn();
    this.renderRosters();
    this.renderSheet();
    this.renderActions();
    this.renderPreview();
    this.applySpot();
  }

  /** Lights up whichever part of the screen the tutorial is talking about. */
  private applySpot(): void {
    if (!this.coach) return;
    const spot = this.coach.spot();
    const mark = (node: Element | null | undefined, on: boolean) => node?.classList.toggle('coach-spot', on);
    mark(this.els.preview, spot.panel === 'preview');
    mark(this.els.diceWrap, spot.panel === 'dice');
    mark(this.els.log, spot.panel === 'log');
    this.els.rosters.querySelectorAll('.roster').forEach((r) => mark(r, spot.panel === 'roster'));
    mark(this.els.top.querySelector('.scores'), spot.panel === 'scores');
    this.board.setSpot(this.pumping ? {} : spot);
  }

  private refreshTop(): void {
    const s = this.display;
    const teams = [...new Set(s.cfg.sides.map((c) => c.team))];
    const scores = teams.map((team) => {
      const sides = s.cfg.sides.flatMap((c, i) => (c.team === team ? [i] : []));
      const color = FACTIONS[s.cfg.sides[sides[0]].faction].color;
      const label = sides.length > 1 ? t('game.teamN', { n: team + 1 }) : this.sideName(sides[0]);
      return el('div.score', { style: { '--c': color } }, el('span.score-name', {}, label), el('span.score-num', {}, s.vp[team]));
    });
    const round = s.phase === 'deploy' ? t('game.deploy') : t('game.round', { round: s.round, max: s.cfg.maxRounds });
    const code = this.session.code ? el('button.code-chip', {
      title: t('common.copy'),
      onclick: () => {
        copyText(this.session.code!);
        this.toast(t('common.copied'));
      },
    }, this.session.code) : null;
    this.els.top.replaceChildren(
      el('div.top-title', {}, t('app.title')),
      el('div.top-round', {}, round),
      el('div.top-scenario', {}, `${t(`scenario.${s.cfg.scenario}`)} · ${t(`ruleset.${s.cfg.ruleset}`)}`),
      el('div.scores', {}, scores),
      ...(code ? [code] : []),
      el('button.btn-quiet', { onclick: () => this.leaveDialog() }, t('game.menu')),
    );
  }

  private renderTurn(): void {
    const s = this.display;
    if (s.phase === 'over') {
      this.els.turn.replaceChildren();
      return;
    }
    const side = s.activeSide;
    const color = FACTIONS[s.cfg.sides[side].faction].color;
    const mine = this.session.localSides.has(side) && s.cfg.sides[side].control === 'human';
    const someoneElse = mine && !!s.activeUnit && !this.session.mayControl(s.activeUnit);
    let hint = '';
    if (someoneElse) {
      hint = t('game.coopWaiting', { name: this.unitName(s.activeUnit) });
    } else if (mine) {
      if (s.phase === 'deploy') hint = t('game.deployHint');
      else if (this.mode.k === 'reinforce') hint = t('game.hintReinforce');
      else if (!s.activeUnit) hint = t('game.pickUnit');
      else if (this.mode.k === 'grenade' || this.mode.k === 'suppress' || this.mode.k === 'drone') hint = t('game.hintTile');
      else if (this.mode.k !== 'default') hint = t('game.hintTarget');
      else hint = t('game.hintMove');
    } else if (s.cfg.sides[side].control === 'ai') {
      hint = t('game.thinking');
    } else {
      hint = t('game.waiting', { name: this.sideName(side) });
    }
    this.els.turn.replaceChildren(
      el('span.turn-side', { style: { '--c': color } }, this.sideName(side)),
      el('span.turn-hint', {}, hint),
    );
  }

  private renderRosters(): void {
    const s = this.display;
    const blocks = s.cfg.sides.map((c, side) => {
      const units = s.units.filter((u) => u.side === side && u.state !== 'dead');
      const dead = s.units.filter((u) => u.side === side && u.state === 'dead' && !u.isDrone).length;
      return el('div.roster', { style: { '--c': FACTIONS[c.faction].color }, class: s.activeSide === side && s.phase !== 'over' ? 'is-turn' : '' },
        el('div.roster-head', {}, el('span', {}, this.sideName(side)), dead ? el('span.roster-dead', {}, `${t('game.dropped')}: ${dead}`) : null),
        units.map((u) => this.rosterRow(u)),
      );
    });
    this.els.rosters.replaceChildren(...blocks);
  }

  private rosterRow(u: Unit): HTMLElement {
    const s = this.display;
    const frac = Math.max(0, u.hp / u.hpMax);
    const spent = u.activated && s.activeUnit !== u.id && s.phase === 'battle';
    const canPick = this.canAct() && s.phase === 'battle' && !s.activeUnit && u.side === s.activeSide && u.state === 'ok' && !u.activated && this.session.mayControl(u.id);
    const spotted = this.coach?.spot().unit === u.id && !s.activeUnit && canPick;
    return el('button.unit-row', {
      class: [this.selected === u.id ? 'sel' : '', s.activeUnit === u.id ? 'is-active' : '', spent ? 'spent' : '', u.state === 'down' ? 'down' : '', canPick ? 'can' : '', spotted ? 'coach-spot' : ''].join(' '),
      onclick: () => {
        this.selected = u.id;
        if (canPick) this.submit({ type: 'select', unitId: u.id });
        else this.refresh();
      },
    },
    crewIcon(u.icon, u.role as RoleId),
    el('span.unit-info', {},
      el('span.unit-name', {}, u.name),
      el('span.hp-bar', {}, el('span.hp-fill', { style: { width: `${frac * 100}%`, background: frac > 0.5 ? GREEN : frac > 0.25 ? AMBER : RED } }))),
    el('span.unit-hp', {}, u.state === 'down' ? '×' : u.hp),
    );
  }

  private renderSheet(): void {
    const s = this.display;
    const id = this.selected ?? s.activeUnit;
    const u = id ? unitById(s, id) : null;
    if (!u) {
      this.els.sheet.replaceChildren(el('div.sheet-empty', {}, t('app.tagline')));
      return;
    }
    const rules = rulesOf(s);
    const stat = (label: string, value: string | number) => el('div.stat', {}, el('span.stat-l', {}, label), el('span.stat-v', {}, value));
    const statuses: string[] = [];
    if (u.state === 'down') statuses.push(t('game.status.down'));
    if (u.overwatch) statuses.push(t('game.status.overwatch'));
    if (u.braced) statuses.push(t('game.status.braced'));
    if (u.glitch) statuses.push(t('game.status.glitch'));
    if (u.seized) statuses.push(t('game.status.seized'));
    if (u.pinned) statuses.push(t('game.status.pinned'));
    if (u.jammed) statuses.push(t('game.status.jammed'));
    if (s.core?.carrier === u.id) statuses.push(t('game.status.carrying'));
    if (u.activated && s.activeUnit !== u.id && s.phase === 'battle') statuses.push(t('game.spent'));
    for (const i of u.injuries) statuses.push(t(`injury.${i}`));
    const ammo = u.ranged && rules.ammo ? `${u.ammo}/${WEAPONS[u.ranged].mag}` : u.ranged ? '∞' : '–';
    const weapon = (id: string | null) => (id ? `${t(`weapon.${id}`)} ${WEAPONS[id as keyof typeof WEAPONS].dice}d6${WEAPONS[id as keyof typeof WEAPONS].bonus ? `+${WEAPONS[id as keyof typeof WEAPONS].bonus}` : ''}` : '');
    this.els.sheet.replaceChildren(
      el('div.sheet-head', { style: { '--c': FACTIONS[u.faction].color } },
        crewIcon(u.icon, u.role),
        el('div', {}, el('div.sheet-name', {}, u.name), el('div.sheet-role', {}, `${t(`role.${u.role}`)} · ${t(`faction.${u.faction}`)}`)),
        s.activeUnit === u.id ? el('div.ap-pips', { title: t('game.ap', { n: u.ap }) }, Array.from({ length: u.ap }, () => el('span.ap-pip'))) : null,
      ),
      el('div.stats', {},
        stat(t('game.hp'), `${u.hp}/${u.hpMax}`),
        stat(t('game.armor'), rules.hitLocations ? `${u.armor} · ${u.armorHead}` : u.armor),
        stat(t('game.move'), moveOf(s, u)),
        stat(t('game.ammo'), ammo),
        u.skills.medic > 0 ? stat(t('game.kits'), u.kits) : null,
        u.luck > 0 ? stat(t('action.luck'), u.luck) : null,
        u.net > 0 ? stat(t('game.net'), u.net) : null,
        u.rez > 0 ? stat(t('game.rez'), u.rez) : null,
      ),
      el('div.sheet-gear', {}, [weapon(u.ranged), weapon(u.melee)].filter(Boolean).join(' · ')),
      ...(u.chrome.length ? [el('div.chips', {}, u.chrome.map((c) => el('span.chip', { title: t(`chrome.${c}.d`) }, t(`chrome.${c}`))))] : []),
      ...(statuses.length ? [el('div.chips', {}, statuses.map((c) => el('span.chip.chip-warn', {}, c)))] : []),
    );
  }

  private renderActions(): void {
    const s = this.display;
    const bar = this.els.actions;
    const nodes: HTMLElement[] = [];
    if (!this.canSee()) {
      bar.replaceChildren();
      return;
    }
    if (s.phase === 'deploy') {
      bar.replaceChildren(el('button.btn-primary', { onclick: () => this.submit({ type: 'ready' }) }, t('action.ready')));
      return;
    }
    const u = this.activeUnit();
    if (!u) {
      bar.replaceChildren(...this.reinforceButtons());
      return;
    }
    const o: UnitOptions = unitOptions(s, u);
    const rules = rulesOf(s);
    let key = 1;
    const btn = (icon: string, label: string, enabled: boolean, onclick: () => void, opts: { title?: string; on?: boolean; color?: string; act?: string } = {}) => {
      const k = key++;
      return el('button.act', {
        // Only 1 to 9 exist as keys, so later buttons show no number they couldn't honour.
        disabled: !enabled, title: opts.title ?? label, 'data-key': k <= 9 ? k : undefined, 'data-act': opts.act, class: opts.on ? 'on' : '',
        style: opts.color ? { '--c': opts.color } : undefined, onclick,
      }, k <= 9 ? el('span.key', {}, k) : null, actionIcon(icon), el('span.act-label', {}, label));
    };
    const setMode = (m: Mode) => {
      sfx.click();
      this.mode = m;
      this.refresh();
    };
    const modeIs = (k: Mode['k'], sub?: string) => this.mode.k === k && (!sub || (this.mode as { kind?: string; program?: string }).kind === sub || (this.mode as { program?: string }).program === sub);

    if (u.ranged) {
      nodes.push(btn('aim', t('action.aim'), o.aim && u.ap >= 1, () => this.submit({ type: 'aim' }), { title: t('action.aim.d'), act: 'aim' }));
      if (rules.burst && WEAPONS[u.ranged].burst) {
        nodes.push(btn('burst', t('action.burst'), o.burst || this.burst, () => { this.burst = !this.burst; sfx.click(); this.refresh(); }, { title: t('action.burst.d'), on: this.burst }));
      }
      if (rules.ammo) nodes.push(btn('reload', t('action.reload'), o.reload, () => this.submit({ type: 'reload' })));
      if (rules.overwatch) nodes.push(btn('overwatch', t('action.overwatch'), o.overwatch, () => this.submit({ type: 'overwatch' }), { title: t('action.overwatch.d') }));
      if (u.jammed) nodes.push(btn('clearJam', t('action.clearJam'), o.clearJam, () => this.submit({ type: 'clearJam' }), { color: RED }));
      if (rules.suppress && WEAPONS[u.ranged].burst) nodes.push(btn('suppress', t('action.suppress'), o.suppress, () => setMode({ k: 'suppress' }), { title: t('action.suppress.d'), on: modeIs('suppress') }));
    }
    if (u.ranged) {
      nodes.push(btn('melee', t('action.melee'), o.melee || o.charge || this.meleePref, () => { this.meleePref = !this.meleePref; sfx.click(); this.refresh(); }, { title: t('action.melee.d'), on: this.meleePref }));
    }
    nodes.push(btn('brace', t('action.brace'), o.brace, () => this.submit({ type: 'brace' }), { title: t('action.brace.d') }));
    for (const g of o.grenades) {
      nodes.push(btn(g, `${t(`grenade.${g}`)} ×${u.grenades[g]}`, true, () => setMode({ k: 'grenade', kind: g }), { on: modeIs('grenade', g), color: AMBER }));
    }
    for (const p of o.programs) {
      nodes.push(btn(p, t(`program.${p}`), true, () => setMode({ k: 'hack', program: p }), { title: t(`program.${p}.d`), on: modeIs('hack', p), color: VIOLET }));
    }
    if (u.skills.medic > 0) nodes.push(btn('patch', `${t('action.patch')} ×${u.kits}`, o.patch, () => setMode({ k: 'patch' }), { on: modeIs('patch'), color: GREEN }));
    if (u.skills.tech > 0) {
      nodes.push(btn('repair', t('action.repair'), o.repair, () => setMode({ k: 'repair' }), { on: modeIs('repair'), color: GREEN }));
      if (u.drones > 0) nodes.push(btn('drone', t('action.drone'), o.drone, () => setMode({ k: 'drone' }), { on: modeIs('drone'), color: CYAN }));
    }
    if (u.chrome.includes('stim') && !u.used.includes('stim')) nodes.push(btn('stim', t('action.stim'), o.stim, () => this.submit({ type: 'stim' }), { color: GREEN }));
    if (u.chrome.includes('spike') && !u.used.includes('spike')) nodes.push(btn('spike', t('action.spike'), o.spike, () => this.submit({ type: 'spike' }), { color: CYAN }));
    if (o.capture.length) nodes.push(btn('capture', t('action.capture'), true, () => this.submit({ type: 'capture', terminalId: o.capture[0] }), { title: t('action.capture.d'), color: AMBER }));
    if (o.grab) nodes.push(btn('grab', t('action.grab'), true, () => this.submit({ type: 'grab' }), { color: AMBER }));

    if (rules.aimedShots && u.ranged) {
      const aims: (HitLoc | null)[] = [null, 'head', 'arms', 'legs'];
      nodes.push(el('div.aim-select', {}, aims.map((loc) => el('button.aim-opt', {
        class: this.aimedAt === loc ? 'on' : '',
        onclick: () => { this.aimedAt = loc; sfx.click(); this.refresh(); },
      }, t(`aimed.${loc ?? 'body'}`)))));
    }
    if (u.luck > 0) nodes.push(btn('spike', `${t('action.luck')} ×${u.luck}`, true, () => this.submit({ type: 'luck' }), { title: t('action.luck.d'), on: u.luckBonus > 0, color: AMBER }));
    if (u.role === 'breaker' && u.focus.aim + u.focus.damage + u.focus.guard + u.focus.init > 0) {
      nodes.push(el('div.aim-select', { title: t('focus.d') }, (['aim', 'damage', 'guard', 'init'] as const).map((k) => el('button.aim-opt', {
        onclick: () => this.submit({ type: 'focus', kind: k }),
      }, `${t(`focus.${k}`)} ${u.focus[k]}`))));
    }
    nodes.push(el('button.act.act-end', { 'data-act': 'end', title: t('action.end'), onclick: () => this.submit({ type: 'end' }) }, el('span.key', {}, '␣'), actionIcon('end'), el('span.act-label', {}, t('action.end'))));
    bar.replaceChildren(...nodes);
    if (this.coach && !this.coach.isFree()) {
      // During the guided part, only the button the lesson asks for works.
      const wanted = this.coach.spot().button;
      bar.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        const on = !!wanted && b.dataset.act === wanted;
        b.disabled = !on;
        b.classList.toggle('coach-spot', on);
      });
    }
  }

  private renderPreview(): void {
    const s = this.display;
    const box = this.els.preview;
    const u = this.activeUnit();
    const h = this.hoverTile;
    const pinId = this.coach?.pinned();
    const pin = pinId ? unitById(s, pinId) : undefined;
    if (!u || (!h && !pin) || !this.canSee() || this.mode.k !== 'default') {
      if (u && h && this.canSee() && this.mode.k === 'hack' && this.mode.program !== 'terminal') {
        const v = this.unitAt(h.x, h.y);
        if (v && hackTargets(s, u, this.mode.program).some((x) => x.id === v.id)) {
          const pv = hackPreview(s, u, this.mode.program, v.id);
          box.replaceChildren(
            el('div.pv-chance', {}, `${Math.round(pv.chance * 100)}%`),
            el('div.pv-sub', {}, t('game.needRoll', { mod: pv.mod, tn: pv.tn })),
            el('div.pv-sub', {}, t(`program.${this.mode.program}.d`)),
          );
          return;
        }
      }
      box.replaceChildren();
      return;
    }
    const under = h ? this.unitAt(h.x, h.y) : undefined;
    const isTarget = (x: Unit | undefined) => !!x && x.team !== u.team && x.state === 'ok';
    const v = isTarget(under) ? under : pin;
    if (!v || !isTarget(v)) {
      box.replaceChildren();
      return;
    }
    const atk = this.attackOn(u, v);
    if (!atk) {
      const reason = u.ranged ? previewAttack(s, u, v, 'ranged', { mode: this.burst ? 'burst' : undefined }).reason : 'notAdjacent';
      box.replaceChildren(el('div.pv-target', {}, v.name), el('div.pv-sub', {}, t(`reason.${reason}`)));
      return;
    }
    const { pv } = atk;
    const line = (p: { k: string; v: number }) => el('div.pv-mod', {}, el('span', {}, t(`mod.${p.k}`)), el('span.pv-num', {}, p.k === 'range' || p.k === 'defence' ? p.v : signed(p.v)));
    box.replaceChildren(
      el('div.pv-head', {},
        el('div.pv-chance', {}, `${Math.round(pv.chance * 100)}%`),
        el('div', {},
          el('div.pv-target', {}, v.name),
          el('div.pv-sub', {}, `${t(`weapon.${pv.weapon}`)} · ${t('game.damageAvg', { n: Math.round(pv.avgDmg) })}`),
          el('div.pv-sub', {}, `${t('game.range', { n: pv.dist })} · ${t(`game.cover.${pv.cover}`)}`),
        ),
      ),
      el('div.pv-cols', {},
        el('div', {}, el('div.pv-col-h', {}, `d10 ${signed(pv.mod)}`), pv.mods.map(line)),
        el('div', {}, el('div.pv-col-h', {}, `vs ${pv.tn}`), pv.tnParts.map(line)),
      ),
    );
  }

  /* ---------- Messages and dialogs ---------- */

  private logLine(text: string, cls?: string): void {
    const log = this.els.log;
    log.appendChild(el('div.log-line', { class: cls ? `log-${cls}` : '' }, text));
    while (log.childElementCount > 300) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
  }

  private toast(text: string): void {
    const n = el('div.toast', {}, text);
    this.els.toasts.appendChild(n);
    setTimeout(() => n.remove(), 4500);
  }

  private showBanner(text: string | null): void {
    this.els.banner.hidden = text === null;
    this.els.banner.textContent = text ?? '';
  }

  private bigBanner(title: string, sub: string): void {
    const n = el('div.big-inner', {}, el('div.big-title', {}, title), el('div.big-sub', {}, sub));
    this.els.bigBanner.replaceChildren(n);
    setTimeout(() => n.remove(), 1300 * speedFactor());
  }

  private modal(content: HTMLElement): HTMLElement {
    const back = el('div.modal-back', {}, el('div.modal.card', {}, content));
    this.root.appendChild(back);
    return back;
  }

  private leaveDialog(): void {
    const session = this.session;
    const canConcede = !this.coach && session.localSides.has(this.display.activeSide) && this.display.phase !== 'over' && this.display.cfg.sides[this.display.activeSide].control === 'human' && (!this.display.owners || session.isHost);
    const msg = this.coach ? 'tutorial.leave' : !session.online ? 'game.leaveLocal' : session.isHost ? 'game.leaveHost' : 'game.leaveOnline';
    const m = this.modal(el('div', {},
      el('h2', {}, t('game.leave')),
      el('p', {}, t(msg)),
      el('div.modal-actions', {},
        el('button.btn-primary', { onclick: () => m.remove() }, t('game.stay')),
        canConcede ? el('button.btn-quiet', {
          onclick: () => {
            m.remove();
            this.pending = !session.isHost;
            session.submit({ type: 'concede' }, this.display.activeSide);
          },
        }, t('action.concede')) : null,
        el('button.btn-quiet', {
          onclick: () => {
            this.dispose();
            session.dispose();
            this.nav.toMenu();
          },
        }, t('game.leaveConfirm')),
      ),
    ));
  }

  private closedDialog(reason: string): void {
    if (this.display.phase === 'over' && this.overShown) return;
    const m = this.modal(el('div', {},
      el('h2', {}, t('app.title')),
      el('p', {}, t(`net.closed.${reason}`)),
      el('div.modal-actions', {}, el('button.btn-primary', {
        onclick: () => {
          m.remove();
          this.dispose();
          this.session.dispose();
          this.nav.toMenu();
        },
      }, t('over.menu'))),
    ));
  }

  private showTutorialEnd(): void {
    const won = this.display.winner === 0;
    const practice = this.coach?.lesson === 'practice';
    const key = practice ? 'practice' : 'tutorial';
    if (won) {
      sfx.win();
      this.nav.tutorialDone?.();
    }
    const leave = (then: () => void) => () => {
      m.remove();
      this.dispose();
      this.session.dispose();
      then();
    };
    const m = this.modal(el('div.over', {},
      el('h2', {}, t(`${key}.${won ? 'win' : 'lose'}.title`)),
      el('p', {}, t(`${key}.${won ? 'win' : 'lose'}.text`)),
      won ? el('p', {}, t(`${key}.win.depth`)) : null,
      el('div.modal-actions', {},
        won
          ? el('button.btn-primary', { onclick: leave(this.nav.rematch ?? this.nav.toMenu) }, t(practice ? 'practice.next' : 'tutorial.firstGame'))
          : el('button.btn-primary', { onclick: leave(this.nav.retry ?? this.nav.toMenu) }, t('tutorial.retry')),
        el('button.btn-quiet', { onclick: leave(this.nav.toMenu) }, t('over.menu')),
      ),
    ));
  }

  /** A game master can spend their budget on fresh enemies at the start of their turn. */
  private reinforceButtons(): HTMLElement[] {
    const s = this.display;
    const left = s.gmBudget?.[s.activeSide];
    if (left === undefined || !this.isGameMaster() || s.activeSide !== 1) return [];
    return [
      el('div.gm-budget', {}, el('span', {}, t('game.gmBudget')), el('b', {}, left)),
      ...RECRUITABLE.filter((r) => ROLES[r].cost <= left).map((role) => el('button.act', {
        class: this.mode.k === 'reinforce' && this.mode.role === role ? 'on' : '',
        title: t(`role.${role}.d`),
        onclick: () => {
          sfx.click();
          this.mode = this.mode.k === 'reinforce' && this.mode.role === role ? { k: 'default' } : { k: 'reinforce', role };
          this.refresh();
        },
      }, roleIcon(role), el('span.act-label', {}, `${t(`role.${role}`)} ${ROLES[role].cost}`))),
    ];
  }

  private showOver(): void {
    if (this.overShown) return;
    this.overShown = true;
    if (this.coach) {
      this.showTutorialEnd();
      return;
    }
    const s = this.display;
    // The fanfare is for whoever is sitting here. Losing to the computer or to a friend online gets the other sound.
    const here = s.cfg.sides.flatMap((c, i) => (this.session.localSides.has(i) && c.control === 'human' ? [c.team] : []));
    if (s.winner !== null && s.winner !== -1 && (!here.length || here.includes(s.winner))) sfx.win();
    else sfx.lose();
    let title: string;
    if (s.winner === -1 || s.winner === null) title = t('over.draw');
    else {
      const sides = s.cfg.sides.flatMap((c, i) => (c.team === s.winner ? [i] : []));
      title = sides.length > 1 ? t('over.teamWin', { n: (s.winner ?? 0) + 1 }) : t('over.win', { name: this.sideName(sides[0]) });
    }
    const rows = [...s.units].filter((u) => !u.isDrone).sort((a, b) => b.kills - a.kills || b.dealt - a.dealt).slice(0, 8);
    const m = this.modal(el('div.over', {},
      el('h2', {}, title),
      el('p', {}, t(`over.reason.${s.reason ?? 'rounds'}`)),
      el('table.over-table', {},
        el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, t('over.kills')), el('th', {}, t('over.dealt')))),
        el('tbody', {}, rows.map((u) => el('tr', { style: { '--c': FACTIONS[u.faction].color } },
          el('td.over-name', {}, u.name), el('td', {}, u.kills), el('td', {}, u.dealt))))),
      el('div.modal-actions', {},
        this.nav.missionOver ? el('button.btn-primary', {
          onclick: () => {
            m.remove();
            this.dispose();
            this.session.dispose();
            this.nav.missionOver!();
          },
        }, t('camp.debrief.next')) : null,
        this.nav.rematch ? el('button.btn-primary', {
          onclick: () => {
            m.remove();
            this.dispose();
            this.session.dispose();
            this.nav.rematch!();
          },
        }, t('over.rematch')) : null,
        this.nav.missionOver ? null : el('button.btn-quiet', {
          onclick: () => {
            m.remove();
            this.dispose();
            this.session.dispose();
            this.nav.toMenu();
          },
        }, t('over.menu')),
      ),
    ));
  }
}
