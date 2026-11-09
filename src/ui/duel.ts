import { CARDS, MAX_IN_LANE, NO_LANE, crackedCount, duelTip, type CardId, type DuelSide } from '../engine/duel';
import type { RulesetId } from '../engine/types';
import { DuelGuest, DuelHost, DuelLocal, type DuelController } from '../net/duelNet';
import { RelayClient } from '../net/relayClient';
import type { HostMsg } from '../net/sessions';
import { RULESET_OPTIONS, randomSeed } from '../net/table';
import { sfx } from './audio';
import { copyText, el, loadingPage } from './dom';
import { t, tx } from './i18n';
import { settings } from './settings';

export interface DuelScreens {
  screen(...children: (HTMLElement | null)[]): void;
  menu(): void;
  alert(text: string): void;
  myName(): string;
  relayError(e: unknown): string;
}

let ui: DuelScreens;
export function initDuelScreens(s: DuelScreens): void {
  ui = s;
}

function lessonCard(tip: string): HTMLElement {
  return el('div.camp-tip.duel-tip', {}, el('div', {}, el('h3', {}, t(`duel.tip.${tip}.title`)), el('p', {}, t(`duel.tip.${tip}.text`))));
}

export function duelSetup(): void {
  let ruleset: RulesetId = 'standard';
  let side: DuelSide = 'hacker';
  let mode: 'ai' | 'local' | 'online' = 'ai';
  const page = el('div.center-page.scroll');
  const pick = (title: string, desc: string, on: boolean, onclick: () => void) => el('button.pick-card', {
    class: on ? 'on' : '', onclick: () => { sfx.click(); onclick(); render(); },
  }, el('span.pick-title', {}, title), el('span.pick-desc', {}, desc));
  const start = async () => {
    const seed = randomSeed();
    if (mode !== 'online') {
      run(new DuelLocal(seed, ruleset, mode === 'ai' ? side : null));
      return;
    }
    const relay = new RelayClient(settings.relayUrl);
    ui.screen(loadingPage(t('join.connecting')));
    try {
      await relay.create(ui.myName());
      run(new DuelHost(relay, seed, ruleset, side));
    } catch (e) {
      relay.close();
      ui.alert(ui.relayError(e));
    }
  };
  const render = () => page.replaceChildren(el('div.card.wide', {},
    el('button.btn-quiet.back', { onclick: ui.menu }, `← ${t('common.back')}`),
    el('h2', {}, t('menu.duel')),
    el('p.muted', {}, t('rules.duel')),
    el('h3', {}, t('table.rules')),
    el('div.pick-row', {}, RULESET_OPTIONS.map((id) => pick(t(`ruleset.${id}`), t(`duel.depth.${id}`), ruleset === id, () => { ruleset = id; }))),
    el('h3', {}, t('duel.opponent')),
    el('div.pick-row', {},
      pick(t('camp.gm.computer'), t('duel.opp.ai'), mode === 'ai', () => { mode = 'ai'; }),
      pick(t('camp.players.local'), t('duel.opp.local'), mode === 'local', () => { mode = 'local'; }),
      pick(t('camp.players.online'), t('duel.opp.online'), mode === 'online', () => { mode = 'online'; }),
    ),
    mode === 'local' ? null : el('h3', {}, t('duel.playAs')),
    mode === 'local' ? null : el('div.pick-row.two', {},
      pick(t('duel.side.hacker'), t('duel.side.hacker.d'), side === 'hacker', () => { side = 'hacker'; }),
      pick(t('duel.side.corp'), t('duel.side.corp.d'), side === 'corp', () => { side = 'corp'; }),
    ),
    el('button.btn-primary.btn-start', { onclick: () => void start() }, t('camp.begin')),
  ));
  render();
  ui.screen(page);
}

export function joinDuel(relay: RelayClient, first: Extract<HostMsg, { k: 'duel' }>): void {
  run(new DuelGuest(relay, first));
}

const cardName = (id: CardId) => t(`card.${id}`);
const PLACED = new Set(['program', 'barrier', 'sentry', 'tracer']);

