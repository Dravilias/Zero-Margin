type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

/** Small DOM builder: el('div.card.big', { onclick }, child, child) */
export function el<K extends keyof HTMLElementTagNameMap>(spec: K | string, props?: Props | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div') as HTMLElementTagNameMap[K];
  if (classes.length) node.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2), v as EventListener);
      } else if (k === 'class') {
        node.className = `${node.className} ${v}`.trim();
      } else if (k === 'style' && typeof v === 'object') {
        for (const [p, val] of Object.entries(v as Record<string, string>)) {
          if (p.startsWith('--')) node.style.setProperty(p, val);
          else (node.style as unknown as Record<string, string>)[p] = val;
        }
      } else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') {
        (node as unknown as Record<string, unknown>)[k] = v;
      } else {
        node.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  append(node, children);
  return node;
}

function append(node: Node, children: (Child | Child[])[]): void {
  for (const c of children) {
    if (Array.isArray(c)) append(node, c);
    else if (c === null || c === undefined || c === false) continue;
    else node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** A moving bar for anything that takes a while, so a wait never looks like a freeze. */
export const loadingBar = (): HTMLElement => el('div.loading-bar', { role: 'progressbar', 'aria-label': 'Loading' }, el('span'));

/** A whole page for a wait: an optional heading, what's happening, and the moving bar. */
export const loadingPage = (text: string, title?: string): HTMLElement => el('div.center-page', {}, el('div.card.narrow', {},
  title ? el('h2', {}, title) : null,
  el('p', {}, text),
  loadingBar(),
));

/** Runs once the browser has had the chance to show what's on the page. Hidden windows draw no frames, so a timer backs it up. */
export function afterPaint(run: () => void): void {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    run();
  };
  requestAnimationFrame(() => requestAnimationFrame(once));
  setTimeout(once, 200);
}

export function clear(node: Element): void {
  node.replaceChildren();
}

export function selectEl<T extends string | number>(
  value: T, options: { value: T; label: string }[], onChange: (v: T) => void, props: Props = {},
): HTMLSelectElement {
  return el('select', {
    ...props,
    onchange: (e: Event) => {
      const raw = (e.target as HTMLSelectElement).value;
      const hit = options.find((o) => String(o.value) === raw);
      if (hit) onChange(hit.value);
    },
  }, options.map((o) => el('option', { value: String(o.value), selected: o.value === value }, o.label)));
}

/** Copy to the clipboard, falling back to the older method if the permission is refused. */
export function copyText(text: string): void {
  const fallback = () => {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  };
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(fallback);
  else fallback();
}
