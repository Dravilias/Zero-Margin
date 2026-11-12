import { RelayClient } from '../net/relayClient';
import { el } from './dom';
import { t } from './i18n';

function paint(node: Element): void {
  const n = RelayClient.directTotal();
  node.textContent = n > 1 ? t('net.direct.many', { n }) : n === 1 ? t('net.direct.on') : t('net.direct.off');
  node.classList.toggle('on', n > 0);
}

/** A small label next to the join code saying whether the game runs over direct links. Nothing when they're turned off. */
export function linkBadge(): HTMLElement | null {
  if (!RelayClient.defaultDirect || !RelayClient.online()) return null;
  const node = el('span.link-badge', { title: t('net.direct.d') });
  paint(node);
  return node;
}

RelayClient.onLinks = () => document.querySelectorAll('.link-badge').forEach(paint);
