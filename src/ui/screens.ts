import {
  CHROME_COST, CHROME_IDS, FACTIONS, FACTION_IDS, RECRUITABLE, ROLES, RULESETS, WEAPONS, defaultRoster, makeLoadout, rosterCost, unitCost,
} from '../engine/data';
import { generateMap } from '../engine/map';
import { NEON, glyph } from './boardArt';
import { createPracticeGame, createTutorialGame } from '../engine/tutorial';
import type { ChromeId, FactionId, GrenadeKind, Loadout, RoleId, WeaponId } from '../engine/types';
import { RelayClient, RelayError } from '../net/relayClient';
import {
  GuestTable, HostTable, LocalSession, LocalTable, clearSave, loadSave, resumeHosted, setSaveListener, type GameSession, type TableController,
} from '../net/sessions';
import {
  AI_OPTIONS, POINT_OPTIONS, ROUND_OPTIONS, RULESET_OPTIONS, SCENARIO_OPTIONS, SIZE_OPTIONS, THEME_OPTIONS, newTable, randomSeed, startProblems,
  type Seat, type SeatKind,
} from '../net/table';
import { sfx } from './audio';
import { playMusic, setMusicVolume } from './music';
import { campaignHome, initCampaignScreens, joinCampaign } from './campaign';
import { clear, copyText, el, loadingPage, selectEl } from './dom';
import { duelLesson, duelSetup, initDuelScreens, joinDuel } from './duel';
import { GameView } from './game';
import { getLang, t, type Lang } from './i18n';
import { roleIcon } from './icons';
import { llmStatus, type LlmServerInput } from './llm';
import { DEFAULT_RELAY, saveSettings, settings } from './settings';
import { Coach, PracticeCoach, TutorialSession } from './tutorial';

let root: HTMLElement;
let currentView: GameView | null = null;

/** Stays on screen for as long as saving keeps failing. */
function showSaveState(ok: boolean): void {
  const old = document.querySelector('.save-warning');
  if (ok) old?.remove();
  else if (!old) document.body.append(el('div.save-warning', { role: 'alert' }, t('save.failed')));
}

export function initScreens(r: HTMLElement): void {
  root = r;
  setSaveListener(showSaveState);
  initCampaignScreens({
    screen,
    mountGame: (session, nav) => {
      screen();
      const view = new GameView(root, session, nav);
      currentView = view;
      return view;
    },
    menu: menuScreen,
    alert: alertScreen,
    myName,
    relayError: errorText,
  });
  initDuelScreens({ screen, menu: menuScreen, alert: alertScreen, myName, relayError: errorText });
  menuScreen();
}

/** Runs when the current screen goes away. */
let leaveScreen: (() => void) | null = null;

function screen(...children: (HTMLElement | null)[]): void {
  currentView?.dispose();
  currentView = null;
  leaveScreen?.();
  leaveScreen = null;
  clear(root);
  root.append(...children.filter((c): c is HTMLElement => !!c));
}

const myName = (): string => settings.name.trim() || (getLang() === 'pl' ? 'Gracz' : 'Player');

function errorText(e: unknown): string {
  const code = e instanceof RelayError ? e.code : 'unreachable';
  const known = ['no-room', 'room-full', 'bad-proto', 'rate', 'server-full', 'unreachable'];
  if (known.includes(code)) return t(`net.err.${code}`, { url: settings.relayUrl });
  return t('net.err.other', { code });
}

function backButton(onclick: () => void): HTMLElement {
  return el('button.btn-quiet.back', { onclick: () => { sfx.click(); onclick(); } }, `← ${t('common.back')}`);
}

/* ---------- Main menu ---------- */

