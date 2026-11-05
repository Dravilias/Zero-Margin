import { TUTORIAL_STEPS, sameAction, type TutorialSpot, type TutorialStep } from '../engine/tutorial';
import type { Action, GameState } from '../engine/types';
import { LocalSession } from '../net/sessions';
import { sfx } from './audio';
import { el } from './dom';
import { t } from './i18n';

/** Plays the enemy from the lesson's script until free play. It never touches the player's saved game. */
export class TutorialSession extends LocalSession {
  protected saves = false;
  script: Action[] = [];
  free = false;

  protected nextAiAction(side: number): Action | null {
    if (this.script.length) return this.script.shift()!;
    return this.free ? super.nextAiAction(side) : null;
  }
}

export interface CoachHost {
  changed(): void;
  toast(text: string): void;
}

/** Walks the player through TUTORIAL_STEPS: shows the text, says what to point at, and limits what they can do. */
export class Coach {
  readonly card: HTMLElement = el('div.coach');
  private index = 0;
  private host: CoachHost | null = null;

  constructor(private session: TutorialSession) {
    this.enter();
  }

  attach(host: CoachHost): void {
    this.host = host;
  }

  private get step(): TutorialStep {
    return TUTORIAL_STEPS[this.index];
  }

  isFree(): boolean {
    return this.step.kind === 'free';
  }

  isInfo(): boolean {
    return this.step.kind === 'info';
  }

  playerMayAct(): boolean {
    return this.step.kind === 'do' || this.step.kind === 'hover' || this.step.kind === 'free';
  }

  allows(action: Action): boolean {
    const s = this.step;
    if (s.kind === 'free') return true;
    return s.kind === 'do' && !!s.action && sameAction(s.action, action);
  }

  spot(): TutorialSpot {
    return this.step.spot ?? {};
  }

  pinned(): string | null {
    return this.step.pin ?? null;
  }

  nudge(): void {
    this.host?.toast(t('tutorial.nudge'));
  }

  hovered(unitId: string | null): void {
    if (this.step.kind === 'hover' && unitId === this.step.unit) this.next();
  }

  /** Called when animations finish: moves on if what this step was waiting for has happened. */
  sync(state: GameState): void {
    for (;;) {
      const s = this.step;
      if (!s.done) return;
      if (s.kind === 'enemy' && this.session.script.length) return;
      if (!s.done(state)) return;
      this.index += 1;
      this.enter();
    }
  }

  next(): void {
    this.index += 1;
    this.enter();
    this.host?.changed();
  }

  private enter(): void {
    const s = this.step;
    if (s.kind === 'enemy') this.session.script = [...(s.script ?? [])];
    if (s.kind === 'free') this.session.free = true;
    this.render();
  }

  private render(): void {
    const s = this.step;
    const total = TUTORIAL_STEPS.length;
    this.card.replaceChildren(
      el('div.coach-body', {},
        el('div.coach-head', {},
          el('h3', {}, t(`tutorial.step.${s.id}.title`)),
          el('span.coach-count', {}, t('tutorial.stepCount', { n: this.index + 1, total })),
        ),
        el('p', {}, t(`tutorial.step.${s.id}.text`)),
      ),
      s.kind === 'info'
        ? el('button.btn-primary.coach-next', { onclick: () => { sfx.click(); this.next(); } }, t('tutorial.continue'))
        : s.kind === 'enemy' ? el('span.coach-watch', {}, t('tutorial.watching')) : el('span'),
    );
    this.card.classList.toggle('is-free', s.kind === 'free');
  }
}
