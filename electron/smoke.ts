import { app, type BrowserWindow } from 'electron';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/*
 * Checks a packaged build on a real machine. It only runs when ZM_SMOKE_TEST=1 is set.
 *   ZM_SMOKE_SHOW=1    show the window (a hidden window never draws)
 *   ZM_SMOKE_OUT=path  also append results to this file
 *   ZM_SMOKE_HOLD=ms   keep the window open afterwards, for screenshots
 *   ZM_SMOKE_ONLINE=1  host a real online table and play to round 3 with whoever joins
 *   ZM_SMOKE_CAMPAIGN=1  play a campaign start to finish of one job, against a pretend Gemini
 *   ZM_SMOKE_SHOTS=dir   save screenshots of the campaign screens there
 * Every run uses a throwaway profile, so it can't touch real settings or saves.
 */

/** What a pretend Gemini answers in the campaign check, so the whole path runs without a key or any network. */
export function fakeGemini(req: { system: string; json: boolean }): { ok: true; text: string } {
  if (req.system.includes('campaign outlines')) {
    const chapter = (n: number) => ({
      speaker: 'Clerk Oda',
      scene: `Chapter ${n}. Oda stands in the rain on Kiln Street with the harbor books under one arm, and asks the crew to keep them dry until morning.`,
      choices: [{ label: 'Keep the books', result: 'Oda nods and leaves.', flag: 'kept', cash: 200, threat: 0 }, { label: 'Refuse', result: 'Oda swears at you.', cash: 0, threat: 1 }],
      fight: { title: 'Dry Books', brief: 'Hold the terminals on the docks.', scenario: 'terminals', enemy: 'kilnrats', theme: 'docks', won: 'The books stayed dry.', lost: 'The books got wet, but there is time.' },
    });
    return { ok: true, text: JSON.stringify({
      title: 'The Dry Books', premise: 'A clerk needs a favor.', bible: 'Oda is scared.', chapters: [chapter(1), chapter(2)],
      endings: [{ flag: 'kept', title: 'Kept', text: 'The books survived the night.' }, { flag: '', title: 'Lost', text: 'The books did not survive the night.' }],
    }) };
  }
  if (req.json) return { ok: true, text: '{"stat":"nerve","tn":10,"reply":"You try it."}' };
  return { ok: true, text: 'NARRATED: rain runs down the shutters while the crew waits, and nobody says what everyone is thinking.' };
}

const LOCAL_CHECK = `
  (async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await document.fonts.ready;
    await wait(400);
    const menuItems = document.querySelectorAll('.menu-item').length;
    const menu = (re) => [...document.querySelectorAll('.menu-item')].find((b) => re.test(b.textContent));
    menu(/Tutorial|Samouczek/).click();
    await wait(600);
    const tutorialOpens = !!document.querySelector('.coach h3') && !!document.querySelector('.board-canvas');
    [...document.querySelectorAll('.topbar button')].pop().click();
    await wait(150);
    [...document.querySelectorAll('.modal button')].pop().click();
    await wait(300);
    menu(/New skirmish|Nowa potyczka/).click();
    await wait(300);
    document.querySelector('.btn-start')?.click();
    await wait(800);
    let frames = 0;
    const count = () => { frames += 1; requestAnimationFrame(count); };
    requestAnimationFrame(count);
    await wait(2000);
    const firstFrames = frames / 2;
    await wait(4000);
    const before = frames;
    await wait(3000);
    const settledFps = (frames - before) / 3;
    const canvas = document.querySelector('.board-canvas');
    const pixel = canvas ? canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[3] : 0;
    return {
      title: document.title, menuItems, tutorialOpens, desktop: !!window.zmDesktop, inGame: !!document.querySelector('.game'),
      boardDrawn: pixel > 0, displayFont: document.fonts.check('800 16px "Big Shoulders Display"'), monoFont: document.fonts.check('16px "IBM Plex Mono"'),
      framesPerSecond: firstFrames, settledFps, language: navigator.language, screen: innerWidth + 'x' + innerHeight, platform: navigator.platform,
      passed: !!document.querySelector('.game') && pixel > 0 && tutorialOpens,
    };
  })()
`;

