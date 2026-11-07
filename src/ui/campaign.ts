import {
  CHROME_COST, CHROME_IDS, FACTIONS, RECRUITABLE, ROLES, WEAPONS,
} from '../engine/data';
import {
  MAX_CHROME, MAX_SQUAD, REST_COST, ROLE_MOVES, STAT_KEYS, THERAPY_COST, TREAT_COST, advancesFor, availableGigs, choiceAllowed, chromeCost, clinicCost, createCampaign, crewValue, effectiveThreat, enemyPoints, freeLeft,
  grenadeCost, hireCost, nodeOf, pickHandle, starterCrew, statLine, weaponCost, xpToNext,
  type AdvancePick, type Arc, type CampaignMode, type CampaignState, type CrewMember, type Gig, type GmEvent, type NewCampaign,
} from '../engine/campaign';
import { THE_NOTE, generateArc } from '../engine/story';
import type { ChromeId, GrenadeKind, InjuryId, RoleId, RulesetId, Stats, WeaponId } from '../engine/types';
import {
  CampaignGuest, CampaignHost, MAX_SAVES, deleteCampaign, listCampaignSaves, loadCampaign, saveCampaign, type CampaignController,
} from '../net/campaignNet';
import { writeArc } from '../net/gm';
import { RelayClient, RelayError } from '../net/relayClient';
import type { GameSession, HostMsg } from '../net/sessions';
import { RULESET_OPTIONS, randomSeed } from '../net/table';
import { sfx } from './audio';
import { copyText, el, selectEl } from './dom';
import type { GameView } from './game';
import { getLang, t, tx } from './i18n';
import { roleIcon } from './icons';
import { desktopLlm, llmReady as checkLlmReady } from './llm';
import { settings } from './settings';

/** What this file needs from the main screen code; passed in so the two don't reach into each other. */
export interface CampaignHostScreens {
  screen(...children: (HTMLElement | null)[]): void;
  mountGame(session: GameSession, nav: { toMenu(): void; missionOver(): void }): GameView;
  menu(): void;
  alert(text: string): void;
  myName(): string;
  relayError(e: unknown): string;
}

let ui: CampaignHostScreens;
export function initCampaignScreens(screens: CampaignHostScreens): void {
  ui = screens;
}

const cr = (n: number): string => t('camp.cr', { n });

function back(onclick: () => void, label = t('common.back')): HTMLElement {
  return el('button.btn-quiet.back', { onclick: () => { sfx.click(); onclick(); } }, `← ${label}`);
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el('label.field', {}, el('span', {}, label), control);
}

/* ---------- The campaign list: several can run at once ---------- */

export function campaignHome(): void {
  const saves = listCampaignSaves();
  const rows = saves.map((s) => {
    let armed = false;
    const del = el('button.btn-quiet', {
      onclick: () => {
        if (!armed) {
          armed = true;
          del.textContent = t('camp.deleteSure');
          return;
        }
        deleteCampaign(s.id);
        campaignHome();
      },
    }, t('camp.delete')) as HTMLButtonElement;
    const place = s.mode === 'endless'
      ? t('camp.endlessProgress', { n: s.gigsDone })
      : `${s.title ? tx(s.title) : ''}${s.chapter ? ` · ${t('camp.chapterOf', { n: s.chapter, of: s.chapters })}` : ''}`;
    return el('div.camp-save', {},
      el('div.camp-save-info', {},
        el('b', {}, s.crewName),
        el('span', {}, place),
        el('span.muted', {}, `${cr(s.cash)} · ${t('camp.storiesDone', { n: s.arcsDone })}${s.online ? ` · ${t('camp.online')}` : ''}`),
      ),
      el('button.btn-primary', { onclick: () => resume(s.id) }, t('menu.continue')),
      del,
    );
  });
  ui.screen(el('div.center-page.scroll', {}, el('div.card.wide', {},
    back(ui.menu),
    el('h2', {}, t('menu.campaign')),
    el('p.muted', {}, t('camp.homeHint')),
    rows.length ? el('div.camp-saves', {}, rows) : null,
    saves.length >= MAX_SAVES
      ? el('p.form-msg', {}, t('camp.savesFull'))
      : el('button.btn-primary.camp-new', { onclick: () => void newCampaignScreen() }, t('camp.new')),
  )));
}

function resume(id: string): void {
  const save = loadCampaign(id);
  if (!save) return campaignHome();
  const go = async (online: boolean) => {
    let relay: RelayClient | null = null;
    if (online) {
      relay = new RelayClient(settings.relayUrl);
      try {
        await relay.create(ui.myName());
      } catch (e) {
        relay.close();
        ui.alert(ui.relayError(e));
        return;
      }
    }
    // Friends get new connections when a campaign is resumed, so their seats wait for them by name.
    const camp: CampaignState = {
      ...save.camp, busy: false,
      players: save.camp.players.map((p, i) => ({ ...p, peer: null, connected: i === 0 || !online })),
    };
    run(new CampaignHost(camp, { ...hostOptions(relay), game: save.game, keys: save.keys }));
  };
  if (save.online) return void go(true);
  void go(false);
}

const hostOptions = (relay: RelayClient | null) => ({
  relay,
  name: ui.myName(),
  llm: settings.gmEnabled ? desktopLlm() : null,
  lang: getLang,
  resolve: tx,
  save: saveCampaign,
});

