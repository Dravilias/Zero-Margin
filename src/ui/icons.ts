import type { RoleId } from '../engine/types';

/** Original role icons on a 24x24 grid, shared by the board tokens and the panels. */
export const ROLE_PATHS: Record<RoleId, string> = {
  breaker: 'M12 2.500v5M12 16.500v5M2.500 12h5M16.500 12h5M12 7.500a4.500 4.500 0 1 0 0 9 4.500 4.500 0 0 0 0-9z',
  razor: 'M4.500 20.500 18 4l2.500 2L8 21zM3 16.500l4.500 4.500',
  longeye: 'M2 12s3.800-6.500 10-6.500S22 12 22 12s-3.800 6.500-10 6.500S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  wire: 'M13.500 2 5 13.500h6L10 22l9-12h-6.200z',
  patcher: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z',
  wrench: 'M20.500 6.500a5 5 0 0 1-6.600 5.800L7 19.200a2.100 2.100 0 0 1-3-3l6.900-6.900A5 5 0 0 1 16.700 2.700l-3 3 .8 3 3 .8z',
  sapper: 'M10.500 7.500a6.500 6.500 0 1 0 .001 13.001A6.500 6.500 0 0 0 10.500 7.500zM14.500 8.500 17.500 5.500M17.500 5.500c1.500-1.500 3-.5 3.500-2',
  punk: 'M3.500 20.500 5.500 11l3.500 4L12 3.500 15 15l3.500-4 2 9.500z',
  broker: 'M3 7h18v12H3zM8 7V4h8v3M12 11v4',
  face: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5',
  suit: 'M12 3 6 8l3 3-1 10h8l-1-10 3-3z',
  drone: 'M9 9h6v6H9zM9 9 5 5M15 9l4-4M9 15l-4 4M15 15l4 4M2.500 5h5M16.500 5h5M2.500 19h5M16.500 19h5',
};

const STROKED = new Set<RoleId>(['breaker', 'longeye', 'drone', 'sapper']);

export function isStroked(role: RoleId): boolean {
  return STROKED.has(role);
}

export function roleIcon(role: RoleId): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'role-icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ROLE_PATHS[role]);
  if (STROKED.has(role)) {
    path.setAttribute('fill', role === 'sapper' ? 'currentColor' : 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linejoin', 'round');
  } else {
    path.setAttribute('fill', 'currentColor');
  }
  svg.appendChild(path);
  return svg;
}

/** Action bar icons, on the same 24x24 grid. All are drawn as plain strokes. */
const ACTION_PATHS: Record<string, string> = {
  aim: 'M12 3v5M12 16v5M3 12h5M16 12h5M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 11.500v1',
  burst: 'M4 6h9l3 3-3 3H4zM4 14h6M4 18h9M16 15h4M18 19h3',
  reload: 'M20 12a8 8 0 1 1-2.400-5.700M20 3v5h-5',
  overwatch: 'M2 13s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6zM12 10.500a2.500 2.500 0 1 0 0 5 2.500 2.500 0 0 0 0-5zM12 2v2M5 4l1.500 1.500M19 4l-1.500 1.500',
  suppress: 'M3 7h12M3 12h18M3 17h12M18 5l3 2-3 2M18 15l3 2-3 2',
  melee: 'M19.500 3 9 13.500M21 3v4l-9.500 9.500-4-4L17 3zM5.500 14.500l4 4M3 21l4-4',
  brace: 'M12 3l8 3v6c0 5-3.500 7.500-8 9-4.500-1.500-8-4-8-9V6z',
  frag: 'M12 9a6.500 6.500 0 1 0 .001 13A6.500 6.500 0 0 0 12 9zM9.500 9.500V6h5v3.500M14.500 6l3-3 2.500 1.500M9 15.500h6M12 12.500v6',
  smoke: 'M7 18a4 4 0 0 1-.500-8 5.500 5.500 0 0 1 10.500-1 4.500 4.500 0 0 1 0 9zM4 21h7M14 21h5',
  emp: 'M13 3 6 13h5l-1 8 8-11h-5zM3 8a10 10 0 0 0 0 8M21 8a10 10 0 0 1 0 8',
  glitch: 'M3 6h8v3h5v3h5M3 18h6v-3h5v-3M16 18h5',
  seize: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5zM12 15v2',
  burn: 'M12 3c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 1.500-4.500 3-6 0 2 1 3 2 3 1-2-.500-5 1-9z',
  hijack: 'M3 12h13M12 7l5 5-5 5M20 4v16',
  terminal: 'M3 4h18v12H3zM8 21h8M12 16v5M7 8l3 2-3 2M12 12h4',
  patch: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z',
  repair: 'M20.500 6.500a5 5 0 0 1-6.600 5.800L7 19.200a2.100 2.100 0 0 1-3-3l6.900-6.900A5 5 0 0 1 16.700 2.700l-3 3 .8 3 3 .8z',
  stim: 'M18 3l3 3M16 5l3 3M17.500 6.500 8 16l-3 .5.5-3 9.500-9.500M8 16l-5 5M11 9l2 2M8.500 11.500l2 2',
  spike: 'M6 12l6-6 6 6M6 19l6-6 6 6',
  drone: 'M9 9h6v6H9zM9 9 5 5M15 9l4-4M9 15l-4 4M15 15l4 4M2.500 5h5M16.500 5h5M2.500 19h5M16.500 19h5',
  capture: 'M5 21V3M5 4h13l-3 4 3 4H5',
  grab: 'M12 2l6 4v12l-6 4-6-4V6zM6 6l6 4 6-4M12 10v12',
  clearJam: 'M4 8h16v8H4zM9 5l6 14M15 5 9 19',
  end: 'M5 5l8 7-8 7zM17 5v14',
};

export function actionIcon(name: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'action-icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ACTION_PATHS[name] ?? '');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linejoin', 'miter');
  svg.appendChild(path);
  return svg;
}