/** The title screen: a flooded street at night, drawn once and sized to the window. */
function drawMenuArt(canvas: HTMLCanvasElement): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(320, Math.round(rect.width * dpr));
  const h = Math.max(240, Math.round(rect.height * dpr));
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d')!;
  const u = h / 900;
  let seed = 90210;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const horizon = h * 0.72;

  const sky = c.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#04050c');
  sky.addColorStop(0.45, '#160a10');
  sky.addColorStop(0.78, '#3d0f14');
  sky.addColorStop(1, '#a11d25');
  c.fillStyle = sky;
  c.fillRect(0, 0, w, horizon);
  const glow = c.createRadialGradient(w * 0.68, horizon, 0, w * 0.68, horizon, w * 0.55);
  glow.addColorStop(0, 'rgba(255,110,70,0.75)');
  glow.addColorStop(0.5, 'rgba(240,56,60,0.28)');
  glow.addColorStop(1, 'rgba(240,56,60,0)');
  c.fillStyle = glow;
  c.fillRect(0, 0, w, horizon);

  const neonCanvas = document.createElement('canvas');
  neonCanvas.width = w;
  neonCanvas.height = h;
  const neon = neonCanvas.getContext('2d')!;
  const colors = [NEON.pink, NEON.cyan, NEON.amber, NEON.violet, NEON.cyan, NEON.pink];
  const words = ['SOBA', 'DEBT', 'HOTEL', 'PAWN', 'OYAMA', 'CHROME', 'BAR', '24H', 'SABLE'];

  const layers = [
    { color: '#34153f', min: 0.3, max: 0.56, width: 0.05, windows: 0.05, signs: 0 },
    { color: '#1e1030', min: 0.26, max: 0.62, width: 0.075, windows: 0.06, signs: 0.2 },
    { color: '#0f0b1c', min: 0.2, max: 0.68, width: 0.1, windows: 0.09, signs: 0.5 },
    { color: '#07060f', min: 0.08, max: 0.42, width: 0.15, windows: 0.12, signs: 0.85 },
  ];
  layers.forEach((l, li) => {
    let x = -20 * u;
    while (x < w) {
      const bw = w * l.width * (0.55 + rnd() * 0.9);
      const bh = h * (l.min + rnd() * (l.max - l.min));
      const top = horizon - bh;
      c.fillStyle = l.color;
      c.fillRect(x, top, bw, bh);
      // Rooftop clutter breaks up the skyline.
      if (rnd() < 0.5) c.fillRect(x + bw * (0.2 + rnd() * 0.5), top - h * 0.05 * rnd(), 3 * u, h * 0.05);
      if (rnd() < 0.4) c.fillRect(x + bw * 0.15, top - 12 * u, bw * 0.3, 12 * u);
      const cell = (6 + li * 2) * u;
      for (let yy = top + cell; yy < horizon - cell; yy += cell * 1.7) {
        for (let xx = x + cell * 0.6; xx < x + bw - cell; xx += cell * 1.4) {
          if (rnd() < l.windows) {
            c.fillStyle = pickLight(rnd());
            c.fillRect(xx, yy, cell * 0.7, cell * 0.85);
          }
        }
      }
      if (rnd() < l.signs) {
        const color = colors[Math.floor(rnd() * colors.length)];
        const size = (15 + li * 5) * u;
        if (rnd() < 0.72) {
          // A tall sign in invented script.
          const count = 4 + Math.floor(rnd() * 5);
          const sx = x + bw * (0.2 + rnd() * 0.5);
          const sy = top + bh * (0.1 + rnd() * 0.25);
          const sw = size * 1.5;
          const sh = count * size * 1.45 + size * 0.4;
          c.fillStyle = '#05060c';
          c.fillRect(sx, sy, sw, sh);
          for (const t of [c, neon]) {
            t.strokeStyle = color;
            t.lineWidth = 2.2 * u;
            t.strokeRect(sx, sy, sw, sh);
            t.lineWidth = 2.6 * u;
            for (let i = 0; i < count; i++) glyph(t, sx + size * 0.25, sy + size * 0.35 + i * size * 1.45, size, Math.floor(rnd() * 99999));
          }
        } else {
          const word = words[Math.floor(rnd() * words.length)];
          const fs = size * 1.7;
          for (const t of [c, neon]) {
            t.fillStyle = color;
            t.font = `900 ${fs}px "Big Shoulders Display", sans-serif`;
            t.textAlign = 'left';
            t.textBaseline = 'top';
            t.fillText(word, x + bw * 0.12, top + bh * 0.16, bw * 0.8);
          }
        }
      }
      x += bw + (li > 1 ? w * 0.004 : 0);
    }
  });

  // Traffic in the air: thin streaks with a light at the front.
  for (let i = 0; i < 26; i++) {
    const y = h * (0.14 + rnd() * 0.42);
    const x = rnd() * w;
    const len = (30 + rnd() * 120) * u;
    const col = rnd() < 0.5 ? 'rgba(255,90,90,' : 'rgba(255,235,200,';
    const g = c.createLinearGradient(x, y, x + len, y);
    g.addColorStop(0, `${col}0)`);
    g.addColorStop(1, `${col}0.8)`);
    neon.strokeStyle = g;
    neon.lineWidth = 1.6 * u;
    neon.beginPath();
    neon.moveTo(x, y);
    neon.lineTo(x + len, y);
    neon.stroke();
  }

  // Bloom
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.filter = `blur(${22 * u}px)`;
  c.drawImage(neonCanvas, 0, 0);
  c.filter = `blur(${6 * u}px)`;
  c.globalAlpha = 0.75;
  c.drawImage(neonCanvas, 0, 0);
  c.restore();

  // Smog drifting across the middle distance.
  for (let i = 0; i < 5; i++) {
    const y = h * (0.28 + i * 0.09);
    const g = c.createLinearGradient(0, y - 34 * u, 0, y + 34 * u);
    g.addColorStop(0, 'rgba(255,90,90,0)');
    g.addColorStop(0.5, `rgba(255,90,90,${0.03 + i * 0.012})`);
    g.addColorStop(1, 'rgba(255,90,90,0)');
    c.fillStyle = g;
    c.fillRect(0, y - 34 * u, w, 68 * u);
  }

  // The flooded street mirrors everything above it, broken up by ripples.
  c.save();
  c.translate(0, horizon * 2);
  c.scale(1, -1);
  c.globalAlpha = 0.62;
  c.filter = `blur(${2.5 * u}px)`;
  c.drawImage(canvas, 0, 0, w, horizon, 0, 0, w, horizon);
  c.restore();
  const water = c.createLinearGradient(0, horizon, 0, h);
  water.addColorStop(0, 'rgba(4,6,14,0.15)');
  water.addColorStop(1, 'rgba(4,6,14,0.82)');
  c.fillStyle = water;
  c.fillRect(0, horizon, w, h - horizon);
  c.fillStyle = 'rgba(5,7,14,0.72)';
  for (let i = 0; i < 340; i++) {
    const y = horizon + rnd() ** 1.6 * (h - horizon);
    c.fillRect(rnd() * w, y, w * (0.015 + rnd() * 0.1), (1 + (y - horizon) / (h - horizon) * 2.5) * u);
  }
  c.fillStyle = '#05060c';
  c.fillRect(0, horizon - 2 * u, w, 4 * u);

  // Keep the left side calm, so the menu stays readable.
  const shade = c.createLinearGradient(0, 0, w * 0.62, 0);
  shade.addColorStop(0, 'rgba(3,4,9,0.94)');
  shade.addColorStop(0.55, 'rgba(3,4,9,0.72)');
  shade.addColorStop(1, 'rgba(3,4,9,0)');
  c.fillStyle = shade;
  c.fillRect(0, 0, w, h);
}