/* ---------- A new campaign ---------- */

type StorySource = 'generated' | 'note' | 'llm';

async function newCampaignScreen(): Promise<void> {
  const llmReady = await checkLlmReady();
  const seed = randomSeed();
  let mode: CampaignMode = 'story';
  let source: StorySource = llmReady ? 'llm' : 'generated';
  let ruleset: RulesetId = 'standard';
  let online = false;
  let localGm = false;
  let narrator = llmReady;
  let crewName = 'Berth 9';
  let wish = '';
  const crew: { role: RoleId; name: string; stats?: Partial<Stats> }[] = starterCrew(seed);
  let create: 'template' | 'roll' | 'points' = 'template';
  const POINTS = 4;
  const rollStats = () => {
    for (const c of crew) c.stats = Object.fromEntries(STAT_KEYS.map((k) => [k, Math.floor(Math.random() * 4) - 1]));
  };
  const clearStats = () => { for (const c of crew) c.stats = {}; };
  const pointsLeft = (c: { stats?: Partial<Stats> }) => POINTS - Object.values(c.stats ?? {}).reduce((n: number, v) => n + (v ?? 0), 0);

  const pick = (title: string, desc: string, on: boolean, onclick: () => void, disabled = false) => el('button.pick-card', {
    class: on ? 'on' : '', disabled, onclick: () => { sfx.click(); onclick(); render(); },
  }, el('span.pick-title', {}, title), el('span.pick-desc', {}, desc));

  const page = el('div.camp-new-page');
  const render = () => {
    const scroll = page.scrollTop;
    page.replaceChildren(
      el('div.camp-form', {},
        back(campaignHome),
        el('h2', {}, t('camp.new')),
        el('h3', {}, t('camp.kind')),
        el('div.pick-row.two', {},
          pick(t('camp.mode.story'), t('camp.mode.story.d'), mode === 'story', () => { mode = 'story'; }),
          pick(t('camp.mode.endless'), t('camp.mode.endless.d'), mode === 'endless', () => { mode = 'endless'; }),
        ),
        mode === 'story' ? el('h3', {}, t('camp.source')) : null,
        mode === 'story' ? el('div.pick-row', {},
          pick(t('camp.source.generated'), t('camp.source.generated.d'), source === 'generated', () => { source = 'generated'; }),
          pick(t('camp.source.note'), t('camp.source.note.d'), source === 'note', () => { source = 'note'; }),
          pick(t('camp.source.llm'), llmReady ? t('camp.source.llm.d') : t('camp.needsKey'), source === 'llm', () => { source = 'llm'; }, !llmReady),
        ) : null,
        mode === 'story' && source === 'llm' ? field(t('camp.wish'), el('input', {
          value: wish, maxlength: 200, placeholder: t('camp.wish.placeholder'),
          oninput: (e: Event) => { wish = (e.target as HTMLInputElement).value; },
        })) : null,
        el('h3', {}, t('table.rules')),
        el('div.pick-row', {}, RULESET_OPTIONS.map((id) => pick(t(`ruleset.${id}`), t(`camp.ruleset.${id}`), ruleset === id, () => { ruleset = id; }))),
        el('h3', {}, t('camp.players')),
        el('div.pick-row.two', {},
          pick(t('camp.players.local'), t('camp.players.local.d'), !online, () => { online = false; }),
          pick(t('camp.players.online'), t('camp.players.online.d'), online, () => { online = true; localGm = false; }),
        ),
        el('h3', {}, t('camp.gm')),
        el('div.pick-row.two', {},
          pick(t('camp.gm.narrator'), llmReady ? t('camp.gm.narrator.d') : t('camp.needsKey'), narrator, () => { narrator = !narrator; }, !llmReady),
          online
            ? pick(t('camp.gm.friend'), t('camp.gm.friend.online'), false, () => {}, true)
            : pick(t('camp.gm.friend'), t('camp.gm.friend.d'), localGm, () => { localGm = !localGm; }),
        ),
      ),
      el('div.camp-form', {},
        el('h3', {}, t('camp.crewName')),
        el('input', { value: crewName, maxlength: 32, oninput: (e: Event) => { crewName = (e.target as HTMLInputElement).value; } }),
        el('h3', {}, t('camp.create')),
        el('div.pick-row', {},
          pick(t('camp.create.template'), t('camp.create.template.d'), create === 'template', () => { create = 'template'; clearStats(); }),
          pick(t('camp.create.roll'), t('camp.create.roll.d'), create === 'roll', () => { create = 'roll'; rollStats(); }),
          pick(t('camp.create.points'), t('camp.create.points.d'), create === 'points', () => { create = 'points'; clearStats(); }),
        ),
        create === 'roll' ? el('button.btn-quiet.back', { onclick: () => { rollStats(); render(); } }, t('camp.create.reroll')) : null,
        el('h3', {}, t('camp.startingCrew')),
        el('div.camp-starters', {}, crew.map((c, i) => el('div.camp-starter', {},
          roleIcon(c.role),
          el('input', { value: c.name, maxlength: 24, 'aria-label': t('settings.name'), oninput: (e: Event) => { crew[i].name = (e.target as HTMLInputElement).value; } }),
          selectEl<RoleId>(c.role, RECRUITABLE.filter((r) => r !== 'punk').map((r) => ({ value: r, label: t(`role.${r}`) })), (v) => { crew[i].role = v; render(); }),
          el('p.pick-desc', {}, t(`role.${c.role}.d`)),
          create !== 'template' ? el('div.steppers.camp-stat-row', {}, STAT_KEYS.map((k) => {
            const v = c.stats?.[k] ?? 0;
            const change = (d: number) => { c.stats = { ...c.stats, [k]: v + d }; render(); };
            return el('span.stepper', {},
              el('span', {}, `${t(`stat.${k}`)} ${ROLES[c.role].stats[k] + v}`),
              create === 'points' ? el('button', { disabled: v <= -1, onclick: () => change(-1) }, '−') : null,
              create === 'points' ? el('button', { disabled: v >= 2 || pointsLeft(c) <= 0, onclick: () => change(1) }, '+') : null,
            );
          })) : null,
          create === 'points' ? el('p.muted.small.camp-stat-row', {}, t('camp.create.left', { n: pointsLeft(c) })) : null,
        ))),
        el('button.btn-primary.btn-start', { onclick: () => void begin() }, t('camp.begin')),
      ),
    );
    page.scrollTop = scroll;
  };

  const begin = async () => {
    const id = `c${Date.now().toString(36)}`;
    let arc: Arc | null = null;
    let note: string | null = null;
    if (mode === 'story') {
      if (source === 'note') arc = THE_NOTE;
      else if (source === 'llm') {
        ui.screen(el('div.center-page', {}, el('div.card.narrow', {}, el('h2', {}, t('camp.writing')), el('p', {}, t('camp.writing.d')))));
        const result = await writeArc(desktopLlm()!, {
          lang: getLang(), crewName, crew: crew.map((c) => ({ name: c.name, role: t(`role.${c.role}`) })), chronicle: [], wish: wish.trim() || undefined,
        }, `llm-${id}`);
        if ('arc' in result) arc = result.arc;
        else {
          note = t(`camp.llmFail.${result.reason}`);
          arc = generateArc(seed);
        }
      } else arc = generateArc(seed);
    }
    let relay: RelayClient | null = null;
    if (online) {
      relay = new RelayClient(settings.relayUrl);
      try {
        await relay.create(ui.myName());
      } catch (e) {
        relay.close();
        ui.alert(e instanceof RelayError ? ui.relayError(e) : ui.relayError(e));
        return;
      }
    }
    const spec: NewCampaign = {
      id, mode, ruleset, crewName: crewName.trim() || 'Berth 9', seed, hostName: ui.myName(), crew, arc, llm: narrator && llmReady, online, gm: localGm ? 'local' : 'computer',
    };
    run(new CampaignHost(createCampaign(spec), hostOptions(relay)), note);
  };

  ui.screen(page);
  render();
}