const ONLINE_CHECK = `
  (async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const say = (m) => console.log('ZMLOG ' + m);
    await document.fonts.ready;
    await wait(400);
    [...document.querySelectorAll('.menu-item')].find((b) => /Host online|Załóż stół/.test(b.textContent)).click();
    for (let i = 0; i < 80 && !document.querySelector('.code-big'); i++) await wait(250);
    const code = document.querySelector('.code-big')?.textContent;
    if (!code) return { passed: false, stage: 'no join code', page: document.body.innerText.slice(0, 200) };
    say('CODE ' + code);
    for (let i = 0; i < 720 && !document.querySelector('.seat-ready.yes'); i++) await wait(250);
    if (!document.querySelector('.seat-ready.yes')) return { passed: false, stage: 'nobody joined', code };
    say('friend is ready');
    await wait(300);
    document.querySelector('.btn-start').click();
    for (let i = 0; i < 40 && !document.querySelector('.game'); i++) await wait(250);
    const chat = document.querySelector('.chat-input');
    chat.value = 'hello from windows';
    chat.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const started = Date.now();
    let activations = 0;
    while (Date.now() - started < 240000) {
      const m = (document.querySelector('.top-round')?.textContent || '').match(/(\\d+)\\//);
      if (m && Number(m[1]) >= 3) break;
      if (document.querySelector('.over')) break;
      const ready = document.querySelector('.actions .btn-primary');
      const end = document.querySelector('.act-end');
      const can = document.querySelector('.unit-row.can');
      if (ready) ready.click();
      else if (end) end.click();
      else if (can) { can.click(); activations += 1; }
      await wait(350);
    }
    await wait(4000);
    let frames = 0;
    const count = () => { frames += 1; requestAnimationFrame(count); };
    requestAnimationFrame(count);
    await wait(2000);
    return {
      passed: true, code, activations, framesPerSecond: frames / 2,
      round: document.querySelector('.top-round')?.textContent,
      scores: [...document.querySelectorAll('.score')].map((e) => e.innerText.replace(/\\s+/g, ' ')),
      units: [...document.querySelectorAll('.unit-row')].map((e) => e.textContent),
      chat: [...document.querySelectorAll('.log-chat')].map((e) => e.textContent),
      lastLog: [...document.querySelectorAll('.log-line')].slice(-3).map((e) => e.textContent),
    };
  })()
`;