function pickLight(v: number): string {
  if (v < 0.55) return 'rgba(255,205,130,0.85)';
  if (v < 0.8) return 'rgba(120,225,255,0.8)';
  return 'rgba(255,120,180,0.8)';
}

/** Rain over the title screen. It stops by itself once the screen is gone. */
function runMenuRain(canvas: HTMLCanvasElement): void {
  const c = canvas.getContext('2d')!;
  const drops = Array.from({ length: 170 }, () => ({ x: Math.random(), y: Math.random(), v: 0.6 + Math.random(), l: 10 + Math.random() * 26 }));
  const step = () => {
    if (!canvas.isConnected) return;
    if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    }
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.strokeStyle = 'rgba(190,220,255,0.16)';
    c.lineWidth = 1;
    c.beginPath();
    for (const d of drops) {
      d.y += 0.016 * d.v;
      d.x -= 0.002 * d.v;
      if (d.y > 1) { d.y = 0; d.x = Math.random() * 1.1; }
      if (d.x < 0) d.x += 1;
      const px = d.x * canvas.width;
      const py = d.y * canvas.height;
      c.moveTo(px, py);
      c.lineTo(px - d.l * 0.13, py + d.l);
    }
    c.stroke();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

declare const __APP_VERSION__: string;

/** Fills in the menu's update entry, if the repo has something newer. It never holds the menu up. */
async function showUpdate(slot: HTMLElement): Promise<void> {
  const d = window.zmDesktop;
  if (!d || !settings.checkUpdates) return;
  const u = await d.updateCheck();
  if (!u.available || !slot.isConnected) return;
  const label = t('update.available', { version: u.latest ?? '' });
  slot.replaceChildren(u.canInstall
    ? el('button.menu-item.menu-update', { onclick: () => updateDialog(u.latest ?? '', u.kind === 'download' ? u.sizeMb ?? 0 : null) }, el('span.menu-title', {}, label), el('span.menu-sub', {}, t('update.install')))
    : el('button.menu-item.menu-update', { onclick: () => window.open(u.page) }, el('span.menu-title', {}, label), el('span.menu-sub', {}, t('update.page'))));
}

/** sizeMb is set when the update is an installer to download, rather than a build from the source. */
function updateDialog(version: string, sizeMb: number | null): void {
  const back = el('div.modal-back', {}, el('div.modal.card', {},
    el('h2', {}, t('update.title', { version })),
    el('p', {}, sizeMb === null ? t('update.explain') : t('update.explainDownload', { version, size: sizeMb })),
    el('div.modal-actions', {},
      el('button.btn-primary', { onclick: () => void runGameUpdate(sizeMb !== null) }, t('update.go')),
      el('button.btn-quiet', { onclick: () => back.remove() }, t('common.cancel')),
    ),
  ));
  root.appendChild(back);
}

async function runGameUpdate(download: boolean): Promise<void> {
  const page = loadingPage(download ? t('update.downloading', { percent: 0 }) : t('update.wait'), t('update.running'));
  screen(page);
  const line = page.querySelector('p');
  window.zmDesktop!.onUpdateProgress?.((percent) => {
    if (line) line.textContent = percent >= 100 ? t('update.installing') : t('update.downloading', { percent });
  });
  const res = await window.zmDesktop!.updateInstall();
  // On success this copy is already closing and the new one is starting.
  if (res.ok) return;
  alertScreen(t('update.failed', { log: res.log }));
}

export function menuScreen(): void {
  playMusic('menu');
  const save = loadSave();
  const art = el('canvas.menu-art') as HTMLCanvasElement;
  const rain = el('canvas.menu-art') as HTMLCanvasElement;
  const item = (title: string, sub: string | null, onclick: (() => void) | null, primary = false) =>
    el('button.menu-item', { class: primary ? 'primary' : '', disabled: !onclick, onclick: onclick ? () => { sfx.click(); onclick(); } : undefined },
      el('span.menu-title', {}, title), sub ? el('span.menu-sub', {}, sub) : null);
  const updateSlot = el('div.menu-update-slot');
  void showUpdate(updateSlot);
  const menu = el('div.menu', {},
    art,
    rain,
    el('div.menu-version', {}, `v${__APP_VERSION__}`),
    el('div.menu-col', {},
      el('div', {}, el('h1.logo', {}, 'ZERO MARGIN'), el('p.tagline', {}, t('app.tagline'))),
      el('nav.menu-list', {},
        save ? item(t('menu.continue'), t('menu.continue.sub', { round: Math.max(1, save.state.round) }), () => continueSave(), true) : null,
        item(t('menu.tutorial'), settings.tutorialDone ? null : t('menu.tutorial.sub'), () => (settings.tutorialDone ? lessonsScreen() : tutorialScreen()), !settings.tutorialDone && !save),
        item(t('menu.skirmish'), null, () => tableScreen(new LocalTable(newTable(myName(), false))), settings.tutorialDone && !save),
        item(t('menu.host'), null, () => hostScreen()),
        item(t('menu.join'), null, () => joinScreen()),
        updateSlot,
        el('div.menu-gap'),
        item(t('menu.campaign'), t('menu.campaign.sub'), () => campaignHome()),
        item(t('menu.duel'), null, () => duelSetup()),
        el('div.menu-row', {},
          item(t('menu.rules'), null, () => rulesScreen()),
          item(t('menu.settings'), null, () => settingsScreen()),
          window.zmDesktop ? item(t('menu.quit'), null, () => window.zmDesktop!.quit()) : null,
        ),
      ),
    ),
  );
  screen(menu);
  const draw = () => {
    if (art.isConnected) drawMenuArt(art);
  };
  void document.fonts.load('900 40px "Big Shoulders Display"').then(draw);
  const observer = new ResizeObserver(draw);
  observer.observe(menu);
  leaveScreen = () => {
    observer.disconnect();
    art.width = 0;
    art.height = 0;
  };
  runMenuRain(rain);
}

/** The three lessons. A first-time player skips this page and goes straight to the basics. */
function lessonsScreen(): void {
  const lesson = (id: string, go: () => void) => el('button.pick-card', { onclick: () => { sfx.click(); go(); } },
    el('span.pick-title', {}, t(`lessons.${id}`)), el('span.pick-desc', {}, t(`lessons.${id}.d`)));
  screen(el('div.center-page.scroll', {}, el('div.card.wide', {},
    backButton(menuScreen),
    el('h2', {}, t('menu.tutorial')),
    el('p.muted', {}, t('lessons.intro')),
    el('div.pick-row.lessons', {},
      lesson('basics', tutorialScreen),
      lesson('practice', practiceScreen),
      lesson('duel', duelLesson),
    ),
  )));
}

function practiceScreen(): void {
  const state = createPracticeGame(randomSeed());
  const session = new TutorialSession(state, [0]);
  session.free = true;
  screen();
  currentView = new GameView(root, session, {
    toMenu: menuScreen,
    retry: practiceScreen,
    rematch: () => tableScreen(new LocalTable(newTable(myName(), false))),
  }, new PracticeCoach(state));
}

function tutorialScreen(): void {
  const session = new TutorialSession(createTutorialGame(), [0]);
  const coach = new Coach(session);
  screen();
  currentView = new GameView(root, session, {
    toMenu: menuScreen,
    retry: tutorialScreen,
    rematch: () => tableScreen(firstGameTable()),
    tutorialDone: () => {
      settings.tutorialDone = true;
      saveSettings();
    },
  }, coach);
}

/** After the tutorial: the same light rules against an easy computer opponent on a small board. */
function firstGameTable(): LocalTable {
  const table = newTable(myName(), false);
  table.settings.ruleset = 'quick';
  table.settings.mapSize = 'small';
  table.seats[1].aiLevel = 'easy';
  return new LocalTable(table);
}

function playSession(session: GameSession, rematch?: () => void): void {
  screen();
  currentView = new GameView(root, session, { toMenu: menuScreen, rematch });
}

async function continueSave(): Promise<void> {
  const save = loadSave();
  if (!save) return menuScreen();
  const humans = save.state.cfg.sides.flatMap((c, i) => (c.control === 'human' ? [i] : []));
  if (!save.online) {
    playSession(new LocalSession(save.state, humans));
    return;
  }
  screen(loadingPage(t('join.connecting')));
  try {
    playSession(await resumeHosted(save, settings.relayUrl, myName()));
  } catch (e) {
    alertScreen(errorText(e));
  }
}

function alertScreen(text: string): void {
  screen(el('div.center-page', {}, el('div.card.narrow', {},
    el('p', {}, text),
    el('div.modal-actions', {}, el('button.btn-primary', { onclick: menuScreen }, t('over.menu'))),
  )));
}

/* ---------- Online entry points ---------- */

async function hostScreen(): Promise<void> {
  screen(loadingPage(t('join.connecting')));
  const relay = new RelayClient(settings.relayUrl);
  try {
    await relay.create(myName());
    tableScreen(new HostTable(newTable(myName(), true), relay, myName()));
  } catch (e) {
    relay.close();
    alertScreen(errorText(e));
  }
}

function joinScreen(): void {
  const code = el('input.code-input', { placeholder: 'ABC123', maxlength: 6, autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const name = el('input', { value: settings.name, maxlength: 24 }) as HTMLInputElement;
  const msg = el('p.form-msg');
  const go = async () => {
    const value = code.value.trim().toUpperCase();
    if (value.length !== 6) {
      code.focus();
      return;
    }
    settings.name = name.value.trim();
    saveSettings();
    msg.textContent = t('join.connecting');
    const relay = new RelayClient(settings.relayUrl);
    try {
      await relay.join(value, myName());
      tableScreen(new GuestTable(relay, value));
    } catch (e) {
      relay.close();
      msg.textContent = errorText(e);
    }
  };
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') void go(); });
  screen(el('div.center-page', {}, el('div.card.narrow', {},
    backButton(menuScreen),
    el('h2', {}, t('join.title')),
    el('label.field', {}, el('span', {}, t('join.code')), code),
    el('label.field', {}, el('span', {}, t('join.name')), name),
    msg,
    el('div.modal-actions', {}, el('button.btn-primary', { onclick: go }, t('join.go'))),
  )));
  code.focus();
}

/* ---------- Table setup ---------- */

function drawMiniMap(canvas: HTMLCanvasElement, ctl: TableController): void {
  const s = ctl.table.settings;
  const sides = ctl.table.seats.filter((x) => x.kind !== 'closed');
  const count = Math.max(2, sides.length);
  const m = generateMap(s.seed, s.mapSize, s.theme, count, s.scenario);
  const scale = Math.min(canvas.width / m.w, canvas.height / m.h);
  const c = canvas.getContext('2d')!;
  c.clearRect(0, 0, canvas.width, canvas.height);
  const ox = (canvas.width - m.w * scale) / 2;
  const oy = (canvas.height - m.h * scale) / 2;
  const colors: Record<string, string> = { '.': '#1a2331', '#': '#55657d', c: '#c98f3f', '~': '#0e4f6b', g: '#19e3ff', T: '#3dffa2' };
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      c.fillStyle = colors[m.tiles[y * m.w + x]] ?? '#1a2331';
      c.fillRect(ox + x * scale, oy + y * scale, scale - 1, scale - 1);
    }
  }
  m.zones.forEach((z, i) => {
    const seat = sides[i];
    c.strokeStyle = seat ? FACTIONS[seat.faction].color : '#888';
    c.lineWidth = 2;
    c.strokeRect(ox + z.x * scale + 1, oy + z.y * scale + 1, z.w * scale - 3, z.h * scale - 3);
  });
  if (m.core) {
    c.fillStyle = '#ffd86b';
    c.fillRect(ox + m.core.x * scale, oy + m.core.y * scale, scale - 1, scale - 1);
  }
}

function tableScreen(ctl: TableController): void {
  ctl.onCampaign = joinCampaign;
  ctl.onDuel = joinDuel;
  ctl.onClosed = (reason) => {
    ctl.dispose();
    alertScreen(t(`net.closed.${reason}`));
  };
  ctl.onStart = (session) => {
    const again = !session.online ? () => {
      ctl.update((tb) => { tb.settings.seed = randomSeed(); });
      tableScreen(ctl);
    } : undefined;
    // Joining someone else's game mustn't cost this player their own saved one.
    if (session.isHost) clearSave();
    playSession(session, again);
  };
  const render = () => {
    // Every change rebuilds this screen, so keep each scrolling area where the player left it.
    const scrollers = ['.table-cols', '.seats', '.options'];
    const scrolled = scrollers.map((q) => root.querySelector(q)?.scrollTop ?? 0);
    const tb = ctl.table;
    const set = tb.settings;
    const edit = ctl.isHost;
    const choice = (id: string, group: string, on: boolean, pick: () => void) => el('button.pick-card', {
      class: on ? 'on' : '', disabled: !edit, onclick: () => { sfx.click(); pick(); },
    }, el('span.pick-title', {}, t(`${group}.${id}`)), el('span.pick-desc', {}, t(`${group}.${id}.d`)));

    const mini = el('canvas.mini-map', { width: 300, height: 210 }) as HTMLCanvasElement;
    drawMiniMap(mini, ctl);

    const problems = startProblems(tb);
    const mySeat = ctl.me ? tb.seats.find((x) => x.peer === ctl.me) : null;

    screen(el('div.table-page', {},
      el('header.table-head', {},
        backButton(() => { ctl.dispose(); menuScreen(); }),
        el('h2', {}, t(ctl.online ? 'table.titleOnline' : 'table.title')),
        tb.code ? el('div.code-box', {},
          el('span.code-label', {}, t('table.code')),
          el('button.code-big', {
            title: t('common.copy'),
            onclick: (e: Event) => {
              copyText(tb.code!);
              (e.currentTarget as HTMLElement).classList.add('copied');
            },
          }, tb.code),
          el('span.code-hint', {}, t('table.codeHint')),
        ) : null,
      ),
      el('div.table-cols', {},
        el('section.seats', {},
          el('h3', {}, t('table.seats')),
          tb.seats.map((seat, i) => seatCard(ctl, seat, i)),
        ),
        el('section.options', {},
          el('h3', {}, t('table.rules')),
          el('div.pick-row', {}, RULESET_OPTIONS.map((id) => choice(id, 'ruleset', set.ruleset === id, () => ctl.update((x) => {
            x.settings.ruleset = id;
          })))),
          el('h3', {}, t('table.scenario')),
          el('div.pick-row', {}, SCENARIO_OPTIONS.map((id) => choice(id, 'scenario', set.scenario === id, () => ctl.update((x) => {
            x.settings.scenario = id;
          })))),
          el('h3', {}, t('table.board')),
          el('div.board-opts', {},
            el('div.opt-grid', {},
              field(t('table.board'), selectEl(set.theme, THEME_OPTIONS.map((v) => ({ value: v, label: t(`theme.${v}`) })), (v) => ctl.update((x) => { x.settings.theme = v; }), { disabled: !edit })),
              field(t('table.size'), selectEl(set.mapSize, SIZE_OPTIONS.map((v) => ({ value: v, label: t(`size.${v}`) })), (v) => ctl.update((x) => { x.settings.mapSize = v; }), { disabled: !edit })),
              field(t('table.points'), selectEl(set.points, POINT_OPTIONS.map((v) => ({ value: v, label: `${v}` })), (v) => ctl.update((x) => {
                x.settings.points = v;
                for (const s of x.seats) if (rosterCost(s.faction, s.roster) > v) s.roster = defaultRoster(s.faction, v);
              }), { disabled: !edit })),
              field(t('table.rounds'), selectEl(set.maxRounds, ROUND_OPTIONS.map((v) => ({ value: v, label: `${v}` })), (v) => ctl.update((x) => { x.settings.maxRounds = v; }), { disabled: !edit })),
            ),
            el('div.mini-wrap', {}, mini, edit ? el('button.btn-quiet.reroll', { title: '#', onclick: () => ctl.update((x) => { x.settings.seed = randomSeed(); }) }, `⟳ #${set.seed % 10000}`) : null),
          ),
        ),
      ),
      el('footer.table-foot', {},
        el('div.problems', {}, problems.map((p) => el('div', {}, t(p)))),
        ctl.isHost
          ? el('button.btn-primary.btn-start', { disabled: problems.length > 0, onclick: () => ctl.start() }, t('table.start'))
          : el('div.foot-guest', {},
            mySeat ? el('button.btn-primary', { class: mySeat.ready ? 'is-ready' : '', onclick: () => ctl.updateMine({ ready: !mySeat.ready }) }, mySeat.ready ? `✓ ${t('table.ready')}` : t('table.ready')) : null,
            el('span.muted', {}, t('net.waitingHost'))),
      ),
    ));
    scrollers.forEach((q, i) => {
      const node = root.querySelector(q);
      if (node) node.scrollTop = scrolled[i];
    });
  };
  ctl.onChange = render;
  render();
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el('label.field', {}, el('span', {}, label), control);
}

function seatCard(ctl: TableController, seat: Seat, index: number): HTMLElement {
  const tb = ctl.table;
  const mine = ctl.me !== null && seat.peer === ctl.me;
  const hostOwned = ctl.isHost && !seat.peer;
  const editable = mine || hostOwned;
  const color = FACTIONS[seat.faction].color;

  const setFaction = (f: FactionId) => {
    const roster = defaultRoster(f, tb.settings.points);
    if (mine) ctl.updateMine({ faction: f, roster });
    else ctl.update((x) => { Object.assign(x.seats[index], { faction: f, roster }); });
  };
  const setTeam = (team: number) => {
    if (mine) ctl.updateMine({ team });
    else ctl.update((x) => { x.seats[index].team = team; });
  };

  let kindControl: HTMLElement;
  if (ctl.isHost) {
    const kinds: SeatKind[] = ctl.online ? ['human', 'ai', 'open', 'closed'] : ['human', 'ai', 'closed'];
    const opts: { value: string; label: string }[] = kinds.map((k) => ({ value: k, label: t(`table.kind.${k}`) }));
    if (seat.peer) opts.unshift({ value: 'friend', label: `${t('table.kind.friend')}: ${seat.name}` });
    kindControl = selectEl<string>(seat.peer ? 'friend' : seat.kind, opts, (v) => {
      if (v === 'friend') return;
      ctl.update((x) => {
        const s = x.seats[index];
        s.kind = v as SeatKind;
        s.peer = null;
        s.ready = v !== 'open';
        s.name = v === 'human' ? (x.seats.some((o, i) => i !== index && o.kind === 'human' && !o.peer) ? `${getLang() === 'pl' ? 'Gracz' : 'Player'} ${index + 1}` : myName()) : '';
      });
    });
  } else if (seat.kind === 'open') {
    kindControl = el('button.btn-quiet', { onclick: () => ctl.claim(index) }, t('table.takeSeat'));
  } else {
    kindControl = el('span.seat-kind', {}, mine ? t('table.you') : seat.kind === 'human' ? seat.name : t(`table.kind.${seat.kind}`));
  }

  if (seat.kind === 'closed') {
    return el('div.seat.closed', { style: { '--c': '#3a3d46' } }, el('div.seat-top', {}, el('span.seat-n', {}, index + 1), kindControl));
  }
  if (seat.kind === 'open' && ctl.isHost) {
    return el('div.seat.open', { style: { '--c': color } }, el('div.seat-top', {}, el('span.seat-n', {}, index + 1), kindControl), el('div.seat-wait', {}, t('table.waiting')));
  }

  const cost = rosterCost(seat.faction, seat.roster);
  return el('div.seat', { style: { '--c': color } },
    el('div.seat-top', {},
      el('span.seat-n', {}, index + 1),
      kindControl,
      seat.peer ? el('span.seat-ready', { class: seat.ready ? 'yes' : '' }, seat.ready ? `✓ ${t('table.ready')}` : t('table.notReady')) : null,
    ),
    seat.kind === 'human' && hostOwned && !ctl.online ? el('input.seat-name', {
      value: seat.name, maxlength: 24, 'aria-label': t('settings.name'),
      onchange: (e: Event) => ctl.update((x) => { x.seats[index].name = (e.target as HTMLInputElement).value.trim().slice(0, 24); }),
    }) : null,
    el('div.seat-row', {},
      selectEl(seat.faction, FACTION_IDS.map((v) => ({ value: v, label: t(`faction.${v}`) })), setFaction, { disabled: !editable }),
      el('label.seat-team', {}, el('span', {}, t('table.team')), selectEl(seat.team, [0, 1, 2, 3].map((v) => ({ value: v, label: `${v + 1}` })), setTeam, { disabled: !editable })),
      seat.kind === 'ai' ? selectEl(seat.aiLevel, AI_OPTIONS.map((v) => ({ value: v, label: t(`table.ai.${v}`) })), (v) => ctl.update((x) => { x.seats[index].aiLevel = v; }), { disabled: !ctl.isHost }) : null,
    ),
    el('p.seat-desc', {}, t(`faction.${seat.faction}.d`)),
    el('div.seat-squad', {},
      el('div.squad-icons', {}, seat.roster.map((l) => roleIcon(l.role))),
      el('span.squad-info', {}, t('table.squadInfo', { n: seat.roster.length, cost, points: tb.settings.points })),
      editable ? el('button.btn-quiet', { onclick: () => squadDialog(ctl, seat, index, mine) }, t('table.squad')) : null,
    ),
  );
}

/* ---------- Squad builder ---------- */

function squadDialog(ctl: TableController, seat: Seat, index: number, mine: boolean): void {
  let roster: Loadout[] = structuredClone(seat.roster);
  const points = ctl.table.settings.points;
  const rules = RULESETS[ctl.table.settings.ruleset];
  const faction = seat.faction;
  const body = el('div.squad-body');
  const budget = el('div.budget');

  const save = () => {
    if (mine) ctl.updateMine({ roster });
    else ctl.update((x) => { x.seats[index].roster = roster; });
  };

  const render = () => {
    const cost = rosterCost(faction, roster);
    const over = cost > points;
    budget.replaceChildren(
      el('div.budget-text', { class: over ? 'over' : '' }, over ? t('squad.over', { n: cost - points }) : t('squad.budget', { cost, points })),
      el('div.budget-bar', {}, el('div.budget-fill', { class: over ? 'over' : '', style: { width: `${Math.min(100, (cost / points) * 100)}%` } })),
    );
    const units = roster.map((l, i) => {
      const role = ROLES[l.role];
      const gun = selectEl<string>(l.ranged ?? '', role.ranged.map((w) => ({
        value: w ?? '', label: w ? `${t(`weapon.${w}`)}${WEAPONS[w].cost ? ` (+${WEAPONS[w].cost})` : ''}` : t('squad.none'),
      })), (v) => { l.ranged = (v || null) as WeaponId | null; render(); });
      const blade = selectEl<string>(l.melee, role.melee.map((w) => ({
        value: w, label: `${t(`weapon.${w}`)}${WEAPONS[w].cost ? ` (+${WEAPONS[w].cost})` : ''}`,
      })), (v) => { l.melee = v as WeaponId; render(); });
      const toggleChrome = (c: ChromeId) => {
        l.chrome = l.chrome.includes(c) ? l.chrome.filter((x) => x !== c) : [...l.chrome, c];
        render();
      };
      const grenadeKinds: GrenadeKind[] = rules.emp ? ['frag', 'smoke', 'emp'] : ['frag', 'smoke'];
      const stepper = (k: GrenadeKind) => el('span.stepper', {},
        el('span', {}, t(`grenade.${k}`)),
        el('button', { disabled: l.extra[k] <= 0, onclick: () => { l.extra[k] -= 1; render(); } }, '−'),
        el('b', {}, l.extra[k]),
        el('button', { disabled: l.extra[k] >= 3, onclick: () => { l.extra[k] += 1; render(); } }, '+'),
      );
      return el('div.squad-unit', {},
        el('div.su-head', {},
          roleIcon(l.role),
          el('div.su-title', {}, el('b', {}, t(`role.${l.role}`)), el('span', {}, t(`role.${l.role}.d`))),
          el('span.su-cost', {}, `${unitCost(faction, l)} ${t('common.points')}`),
          el('button.btn-quiet', { onclick: () => { roster.splice(i, 1); render(); } }, t('squad.remove')),
        ),
        el('div.su-gear', {},
          field(t('squad.ranged'), gun),
          field(t('squad.melee'), blade),
          el('div.field', {}, el('span', {}, t('squad.grenades')), el('div.steppers', {}, grenadeKinds.map(stepper))),
        ),
        el('div.su-chrome', {}, CHROME_IDS.map((c) => el('button.chip-toggle', {
          class: l.chrome.includes(c) ? 'on' : '', title: t(`chrome.${c}.d`), onclick: () => toggleChrome(c),
        }, `${t(`chrome.${c}`)} ${Math.max(1, CHROME_COST[c] - (faction === 'choir' ? 1 : 0))}`))),
      );
    });
    body.replaceChildren(
      units.length ? el('div.su-list', {}, units) : el('p.muted', {}, t('squad.empty')),
      el('h3', {}, t('squad.recruit')),
      el('div.recruit', {}, RECRUITABLE.map((r: RoleId) => el('button.recruit-btn', {
        title: t(`role.${r}.d`),
        disabled: roster.length >= 10,
        onclick: () => {
          const role = ROLES[r];
          roster.push(makeLoadout(r, role.ranged[0], role.melee[0]));
          render();
        },
      }, roleIcon(r), el('span', {}, t(`role.${r}`)), el('small', {}, ROLES[r].cost - (faction === 'kilnrats' && r === 'punk' ? 2 : 0))))),
    );
  };

  const back = el('div.modal-back', {}, el('div.modal.card.squad-modal', {},
    el('div.squad-head', { style: { '--c': FACTIONS[faction].color } },
      el('h2', {}, t('squad.title', { faction: t(`faction.${faction}`) })),
      budget,
    ),
    body,
    el('div.modal-actions', {},
      el('button.btn-primary', {
        onclick: () => {
          if (rosterCost(faction, roster) > points) return;
          save();
          back.remove();
        },
      }, t('squad.done')),
      el('button.btn-quiet', { onclick: () => { roster = defaultRoster(faction, points); render(); } }, t('squad.default')),
      el('button.btn-quiet', { onclick: () => back.remove() }, t('common.cancel')),
    ),
  ));
  root.appendChild(back);
  render();
}

/* ---------- Settings and rules ---------- */

function settingsScreen(): void {
  const langs: { value: Lang; label: string }[] = [{ value: 'en', label: 'English' }, { value: 'pl', label: 'Polski' }];
  const speeds = (['slow', 'normal', 'fast'] as const).map((v) => ({ value: v, label: t(`settings.speed.${v}`) }));
  const name = el('input', { value: settings.name, maxlength: 24, onchange: (e: Event) => { settings.name = (e.target as HTMLInputElement).value.trim(); saveSettings(); } });
  const relay = el('input', {
    value: settings.relayUrl, spellcheck: 'false',
    onchange: (e: Event) => { settings.relayUrl = (e.target as HTMLInputElement).value.trim() || DEFAULT_RELAY; saveSettings(); },
  });
  screen(el('div.center-page.scroll', {}, el('div.card.narrow', {},
    backButton(menuScreen),
    el('h2', {}, t('settings.title')),
    field(t('settings.language'), selectEl(settings.lang, langs, (v) => { settings.lang = v; saveSettings(); settingsScreen(); })),
    field(t('settings.name'), name),
    field(t('settings.volume'), el('input', {
      type: 'range', min: 0, max: 1, step: 0.05, value: String(settings.volume),
      onchange: (e: Event) => { settings.volume = Number((e.target as HTMLInputElement).value); saveSettings(); sfx.turn(); },
    })),
    field(t('settings.music'), el('input', {
      type: 'range', min: 0, max: 1, step: 0.05, value: String(settings.music),
      oninput: (e: Event) => { settings.music = Number((e.target as HTMLInputElement).value); setMusicVolume(settings.music); },
      onchange: () => saveSettings(),
    })),
    field(t('settings.speed'), selectEl(settings.speed, speeds, (v) => { settings.speed = v; saveSettings(); })),
    field(t('update.setting'), selectEl(settings.checkUpdates ? 'on' : 'off', [{ value: 'on', label: t('settings.on') }, { value: 'off', label: t('settings.off') }], (v) => { settings.checkUpdates = v === 'on'; saveSettings(); })),
    field(t('settings.rain'), selectEl(settings.rain ? 'on' : 'off', [{ value: 'on', label: t('settings.on') }, { value: 'off', label: t('settings.off') }], (v) => { settings.rain = v === 'on'; saveSettings(); })),
    field(t('settings.relay'), relay),
    el('p.muted.small', {}, t('settings.relayHint')),
    gmSettings(),
  )));
}

/** The optional language-model game master: any OpenAI-compatible servers, with keys the page never sees again. */
function gmSettings(): HTMLElement {
  const box = el('div.gm-settings');
  const msg = el('p.form-msg');
  const FALLBACK_OPTIONS = [0, 1, 3];
  let drafts: (LlmServerInput & { hasKey: boolean })[] | null = null;
  let fallbacks = 0;

  const render = async () => {
    const status = await llmStatus();
    if (!status.desktop) {
      box.replaceChildren(el('h3', {}, t('gm.title')), el('p.muted.small', {}, t('gm.desktopOnly')));
      return;
    }
    if (!drafts) {
      drafts = status.servers.map((s) => ({ endpoint: s.endpoint, key: '', writer: s.writer, runner: s.runner, hasKey: s.hasKey }));
      fallbacks = FALLBACK_OPTIONS.find((n) => n >= drafts!.length - 1) ?? 3;
    }
    while (drafts.length < 1 + fallbacks) drafts.push({ endpoint: '', key: '', writer: '', runner: '', hasKey: false });
    const list = drafts;
    const save = async () => {
      const res = await window.zmDesktop!.llmConfigure(list.slice(0, 1 + fallbacks).map(({ endpoint, key, writer, runner }) => ({ endpoint, key, writer, runner })));
      if (!res.ok) {
        msg.textContent = t('gm.badEndpoint', { server: serverName(res.badServer ?? 0) });
        return;
      }
      drafts = null;
      await render();
      msg.textContent = res.saved ? t('gm.saved') : t('gm.notSaved');
    };
    const serverName = (i: number) => (i === 0 ? t('gm.server.main') : t('gm.server.fallback', { n: i }));
    const input = (label: string, value: string, set: (v: string) => void, attrs: Record<string, string> = {}) => field(label, el('input', {
      value, spellcheck: 'false', autocomplete: 'off', ...attrs, oninput: (e: Event) => set((e.target as HTMLInputElement).value),
    }));
    box.replaceChildren(
      el('h3', {}, t('gm.title')),
      el('p.muted.small', {}, t('gm.intro')),
      field(t('gm.enable'), selectEl(settings.gmEnabled ? 'on' : 'off', [{ value: 'on', label: t('settings.on') }, { value: 'off', label: t('settings.off') }], (v) => { settings.gmEnabled = v === 'on'; saveSettings(); })),
      field(t('gm.fallbacks'), selectEl<number>(fallbacks, FALLBACK_OPTIONS.map((n) => ({ value: n, label: n === 0 ? t('gm.fallbacks.none') : String(n) })), (v) => { fallbacks = v; void render(); })),
      ...list.slice(0, 1 + fallbacks).map((d, i) => el('div.gm-server', {},
        el('h3', {}, serverName(i)),
        input(t('gm.endpoint'), d.endpoint, (v) => { d.endpoint = v; }, { placeholder: 'https://api.example.com/v1' }),
        input(t('gm.key'), d.key, (v) => { d.key = v; }, { type: 'password', placeholder: d.hasKey ? t('gm.keySaved') : t('gm.keyPlaceholder') }),
        input(t('gm.writer'), d.writer, (v) => { d.writer = v; }),
        input(t('gm.runner'), d.runner, (v) => { d.runner = v; }),
      )),
      el('p.muted.small', {}, t('gm.keyHint')),
      el('div.modal-actions.tight', {},
        el('button.btn-quiet', { onclick: save }, t('gm.save')),
        status.servers.some((s) => s.endpoint) ? el('button.btn-quiet', {
          onclick: async () => {
            msg.textContent = t('gm.testing');
            const results = await window.zmDesktop!.llmTest();
            msg.textContent = results.flatMap((r, i) => (r ? [`${serverName(i)}: ${r.ok ? t('gm.testOk') : t(`gm.fail.${r.reason}`)}`] : [])).join(' ');
          },
        }, t('gm.test')) : null,
      ),
      msg,
      el('p.muted.small', {}, t('gm.terms')),
    );
  };
  void render();
  return box;
}

function rulesScreen(): void {
  const blocks = ['goal', 'turn', 'actions', 'dice', 'cover', 'depth', 'wounds', 'luck', 'net', 'campaign', 'humanity', 'duel', 'keys'];
  screen(el('div.center-page.scroll', {}, el('div.card.wide', {},
    backButton(menuScreen),
    el('h2', {}, t('rules.title')),
    el('button.btn-primary.rules-tutorial', { onclick: () => lessonsScreen() }, t('menu.tutorial')),
    blocks.map((b) => el('section.rule-block', {}, el('h3', {}, t(`rules.${b}.h`)), el('p', {}, t(`rules.${b}`)))),
  )));
}

export const debugView = (): GameView | null => currentView;
