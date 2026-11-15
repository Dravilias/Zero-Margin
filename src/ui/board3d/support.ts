/*
 * Whether this PC can draw the 3D board well. A PC with no graphics acceleration still offers WebGL,
 * drawn in software, which is far too slow for it; those get the flat board unless the player insists.
 */

export type GraphicsSupport = 'hardware' | 'software' | 'none';

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/i;

let cached: GraphicsSupport | null = null;

/** Sorts a WebGL renderer name into hardware or software drawing. */
export function classifyRenderer(name: string): GraphicsSupport {
  return SOFTWARE.test(name) ? 'software' : 'hardware';
}

export function graphicsSupport(): GraphicsSupport {
  if (cached) return cached;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    if (!gl) return (cached = 'none');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    cached = classifyRenderer(name);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    cached = 'none';
  }
  return cached;
}

/** The player's choice, applied to this PC: whether a new battle opens on the 3D board. */
export function wants3d(choice: 'auto' | '3d' | '2d', support: GraphicsSupport = graphicsSupport()): boolean {
  if (choice === '2d' || support === 'none') return false;
  return choice === '3d' || support === 'hardware';
}