const CAMPAIGN_CHECK = `
  (async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const say = (m) => console.log('ZMLOG ' + m);
    const shot = async (name) => { say('SHOT ' + name); await wait(500); };
    const until = async (test, ms = 15000) => { const end = Date.now() + ms; while (!test() && Date.now() < end) await wait(100); return !!test(); };
    const button = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent));
    const fail = (stage) => ({ passed: false, stage, page: document.body.innerText.slice(0, 400) });
    try {
    await document.fonts.ready;
    await wait(400);
    button(/Story campaign|Kampania fabularna/).click();
    await wait(200);
    button(/New campaign|Nowa kampania/).click();
    await until(() => button(/^Begin$|^Zacznij$/));
    await wait(300);
    await shot('new');
    button(/^Begin$|^Zacznij$/).click();
    if (!await until(() => document.querySelector('.camp-scene-text'), 20000)) return fail('story never appeared');
    const title = document.querySelector('.camp-title h2').textContent;
    if (!await until(() => document.querySelector('.camp-scene-text').textContent.startsWith('NARRATED'))) return fail('scene was not narrated');
    await shot('scene');
    const input = document.querySelector('.camp-free-input');
    if (!input) return fail('no free action box');
    input.value = 'I talk the clerk out of the books';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    button(/^Try it$|^Spróbuj$/).click();
    if (!await until(() => document.querySelector('.camp-line.is-narration'))) return fail('free action did not resolve');
    const lines = [...document.querySelectorAll('.camp-line')].map((e) => e.textContent);
    await shot('free');
    document.querySelector('.camp-choice').click();
    if (!await until(() => document.querySelector('.camp-gig.is-story'))) return fail('hub did not open');
    await shot('hub');
    document.querySelector('.camp-gig.is-story').click();
    await wait(200);
    await shot('squad');
    button(/Start the job|Zacznij robotę/).click();
    if (!await until(() => document.querySelector('.game'))) return fail('battle did not start');
    await wait(1500);
    const crewInBattle = [...document.querySelectorAll('.unit-row .unit-name')].map((e) => e.textContent);
    for (let i = 0; i < 40; i++) {
      if (/[2-9][/]/.test(document.querySelector('.top-round')?.textContent || '')) break;
      const ready = document.querySelector('.actions .btn-primary');
      const end = document.querySelector('.act-end');
      const can = document.querySelector('.unit-row.can');
      if (ready) ready.click();
      else if (end) end.click();
      else if (can) can.click();
      await wait(400);
    }
    await shot('battle');
    if (!await until(() => document.querySelector('.unit-row.can') || document.querySelector('.act-end'), 30000)) return fail('no turn came back');
    [...document.querySelectorAll('.topbar button')].pop().click();
    await wait(200);
    const concede = button(/^Concede$|^Poddaj się$/);
    if (!concede) return fail('no concede button');
    concede.click();
    if (!await until(() => document.querySelector('.over'), 20000)) return fail('battle did not end');
    button(/^Continue$|^Dalej$/).click();
    if (!await until(() => document.querySelector('.camp-scene-text')?.textContent.startsWith('NARRATED'))) return fail('debrief was not narrated');
    await shot('debrief');
    button(/^Continue$|^Dalej$/).click();
    if (!await until(() => document.querySelector('.camp-gig.is-story'))) return fail('back to hub failed');
    button(/← (Menu)/).click();
    await until(() => document.querySelector('.menu-list'));
    button(/Settings|Ustawienia/).click();
    await wait(500);
    await shot('settings');
    const keyResult = await window.zmDesktop.llmSetKey('smoke-test-key');
    return {
      passed: true, title, freeLines: lines, crewInBattle, keyResult, keyReachesPage: JSON.stringify(await window.zmDesktop.llmStatus()).includes('smoke-test-key'),
      writerModel: [...document.querySelectorAll('input')].map((i) => i.value).filter((v) => v.startsWith('gemini')),
    };
    } catch (e) {
      return fail(String(e) + ' ' + (e.stack || ''));
    }
  })()
`;

export function runSmoke(win: BrowserWindow): void {
  const out = process.env.ZM_SMOKE_OUT;
  const hold = Number(process.env.ZM_SMOKE_HOLD) || 0;
  const errors: string[] = [];
  const report = (line: string) => {
    console.log(line);
    if (out) {
      try {
        appendFileSync(out, `${line}\n`);
      } catch (e) {
        console.log(`could not write ${out}: ${String(e)}`);
      }
    }
  };

  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(e.message);
    else if (e.message.startsWith('ZMLOG SHOT ')) {
      const dir = process.env.ZM_SMOKE_SHOTS;
      if (dir) void win.webContents.capturePage().then((img) => writeFileSync(`${dir}/${e.message.slice(11)}.png`, img.toPNG()));
    } else if (e.message.startsWith('ZMLOG ')) report(e.message.slice(6));
  });
  win.webContents.once('did-fail-load', (_e, code, desc) => {
    report(`SMOKE FAILED ${code} ${desc}`);
    app.exit(1);
  });
  win.webContents.once('did-finish-load', async () => {
    report(`started on ${process.platform} ${process.arch}, electron ${process.versions.electron}, app at ${app.getAppPath()}`);
    const check = process.env.ZM_SMOKE_CAMPAIGN === '1' ? CAMPAIGN_CHECK : process.env.ZM_SMOKE_ONLINE === '1' ? ONLINE_CHECK : LOCAL_CHECK;
    let result: { passed?: boolean } = {};
    try {
      result = await win.webContents.executeJavaScript(check);
    } catch (e) {
      // A broken check must fail loudly, not leave the app sitting open with no report.
      report(`SMOKE FAILED ${String(e)} ${errors.join(' | ')}`);
      app.exit(1);
      return;
    }
    let keyOnDisk = 'none';
    try {
      keyOnDisk = readFileSync(path.join(app.getPath('userData'), 'gemini.key')).includes('smoke-test-key') ? 'PLAINTEXT' : 'encrypted';
    } catch { /* no key was saved in this run */ }
    report(`SMOKE ${JSON.stringify({ ...result, keyOnDisk, errors })}`);
    setTimeout(() => app.exit(result.passed && errors.length === 0 ? 0 : 1), hold);
  });
}