export function joinCampaign(relay: RelayClient, first: Extract<HostMsg, { k: 'camp' }>): void {
  run(new CampaignGuest(relay, first));
}

/* ---------- Running a campaign ---------- */

function run(ctl: CampaignController, firstNote: string | null = null): void {
  let view: GameView | null = null;
  let inBattle = false;
  let selected: number | null = null;
  let squadFor: Gig | null = null;
  let squad: number[] = [];
  let hireFor: RoleId | null = null;
  const drafts = { free: '', gm: '', chat: '' };
  let actor: number | null = null;
  const chatLines: string[] = [];
  const notes: string[] = firstNote ? [firstNote] : [];

  const leave = () => {
    ctl.dispose();
    ui.menu();
  };

  ctl.onMission = (session) => {
    view?.dispose();
    inBattle = true;
    squadFor = null;
    view = ui.mountGame(session, {
      toMenu: leave,
      missionOver: () => {
        inBattle = false;
        view = null;
        ctl.leaveMission();
        render();
      },
    });
  };
  ctl.onClosed = (reason) => {
    ctl.dispose();
    ui.alert(t(`net.closed.${reason}`));
  };
  ctl.onChat = (from, text) => {
    chatLines.push(`${from}: ${text}`);
    if (chatLines.length > 40) chatLines.shift();
    if (!inBattle) render();
  };
  ctl.onNotice = (key, name) => {
    notes.push(t(key, { name: name ?? '' }));
    if (notes.length > 3) notes.shift();
    if (!inBattle) render();
  };
  ctl.onChange = () => {
    if (!inBattle) render();
  };

  /* ---------- Small shared pieces ---------- */

  const isGm = () => ctl.state.gmSlot === ctl.mySlot;
  const mayManage = (m: CrewMember) => ctl.mySlot === 0 || m.owner === ctl.mySlot;

  const header = (title: string, sub: string) => {
    const s = ctl.state;
    return el('header.table-head', {},
      back(leave, t('game.menu')),
      el('div.camp-title', {}, el('h2', {}, title), el('span.muted', {}, sub)),
      el('div.camp-stats', {},
        el('div.camp-stat', {}, el('span', {}, t('camp.cash')), el('b', {}, cr(s.cash))),
        el('div.camp-stat', {}, el('span', {}, t('camp.rep')), el('b', {}, s.rep)),
      ),
      ctl.code ? el('div.code-box', {},
        el('span.code-label', {}, t('table.code')),
        el('button.code-big', { title: t('common.copy'), onclick: (e: Event) => { copyText(ctl.code!); (e.currentTarget as HTMLElement).classList.add('copied'); } }, ctl.code),
      ) : null,
    );
  };

  const statusLabel = (m: CrewMember) => t(`camp.status.${m.status}`);

  const transcriptEls = () => ctl.state.transcript.map((l) => el('p.camp-line', { class: `is-${l.kind}${l.ok === false ? ' is-bad' : ''}` }, l.from ? el('b', {}, `${l.from}: `) : null, tx(l.text)));

  const busyLine = () => (ctl.state.busy ? el('p.muted.camp-busy', {}, t('camp.gmThinking')) : null);

  const noteEls = () => notes.map((n) => el('p.form-msg', {}, n));

  const freeBox = () => {
    if (!ctl.hasLlm || isGm()) return null;
    const left = freeLeft(ctl.state);
    if (left <= 0) return el('p.muted.small', {}, t('camp.free.none'));
    const alive = ctl.state.crew.filter((m) => m.status !== 'dead');
    if (actor === null || !alive.some((m) => m.id === actor)) actor = alive[0]?.id ?? null;
    const send = () => {
      const text = drafts.free.trim();
      if (!text || actor === null || ctl.state.busy) return;
      drafts.free = '';
      ctl.dispatch({ a: 'freeAsk', text, actor });
      render();
    };
    return el('div.camp-free', {},
      el('span.camp-free-label', {}, t('camp.free', { n: left })),
      el('div.camp-free-row', {},
        selectEl<number>(actor ?? 0, alive.map((m) => ({ value: m.id, label: m.name })), (v) => { actor = v; }),
        el('input.camp-free-input', {
          value: drafts.free, maxlength: 300, placeholder: t('camp.free.placeholder'), disabled: ctl.state.busy,
          oninput: (e: Event) => { drafts.free = (e.target as HTMLInputElement).value; },
          onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') send(); },
        }),
        el('button.btn-quiet', { disabled: ctl.state.busy, onclick: send }, t('camp.free.go')),
      ),
    );
  };

  const gmBox = () => {
    const gmHere = ctl.state.gmSlot !== null && !ctl.online;
    if (!isGm() && !gmHere) return null;
    const say = () => {
      if (!drafts.gm.trim()) return;
      ctl.dispatch({ a: 'gmSay', text: drafts.gm });
      drafts.gm = '';
      render();
    };
    const events: GmEvent[] = ['ambush', 'tipoff', 'windfall', 'shakedown'];
    return el('div.camp-gm', {},
      el('h3', {}, t('camp.gmPanel')),
      el('div.camp-free-row', {},
        el('input.camp-free-input', {
          value: drafts.gm, maxlength: 600, placeholder: t('camp.gmSay'),
          oninput: (e: Event) => { drafts.gm = (e.target as HTMLInputElement).value; },
          onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') say(); },
        }),
        el('button.btn-quiet', { onclick: say }, t('camp.gmSend')),
      ),
      ctl.state.phase === 'hub' ? el('div.camp-events', {}, events.map((k) => el('button.btn-quiet', {
        disabled: ctl.state.gmEventUsed, title: t(`gmevent.${k}.d`), onclick: () => ctl.dispatch({ a: 'gmEvent', kind: k }),
      }, t(`gmevent.${k}`)))) : null,
    );
  };

  const chatBox = () => {
    if (!ctl.online) return null;
    const send = () => {
      if (!drafts.chat.trim()) return;
      ctl.chat(drafts.chat.trim());
      drafts.chat = '';
      if (!ctl.isHost) render();
    };
    return el('div.camp-chat', {},
      el('div.camp-chat-lines', {}, chatLines.slice(-6).map((l) => el('div', {}, l))),
      el('input.chat-input', {
        value: drafts.chat, maxlength: 200, placeholder: t('game.chatPlaceholder'),
        oninput: (e: Event) => { drafts.chat = (e.target as HTMLInputElement).value; },
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') send(); },
      }),
    );
  };

  /* ---------- Crew panel ---------- */

  const crewRow = (m: CrewMember) => el('button.camp-crew', {
    class: `${selected === m.id ? 'on' : ''} is-${m.status}`,
    onclick: () => { selected = m.id; sfx.click(); render(); },
  },
  roleIcon(m.role),
  el('span.camp-crew-name', {}, el('b', {}, m.name), el('small', {}, `${t(`role.${m.role}`)} · ${t('camp.level', { n: m.level })}${ctl.online ? ` · ${ctl.state.players[m.owner]?.name ?? ''}` : ''}`)),
  m.points > 0 ? el('span.camp-flag', {}, '+') : null,
  m.status !== 'ok' ? el('span.camp-crew-status', {}, statusLabel(m)) : null,
  );

  const hireBox = () => {
    if (isGm()) return null;
    return el('div.camp-hire', {},
      el('h3', {}, t('camp.hire')),
      el('div.recruit', {}, RECRUITABLE.map((r) => el('button.recruit-btn', {
        title: t(`role.${r}.d`), disabled: ctl.state.cash < hireCost(r),
        onclick: () => { sfx.click(); hireFor = r; render(); },
      }, roleIcon(r), el('span', {}, t(`role.${r}`)), el('small', {}, hireCost(r))))),
    );
  };

  const crewDetail = (m: CrewMember) => {
    const can = mayManage(m);
    const stats = statLine(m);
    const hub = ctl.state.phase === 'hub';
    const def = ROLES[m.role];
    const weaponOption = (w: WeaponId | null, current: WeaponId | null) => ({
      value: w ?? '', label: w ? `${t(`weapon.${w}`)}${w !== current && !m.owned.includes(w) && weaponCost(w) ? ` (${cr(weaponCost(w))})` : ''}` : t('squad.none'),
    });
    const stat = (label: string, value: string | number) => el('div.stat', {}, el('span.stat-l', {}, label), el('span.stat-v', {}, value));
    const kinds: GrenadeKind[] = ['frag', 'smoke', 'emp'];
    return el('div.camp-detail', {},
      el('div.camp-detail-head', {},
        roleIcon(m.role),
        can ? el('input.camp-name', {
          value: m.name, maxlength: 24,
          onchange: (e: Event) => ctl.dispatch({ a: 'rename', id: m.id, name: (e.target as HTMLInputElement).value }),
        }) : el('b', {}, m.name),
        el('span.muted', {}, `${t(`role.${m.role}`)} · ${t('camp.level', { n: m.level })} · ${statusLabel(m)}`),
      ),
      el('p.pick-desc', {}, t(`role.${m.role}.d`)),
      el('div.stats', {},
        stat(t('camp.xp'), `${m.xp}/${xpToNext(m)}`),
        stat(t('game.hp'), 10 + stats.grit * 2 + m.bonus.hp),
        stat(t('stat.quick'), stats.quick),
        stat(t('stat.aim'), stats.aim),
        stat(t('stat.grit'), stats.grit),
        stat(t('stat.wire'), stats.wire),
        stat(t('stat.nerve'), stats.nerve),
      ),
      m.points > 0 && can ? el('div.camp-advance', {},
        el('h3', {}, t('camp.advance', { n: m.points })),
        el('div.camp-advances', {}, advancesFor(m.role).map((p: AdvancePick) => el('button.camp-advance-opt', {
          onclick: () => ctl.dispatch({ a: 'advance', id: m.id, pick: p }),
        }, el('b', {}, p === 'hp' ? t('camp.advance.hp') : `${t(`stat.${p}`)} +1`), el('span', {}, t(`advance.${p}.d`))))),
      ) : null,
      m.status === 'wounded' && hub && !isGm() ? el('button.btn-primary', {
        disabled: ctl.state.cash < clinicCost(m), onclick: () => ctl.dispatch({ a: 'clinic', id: m.id }),
      }, t('camp.clinic', { cost: cr(clinicCost(m)) })) : null,
      m.status === 'wounded' ? el('p.muted.small', {}, t('camp.wounded.d')) : null,
      el('p.small', { title: t('camp.humanity.d') }, t('camp.humanity', { n: m.humanity, max: m.humanityMax })),
      m.humanity < m.humanityMax && hub && !isGm() ? el('button.btn-quiet', {
        title: t('camp.humanity.d'), disabled: ctl.state.cash < THERAPY_COST, onclick: () => ctl.dispatch({ a: 'therapy', id: m.id }),
      }, t('camp.therapy', { cost: cr(THERAPY_COST) })) : null,
      ...m.injuries.map((i: InjuryId) => el('button.btn-quiet', {
        disabled: !hub || isGm() || ctl.state.cash < TREAT_COST, onclick: () => ctl.dispatch({ a: 'treat', id: m.id, injury: i }),
      }, t('camp.treat', { injury: t(`injury.${i}`), cost: cr(TREAT_COST) }))),
      el('div.opt-grid', {},
        field(t('squad.ranged'), selectEl<string>(m.ranged ?? '', def.ranged.map((w) => weaponOption(w, m.ranged)), (v) => ctl.dispatch({ a: 'weapon', id: m.id, kind: 'ranged', weapon: (v || null) as WeaponId | null }), { disabled: !can || !hub })),
        field(t('squad.melee'), selectEl<string>(m.melee, def.melee.map((w) => weaponOption(w, m.melee)), (v) => ctl.dispatch({ a: 'weapon', id: m.id, kind: 'melee', weapon: v as WeaponId }), { disabled: !can || !hub })),
      ),
      m.ranged ? el('p.muted.small', {}, `${t(`weapon.${m.ranged}`)}: ${WEAPONS[m.ranged].dice}d6${WEAPONS[m.ranged].bonus ? `+${WEAPONS[m.ranged].bonus}` : ''}`) : null,
      el('h3', {}, t('camp.chrome', { n: m.chrome.length, max: MAX_CHROME })),
      el('div.su-chrome', {}, CHROME_IDS.map((c: ChromeId) => el('button.chip-toggle', {
        class: m.chrome.includes(c) ? 'on' : '', title: t(`chrome.${c}.d`), disabled: !can || !hub || (!m.chrome.includes(c) && (m.chrome.length >= MAX_CHROME || ctl.state.cash < chromeCost(c))),
        onclick: () => ctl.dispatch({ a: 'chrome', id: m.id, chrome: c }),
      }, `${t(`chrome.${c}`)}${m.chrome.includes(c) ? '' : ` ${CHROME_COST[c] * 50}`}`))),
      can && hub && m.chrome.length >= MAX_CHROME ? el('p.muted.small', {}, t('camp.chrome.full')) : null,
      can && hub && m.chrome.length < MAX_CHROME && CHROME_IDS.some((c: ChromeId) => !m.chrome.includes(c) && ctl.state.cash < chromeCost(c)) ? el('p.muted.small', {}, t('camp.chrome.cash')) : null,
      el('h3', {}, t('squad.grenades')),
      el('div.steppers', {}, kinds.filter((k) => k !== 'emp' || ctl.state.ruleset !== 'quick').map((k) => el('span.stepper', {},
        el('span', {}, `${t(`grenade.${k}`)} (${grenadeCost(k)})`),
        el('b', {}, def.grenades[k] + m.extra[k]),
        el('button', { disabled: !can || !hub || m.extra[k] >= 3 || ctl.state.cash < grenadeCost(k), onclick: () => ctl.dispatch({ a: 'grenade', id: m.id, kind: k }) }, '+'),
      ))),
      ctl.online ? el('div.camp-owner', {},
        ctl.isHost
          ? field(t('camp.owner'), selectEl<number>(m.owner, ctl.state.players.flatMap((p, i) => (i === ctl.state.gmSlot ? [] : [{ value: i, label: p.name }])), (v) => ctl.dispatch({ a: 'setOwner', id: m.id, slot: v })))
          : m.owner === 0 && !isGm()
            ? el('button.btn-quiet', { onclick: () => ctl.dispatch({ a: 'setOwner', id: m.id, slot: ctl.mySlot }) }, t('camp.take'))
            : el('span.muted', {}, `${t('camp.owner')}: ${ctl.state.players[m.owner]?.name ?? ''}`),
      ) : null,
      can && hub && ctl.state.crew.filter((x) => x.status !== 'dead').length > 1 ? el('button.btn-quiet.camp-dismiss', { onclick: () => { selected = null; ctl.dispatch({ a: 'dismiss', id: m.id }); } }, t('camp.dismiss')) : null,
    );
  };

  /* ---------- Hub ---------- */

  const gigCard = (g: Gig) => {
    const threat = effectiveThreat(ctl.state, g);
    return el('button.camp-gig', {
      class: g.story ? 'is-story' : '', disabled: isGm(),
      onclick: () => {
        sfx.click();
        squadFor = g;
        squad = ctl.state.crew.filter((m) => m.status === 'ok' && mayManage(m)).slice(0, MAX_SQUAD).map((m) => m.id);
        render();
      },
    },
    el('span.camp-gig-top', {},
      el('b', {}, tx(g.title)),
      g.story ? el('span.camp-tag', {}, t('camp.storyJob')) : null,
      el('span.camp-pay', {}, cr(g.pay)),
    ),
    el('span.pick-desc', {}, tx(g.brief)),
    el('span.camp-gig-meta', {},
      el('span', {}, t(`scenario.${g.scenario}`)),
      el('span', { style: { color: FACTIONS[g.enemy].color } }, t(`faction.${g.enemy}`)),
      el('span', {}, t(`theme.${g.theme}`)),
      el('span', {}, t('camp.threat', { n: threat })),
    ));
  };

  const squadDialog = (g: Gig) => {
    const s = ctl.state;
    const ready = s.crew.filter((m) => m.status === 'ok' && mayManage(m));
    const chosen = ready.filter((m) => squad.includes(m.id));
    const threat = effectiveThreat(s, g);
    return el('div.modal-back', {}, el('div.modal.card.camp-squad', {},
      el('h2', {}, tx(g.title)),
      el('p', {}, tx(g.brief)),
      el('p.muted.small', {}, `${t(`scenario.${g.scenario}.d`)}`),
      el('h3', {}, t('camp.squad', { n: chosen.length, max: MAX_SQUAD })),
      el('div.camp-squad-list', {}, ready.map((m) => el('button.camp-crew', {
        class: squad.includes(m.id) ? 'on' : '',
        disabled: !squad.includes(m.id) && squad.length >= MAX_SQUAD,
        onclick: () => {
          squad = squad.includes(m.id) ? squad.filter((x) => x !== m.id) : [...squad, m.id];
          render();
        },
      }, roleIcon(m.role), el('span.camp-crew-name', {}, el('b', {}, m.name), el('small', {}, `${t(`role.${m.role}`)} · ${t('camp.level', { n: m.level })}`))))),
      !ready.length ? el('p.form-msg', {}, t('camp.squadNone')) : null,
      el('p.muted.small', {}, t('camp.odds', { crew: crewValue(chosen), enemy: enemyPoints(chosen, threat), threat, faction: t(`faction.${g.enemy}`) })),
      s.ruleset === 'full' ? el('p.form-msg', {}, t('camp.fullWarning')) : null,
      el('div.modal-actions', {},
        el('button.btn-primary', {
          disabled: !chosen.length,
          onclick: () => {
            squadFor = null;
            ctl.dispatch({ a: 'takeGig', gig: g.id, squad: chosen.map((m) => m.id) });
            render();
          },
        }, t('camp.go')),
        el('button.btn-quiet', { onclick: () => { squadFor = null; render(); } }, t('common.cancel')),
      ),
    ));
  };

  const hireDialog = (role: RoleId) => {
    const cost = hireCost(role);
    return el('div.modal-back', {}, el('div.modal.card', {},
      el('h2', {}, t('camp.hireConfirm', { role: t(`role.${role}`) })),
      el('p', {}, t(`role.${role}.d`)),
      el('p', {}, t('camp.hireCost', { cost: cr(cost), left: cr(ctl.state.cash - cost) })),
      el('p.muted.small', {}, t('camp.hireNote')),
      el('div.modal-actions', {},
        el('button.btn-primary', {
          disabled: ctl.state.cash < cost,
          onclick: () => {
            hireFor = null;
            ctl.dispatch({ a: 'hire', role, name: pickHandle(randomSeed(), ctl.state.crew.map((x) => x.name)) });
            render();
          },
        }, t('camp.hireYes')),
        el('button.btn-quiet', { onclick: () => { hireFor = null; render(); } }, t('common.cancel')),
      ),
    ));
  };

  const hubPlayers = () => {
    if (!ctl.online) return null;
    const s = ctl.state;
    return el('div.camp-players', {},
      el('h3', {}, t('camp.players')),
      s.players.map((p, i) => el('div.camp-player', { class: p.connected ? '' : 'is-away' },
        el('span', {}, p.name), i === s.gmSlot ? el('span.camp-tag', {}, t('camp.gmTag')) : null, !p.connected ? el('span.muted', {}, t('camp.away')) : null)),
      ctl.isHost ? field(t('camp.gm'), selectEl<number>(s.gmSlot ?? -1, [{ value: -1, label: t('camp.gm.computer') }, ...s.players.map((p, i) => ({ value: i, label: p.name }))], (v) => ctl.dispatch({ a: 'setGm', slot: v < 0 ? null : v }))) : null,
    );
  };

  const hubScreen = () => {
    const s = ctl.state;
    const m = s.crew.find((x) => x.id === selected) ?? s.crew.find((x) => x.status !== 'dead') ?? null;
    if (m) selected = m.id;
    const node = nodeOf(s);
    const title = s.mode === 'endless' ? t('camp.mode.endless') : s.arc ? tx(s.arc.title) : '';
    const sub = s.mode === 'endless' ? t('camp.endlessProgress', { n: s.gigsDone }) : node ? t('camp.chapterOf', { n: node.chapter, of: s.arc?.chapters ?? 0 }) : '';
    return el('div.table-page', {},
      header(s.crewName, `${title}${sub ? ` · ${sub}` : ''}`),
      el('div.camp-cols', {},
        el('section.camp-col', {},
          el('h3', {}, t('camp.crew')),
          s.crew.filter((x) => x.status !== 'dead').map(crewRow),
          hireBox(),
          s.crew.some((x) => x.status === 'dead') ? el('p.muted.small', {}, t('camp.lost', { names: s.crew.filter((x) => x.status === 'dead').map((x) => x.name).join(', ') })) : null,
          hubPlayers(),
        ),
        el('section.camp-col', {},
          noteEls(),
          s.transcript.length ? el('div.camp-transcript', {}, transcriptEls()) : null,
          busyLine(),
          el('h3', {}, t('camp.jobs')),
          availableGigs(s).map(gigCard),
          isGm() ? null : el('button.btn-quiet.camp-rest', {
            title: t('camp.rest.d'), onclick: () => ctl.dispatch({ a: 'rest' }),
          }, t('camp.rest', { cost: cr(Math.min(s.cash, REST_COST)) })),
          freeBox(),
          gmBox(),
          chatBox(),
        ),
        el('section.camp-col', {}, m ? crewDetail(m) : null),
      ),
      squadFor ? squadDialog(squadFor) : null,
      hireFor ? hireDialog(hireFor) : null,
    );
  };

  /* ---------- Scene ---------- */

  const sceneScreen = () => {
    const s = ctl.state;
    const node = nodeOf(s);
    if (node?.kind !== 'scene') return hubScreen();
    const said = s.narration[node.id];
    return el('div.table-page', {},
      header(s.arc ? tx(s.arc.title) : '', t('camp.chapterOf', { n: node.chapter, of: s.arc?.chapters ?? 0 })),
      el('div.camp-scene', {},
        el('div.camp-scene-body', {},
          node.speaker ? el('h3', {}, tx(node.speaker)) : null,
          el('p.camp-scene-text', {}, said ?? tx(node.text)),
          busyLine(),
          s.transcript.length ? el('div.camp-transcript', {}, transcriptEls()) : null,
          noteEls(),
          isGm() ? el('p.muted', {}, t('camp.gmWatching')) : el('div.camp-choices', {}, node.choices.map((c) => el('button.camp-choice', {
            disabled: !choiceAllowed(s, c),
            onclick: () => { sfx.click(); ctl.dispatch({ a: 'choose', choice: c.id }); },
          }, tx(c.label)))),
          isGm() ? null : el('div.camp-events', {}, ROLE_MOVES.filter((r) => s.crew.some((m) => m.role === r && m.status !== 'dead')).map((r) => el('button.btn-quiet', {
            disabled: s.freeUsed.includes(`role:${node.id}`), onclick: () => ctl.dispatch({ a: 'roleMove', role: r }),
          }, t(`rolemove.${r}`)))),
          freeBox(),
          gmBox(),
          chatBox(),
        ),
      ),
    );
  };

  /* ---------- Debrief and endings ---------- */

  const debriefScreen = () => {
    const s = ctl.state;
    const d = s.debrief;
    if (!d) return hubScreen();
    return el('div.table-page', {},
      header(s.crewName, tx(d.title)),
      el('div.camp-scene', {},
        el('div.camp-scene-body', {},
          el('h2', {}, t(d.won ? 'camp.debrief.won' : 'camp.debrief.lost')),
          el('p.camp-scene-text', {}, d.narration ?? tx(d.text)),
          busyLine(),
          el('p', {}, t('camp.debrief.money', { pay: cr(d.pay), rep: d.rep > 0 ? `+${d.rep}` : d.rep })),
          el('table.over-table', {},
            el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, t('over.kills')), el('th', {}, t('over.dealt')), el('th', {}, t('camp.xp')), el('th', {}, t('camp.outcome')))),
            el('tbody', {}, d.lines.map((l) => el('tr', { style: { '--c': 'var(--ink)' } },
              el('td.over-name', {}, l.name), el('td', {}, l.kills), el('td', {}, l.dealt),
              el('td', {}, `+${l.xp}${l.levelUp ? ` · ${t('camp.levelUp')}` : ''}`),
              el('td', {}, t(`camp.status.${l.outcome}`)),
            ))),
          ),
          !d.won && d.story ? el('p.muted', {}, t('camp.debrief.retry')) : null,
          el('div.modal-actions', {}, el('button.btn-primary', { onclick: () => ctl.dispatch({ a: 'closeDebrief' }) }, t('camp.debrief.next'))),
        ),
      ),
    );
  };

  const nextStory = (make: () => Promise<Arc> | Arc) => void ctl.startStory(make);

  const endingScreen = () => {
    const s = ctl.state;
    const wiped = s.phase === 'over';
    const host = ctl as CampaignHost;
    const write = async (): Promise<Arc> => {
      const result = await host.writeStory(`llm-${s.id}-${s.arcsDone}`);
      if ('arc' in result) return result.arc;
      notes.push(t(`camp.llmFail.${result.reason}`));
      return generateArc(randomSeed(), s.used);
    };
    return el('div.table-page', {},
      header(s.crewName, t('camp.storiesDone', { n: s.arcsDone })),
      el('div.camp-scene', {},
        el('div.camp-scene-body', {},
          el('h2', {}, s.ending ? tx(s.ending.title) : ''),
          el('p.camp-scene-text', {}, s.ending ? tx(s.ending.text) : ''),
          busyLine(),
          noteEls(),
          s.chronicle.length ? el('div.camp-chronicle', {},
            el('h3', {}, t('camp.chronicle')),
            s.chronicle.map((c) => el('div', {}, `${tx(c.title)}: ${tx(c.ending)}`)),
          ) : null,
          wiped ? el('div.modal-actions', {},
            el('button.btn-primary', { onclick: () => { deleteCampaign(s.id); leave(); } }, t('over.menu')),
          ) : ctl.isHost ? el('div.camp-choices', {},
            el('h3', {}, t('camp.whatNext')),
            ctl.hasLlm ? el('button.camp-choice', { disabled: s.busy, onclick: () => nextStory(write) }, t('camp.next.llm')) : null,
            el('button.camp-choice', { disabled: s.busy, onclick: () => nextStory(() => generateArc(randomSeed(), s.used)) }, t('camp.next.generated')),
            el('button.camp-choice', { disabled: s.busy, onclick: () => ctl.dispatch({ a: 'toEndless' }) }, t('camp.next.endless')),
            el('button.camp-choice', { onclick: leave }, t('camp.next.stop')),
          ) : el('p.muted', {}, t('camp.waitHost')),
        ),
      ),
    );
  };

  const waitingScreen = () => el('div.center-page', {}, el('div.card.narrow', {}, el('p', {}, t('camp.waitMission'))));

  /* ---------- Rendering ---------- */

  // In a narrow window the columns stack and scroll together, so the whole block has to keep its place too.
  const scrollers = ['.camp-cols', '.camp-col:nth-child(1)', '.camp-col:nth-child(2)', '.camp-col:nth-child(3)', '.camp-scene'];

  function render(): void {
    if (inBattle) return;
    const before = scrollers.map((q) => document.querySelector(q)?.scrollTop ?? 0);
    const focused = document.activeElement as HTMLInputElement | null;
    const focusClass = focused?.tagName === 'INPUT' ? focused.className : null;
    const caret = focusClass ? focused!.selectionStart : null;
    const s = ctl.state;
    let page: HTMLElement;
    switch (s.phase) {
      case 'scene': page = sceneScreen(); break;
      case 'debrief': page = debriefScreen(); break;
      case 'ending':
      case 'over': page = endingScreen(); break;
      case 'mission': page = waitingScreen(); break;
      default: page = hubScreen();
    }
    ui.screen(page);
    scrollers.forEach((q, i) => {
      const node = document.querySelector(q);
      if (node) node.scrollTop = before[i];
    });
    if (focusClass) {
      const again = document.querySelector<HTMLInputElement>(`input.${focusClass.split(' ').join('.')}`);
      if (again) {
        again.focus();
        if (caret !== null) again.setSelectionRange(caret, caret);
      }
    }
  }

  render();
  if (ctl instanceof CampaignHost) ctl.begin();
}
