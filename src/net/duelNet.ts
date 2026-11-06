import { applyDuel, createDuel, duelAi, type DuelAction, type DuelSide, type DuelState } from '../engine/duel';
import { Rand } from '../engine/rng';
import type { RulesetId } from '../engine/types';
import { RelayClient, type RelayStatus } from './relayClient';
import type { GuestMsg, HostMsg } from './sessions';

/* Who the duel screen talks to. The host's game owns the state, as in the other modes. */

export interface DuelController {
  state: DuelState | null;
  /** The side this player controls; null means both are played on this PC. */
  me: DuelSide | null;
  code: string | null;
  status: RelayStatus;
  onChange: (() => void) | null;
  onClosed: ((reason: string) => void) | null;
  act(action: DuelAction, side: DuelSide): void;
  dispose(): void;
}

const AI_DELAY = 600;

export class DuelLocal implements DuelController {
  state: DuelState;
  code = null;
  status: RelayStatus = 'open';
  onChange: DuelController['onChange'] = null;
  onClosed: DuelController['onClosed'] = null;
  private rnd: Rand;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** me null is two people on one PC; otherwise the computer plays the other side. */
  constructor(seed: number, ruleset: RulesetId, public me: DuelSide | null, private delay = AI_DELAY) {
    this.state = createDuel(seed, ruleset);
    this.rnd = new Rand(seed ^ 0x2f1b);
    this.think();
  }

  act(action: DuelAction, side: DuelSide): void {
    const res = applyDuel(this.state, action, side);
    if (!res.ok) return;
    this.state = res.state;
    this.onChange?.();
    this.think();
  }

  private think(): void {
    if (!this.me || this.state.winner || this.state.active === this.me || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const side = this.state.active;
      this.act(duelAi(this.state, side, this.rnd), side);
    }, this.delay);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.me = this.state.active;
  }
}

export class DuelHost implements DuelController {
  state: DuelState | null = null;
  code: string | null;
  status: RelayStatus = 'open';
  onChange: DuelController['onChange'] = null;
  onClosed: DuelController['onClosed'] = null;
  private friend: string | null = null;

  constructor(private relay: RelayClient, private seed: number, private ruleset: RulesetId, public me: DuelSide) {
    this.code = relay.code;
    relay.handlers.onPeer = (event, peer) => {
      if (event === 'join' || event === 'rejoin') {
        if (this.friend && this.friend !== peer.id) {
          relay.kick(peer.id);
          return;
        }
        this.friend = peer.id;
        this.state ??= createDuel(this.seed, this.ruleset);
        this.send();
        this.onChange?.();
      }
    };
    relay.handlers.onMessage = (from, data) => {
      const m = data as GuestMsg;
      if (m.k === 'duelAct' && from === this.friend) this.apply(m.action, this.otherSide());
    };
    relay.handlers.onStatus = (status) => {
      this.status = status;
      if (status === 'open') this.send();
      this.onChange?.();
    };
    relay.handlers.onClosed = (reason) => this.onClosed?.(reason);
  }

  private otherSide(): DuelSide {
    return this.me === 'hacker' ? 'corp' : 'hacker';
  }

  private send(): void {
    if (this.friend && this.state) this.relay.send(this.friend, { k: 'duel', state: this.state, you: this.otherSide() } satisfies HostMsg);
  }

  private apply(action: DuelAction, side: DuelSide): void {
    if (!this.state) return;
    const res = applyDuel(this.state, action, side);
    if (!res.ok) return;
    this.state = res.state;
    this.send();
    this.onChange?.();
  }

  act(action: DuelAction, side: DuelSide): void {
    if (side === this.me) this.apply(action, side);
  }

  dispose(): void {
    this.relay.close();
  }
}

export class DuelGuest implements DuelController {
  state: DuelState;
  me: DuelSide;
  code: string | null;
  status: RelayStatus = 'open';
  onChange: DuelController['onChange'] = null;
  onClosed: DuelController['onClosed'] = null;

  constructor(private relay: RelayClient, first: Extract<HostMsg, { k: 'duel' }>) {
    this.state = first.state;
    this.me = first.you;
    this.code = relay.code;
    relay.handlers.onMessage = (_f, data) => {
      const m = data as HostMsg;
      if (m.k === 'duel') {
        this.state = m.state;
        this.me = m.you;
        this.onChange?.();
      }
    };
    relay.handlers.onStatus = (status) => { this.status = status; this.onChange?.(); };
    relay.handlers.onClosed = (reason) => this.onClosed?.(reason);
  }

  act(action: DuelAction): void {
    this.relay.send('host', { k: 'duelAct', action } satisfies GuestMsg);
  }

  dispose(): void {
    this.relay.close();
  }
}