/** Cards that stay in a lane, or a program being moved there, need a free spot in it. */
function laneFull(id: CardId, lane: { hacker: unknown[]; corp: unknown[] }, side: DuelSide): boolean {
  return (PLACED.has(CARDS[id].kind) || id === 'reroute') && lane[side].length >= MAX_IN_LANE;
}

/** The lesson: a Quick Job duel as the hacker against the computer, with a hint above the board. */
export function duelLesson(): void {
  run(new DuelLocal(randomSeed(), 'quick', 'hacker'), true);
}

function run(ctl: DuelController, lesson = false): void {
  let chosen: number | null = null;
  let targeted: { lane: number; index: number } | null = null;
  let passed: DuelSide | null = null;
  const leave = () => { ctl.dispose(); ui.menu(); };

  const statLine = (id: CardId) => {
    const d = CARDS[id];
    const bits: string[] = [];
    if (d.power && (d.kind === 'program' || d.kind === 'sentry')) bits.push(t('duel.power', { n: d.power }));
    if (d.hp) bits.push(t('duel.hp', { n: d.hp }));
    return bits.join(' · ');
  };

  const render = () => {
    const s = ctl.state;
    if (!s) {
      ui.screen(el('div.center-page', {}, el('div.card.narrow', {},
        el('button.btn-quiet.back', { onclick: leave }, `← ${t('game.menu')}`),
        el('h2', {}, t('table.code')),
        el('button.code-big', { onclick: () => copyText(ctl.code ?? '') }, ctl.code ?? ''),
        el('p.muted', {}, t('duel.waiting')),
      )));
      return;
    }
    // On one PC, the hand stays hidden until the next person says they're ready.
    const viewer: DuelSide = ctl.me ?? s.active;
    if (!ctl.me && passed !== s.active && !s.winner) {
      ui.screen(el('div.center-page', {}, el('div.card.narrow', {},
        el('h2', {}, t(`duel.side.${s.active}`)),
        el('p', {}, t('duel.passDevice')),
        el('button.btn-primary', { onclick: () => { passed = s.active; render(); } }, t('duel.ready')),
      )));
      return;
    }
    const mine = s.active === viewer && !s.winner;
    const player = s[viewer];
    const chosenId = chosen !== null ? player.hand[chosen] : null;
    const play = (lane: number) => {
      if (chosen === null || !chosenId) return;
      const needsTarget = chosenId === 'overload' || chosenId === 'reroute';
      if (chosenId === 'reroute' && !targeted) return;
      if (chosenId === 'reroute') {
        ctl.act({ a: 'play', hand: chosen, lane: targeted!.lane, target: targeted!.index, to: lane }, viewer);
      } else {
        ctl.act({ a: 'play', hand: chosen, lane, target: needsTarget ? targeted?.index ?? 0 : undefined }, viewer);
      }
      sfx.click();
      chosen = null;
      targeted = null;
      render();
    };
    const token = (x: { card: CardId; hp: number; locked: boolean }, lane: number, index: number, friendly: boolean) => el('button.duel-token', {
      class: `${targeted?.lane === lane && targeted.index === index ? 'on' : ''} ${x.locked ? 'is-locked' : ''}`,
      title: t(`card.${x.card}.d`),
      onclick: () => {
        const wantsOwn = chosenId === 'reroute' && friendly;
        const wantsEnemy = chosenId === 'overload' && !friendly;
        if (wantsEnemy) {
          targeted = { lane, index };
          play(lane);
        } else if (wantsOwn) {
          targeted = { lane, index };
          render();
        }
      },
    }, el('b', {}, cardName(x.card)), el('span', {}, `${CARDS[x.card].power && CARDS[x.card].kind !== 'barrier' ? `${CARDS[x.card].power} / ` : ''}${x.hp}${x.locked ? ` · ${t('duel.locked')}` : ''}`));

    ui.screen(el('div.table-page.duel', {},
      el('header.table-head', {},
        el('button.btn-quiet.back', { onclick: leave }, `← ${t('game.menu')}`),
        el('div.camp-title', {}, el('h2', {}, t('menu.duel')), el('span.muted', {}, t('duel.round', { n: s.round, max: s.maxRounds }))),
        el('div.camp-stats', {},
          el('div.camp-stat', {}, el('span', {}, t('duel.trace')), el('b', {}, `${s.trace}/${s.traceMax}`)),
          el('div.camp-stat', {}, el('span', {}, t('duel.cracked')), el('b', {}, `${crackedCount(s)}/2`)),
          el('div.camp-stat', {}, el('span', {}, t('duel.bandwidth')), el('b', {}, player.bandwidth)),
        ),
        ctl.code ? el('button.code-chip', { onclick: () => copyText(ctl.code!) }, ctl.code) : null,
      ),
      lesson ? lessonCard(duelTip(s, chosenId ?? null)) : null,
      el('div.duel-board', {}, s.lanes.map((l, i) => el('section.duel-lane', {
        class: l.node <= 0 ? 'is-cracked' : chosenId && mine ? 'can' : '',
      },
      el('div.duel-node', {}, el('span', {}, t('duel.node', { n: i + 1 })), el('b', {}, l.node <= 0 ? t('duel.crackedOne') : `${l.node}/${s.nodeMax}`)),
      el('div.duel-row', {}, el('h3', {}, t('duel.side.corp')), l.corp.map((x, n) => token(x, i, n, viewer === 'corp'))),
      el('div.duel-row', {}, el('h3', {}, t('duel.side.hacker')), l.hacker.map((x, n) => token(x, i, n, viewer === 'hacker'))),
      mine && chosenId && l.node > 0 && chosenId !== 'overload' && !NO_LANE.includes(chosenId) && !laneFull(chosenId, l, viewer) ? el('button.btn-quiet', { onclick: () => play(i) }, t(chosenId === 'reroute' ? 'duel.moveHere' : 'duel.playHere')) : null,
      ))),
      el('div.duel-foot', {},
        el('div.duel-hand', {}, player.hand.map((id, i) => el('button.duel-card', {
          class: chosen === i ? 'on' : '', disabled: !mine || CARDS[id].cost > player.bandwidth,
          onclick: () => { sfx.click(); chosen = chosen === i ? null : i; targeted = null; render(); },
        },
        el('span.duel-card-top', {}, el('b', {}, cardName(id)), el('span.duel-cost', {}, CARDS[id].cost)),
        el('span.duel-kind', {}, `${t(`duel.kind.${CARDS[id].kind}`)}${statLine(id) ? ` · ${statLine(id)}` : ''}`),
        el('span.pick-desc', {}, t(`card.${id}.d`))))),
        el('div.duel-side', {},
          el('div.duel-log', {}, s.log.slice(-5).map((m) => el('div', {}, tx(m)))),
          mine && chosenId && NO_LANE.includes(chosenId) ? el('button.btn-primary', { onclick: () => play(s.lanes.findIndex((l) => l.node > 0)) }, t('duel.playCard', { card: cardName(chosenId) })) : null,
          s.winner ? el('div', {},
            el('h2', {}, t(`duel.win.${s.winner}`)),
            el('p', {}, t(`duel.reason.${s.reason}`)),
            lesson ? el('button.btn-primary', { onclick: () => { ctl.dispose(); duelLesson(); } }, t('duel.lesson.again')) : null,
            el(lesson ? 'button.btn-quiet' : 'button.btn-primary', { onclick: leave }, t('over.menu')),
          ) : mine
            ? el('button.btn-primary', { onclick: () => { chosen = null; ctl.act({ a: 'end' }, viewer); } }, t(viewer === 'hacker' ? 'duel.endRun' : 'duel.endTurn'))
            : el('p.muted', {}, t('duel.theirTurn')),
          s.winner ? null : el('button.btn-quiet', { onclick: () => ctl.act({ a: 'concede' }, viewer) }, t('action.concede')),
        ),
      ),
    ));
  };
  ctl.onChange = render;
  ctl.onClosed = (reason) => {
    ctl.dispose();
    ui.alert(t(`net.closed.${reason}`));
  };
  render();
}

