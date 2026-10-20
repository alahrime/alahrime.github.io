// Fractal background engine. Every fractal is one entry in FRACTALS; the Fractal dropdown is built from it.
// Renderer types: 'esc' (2D shader) and 'ray' (3D ray-marched shader) are full-screen fragment shaders,
// 'pts' is a GPU point cloud (each point iterates its own orbit), 'line' is an L-system curve drawn as a strip.
// Shaders compile the first time their fractal is picked.

// ---------- shared GLSL ----------
// Full-screen fractals only define `vec3 shade(vec2 fc)`: the color at one sample position.
// MAIN wraps it: `ss` samples per pixel (supersampling), then dithering to break up 8-bit banding.
// `rs` is render pixels per CSS pixel, so glow widths look the same at every quality level.
const HEAD = `precision highp float;
uniform vec2 res, ctr; uniform float t, scl, rs; uniform vec3 bg, ca, cb; uniform int ss;
vec2 P(vec2 fc) { return (fc - res * .5) / min(res.x, res.y); }
vec3 pal(float x) { return mix(ca, cb, .5 + .5 * sin(x)); }
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`;
const MAIN = `
void main() {
  vec3 c = vec3(0);
  for (int i = 0; i < 4; i++) {
    if (i >= ss) break;
    vec2 o = ss == 1 ? vec2(0)
           : ss == 2 ? (i == 0 ? vec2(-.25, .25) : vec2(.25, -.25))                                  // diagonal pair
           : (i == 0 ? vec2(.125, .375) : i == 1 ? vec2(-.375, .125) : i == 2 ? vec2(.375, -.125) : vec2(-.125, -.375)); // rotated grid
    c += shade(gl_FragCoord.xy + o);
  }
  c = c / float(ss) + (hash(gl_FragCoord.xy + fract(t * 7.)) - .5) / 255.;
  gl_FragColor = vec4(c, 1);
}`;
const FULL_VS = 'attribute vec2 a0; void main() { gl_Position = vec4(a0, 0, 1); }';

// Escape-time: Julia (0), Mandelbrot (1), Burning Ship (2). Glow follows the distance estimate,
// so only the set's edge lights up at any zoom.
const escape = kind => `const int kind = ${kind};
vec3 shade(vec2 fc) {
  vec2 p = P(fc), z, c;
  if (kind == 0) { z = p * 3.; c = .7885 * vec2(cos(t), sin(t)); }     // Julia, c orbits |c| = .7885
  else if (kind == 1) { z = vec2(0); c = ctr + p * scl; }              // Mandelbrot
  else { z = vec2(0); c = ctr + p * scl; c.y = -c.y; }                 // Burning Ship (drawn upright)
  float n = -1., px = (kind == 0 ? 3. : scl) / min(res.x, res.y);   // size of one render pixel in the plane
  vec2 dz = vec2(kind == 0 ? 1. : 0., 0);                           // derivative, for distance estimate
  for (int i = 0; i < 400; i++) {
    if (kind == 2) { dz *= sign(z); z = abs(z); }                   // ponytail: approximate DE for the ship
    dz = 2. * cmul(z, dz) + vec2(kind == 0 ? 0. : 1., 0);
    z = cmul(z, z) + c;
    if (dot(z, z) > 256.) { n = float(i); break; }
  }
  if (n < 0.) return bg;                                            // inside the set: empty
  float v = n + 1. - log2(log2(dot(z, z)) * .5);                    // smooth escape time
  float d = .5 * length(z) * log(length(z)) / length(dz) / (px * rs); // distance to set, in CSS pixels
  return mix(bg, pal(log2(v) * 3. + t * 2.), exp(-sqrt(d) * .5));
}` + MAIN;

// Newton's method on z^3 - 1. The relaxation a breathes around 1, which warps the basin borders.
const NEWTON = `
vec2 cdiv(vec2 a, vec2 b) { return vec2(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / dot(b, b); }
vec3 shade(vec2 fc) {
  float r = t * .15, a = 1. + .3 * sin(t * .8), n = 0.;
  vec2 z = mat2(cos(r), -sin(r), sin(r), cos(r)) * P(fc) * 2.4;
  for (int i = 0; i < 48; i++) {
    vec2 z2 = cmul(z, z), f = cmul(z2, z) - vec2(1, 0);
    if (dot(f, f) < 1e-6) break;
    z -= a * cdiv(f, 3. * z2); n++;
  }
  float k = floor(mod(atan(z.y, z.x) / 2.0944 + .5, 3.));           // which cube root of 1 it reached
  vec3 col = k < .5 ? ca : k < 1.5 ? cb : mix(ca, cb, .5);
  return mix(bg, col, pow(clamp(n / 18., 0., 1.), 1.5));
}` + MAIN;

// Apollonian packing by repeated fold + circle inversion; k breathes so the bubbles drift.
const APOLLONIAN = `
vec3 shade(vec2 fc) {
  vec2 p = P(fc) * 2.2;
  float px = 2.2 / min(res.x, res.y), k = 1.15 + .06 * sin(t * .9), s = 1., orb = 1e3;
  for (int i = 0; i < 9; i++) {
    p = -1. + 2. * fract(.5 * p + .5);
    float r2 = dot(p, p);
    orb = min(orb, r2);
    float f = k / r2; p *= f; s *= f;
  }
  float d = .25 * abs(p.y) / s / (px * rs);                         // distance to nearest circle, in CSS pixels
  return mix(bg, pal(log(orb) * 1.5 + t * 2.), exp(-sqrt(d) * .7));
}` + MAIN;

// 3D: sphere-trace a distance estimator `de` with a camera orbiting the origin at radius R, height h.
// Rays stop within one pixel's footprint, so higher render resolution resolves finer detail.
// Shading: key light with soft shadows, ambient occlusion, specular, rim, and depth fog.
const ray = (de, R, h) => { const f = x => x.toFixed(3), sc = f(R / 5); return `${de}
float shadow(vec3 p, vec3 l) {                    // soft shadow: how close the ray to the light passes the surface
  float s = 1., k = .02 * ${sc};
  for (int i = 0; i < 32; i++) {
    float d = de(p + l * k);
    s = min(s, 10. * d / k); k += clamp(d, .01 * ${sc}, .3 * ${sc});
    if (s < .01 || k > ${f(R)}) break;
  }
  return clamp(s, 0., 1.);
}
float occlusion(vec3 p, vec3 n) {                 // ambient occlusion: how enclosed the point is
  float o = 0., w = 1.;
  for (int i = 0; i < 5; i++) {
    float hh = (.01 + .03 * float(i)) * ${sc};
    o += (hh - de(p + n * hh)) * w; w *= .7;
  }
  return clamp(1. - 2.5 * o / ${sc}, 0., 1.);
}
vec3 shade(vec2 fc) {
  float a = t * .5;
  vec3 ro = vec3(${f(R)} * cos(a), ${f(h)}, ${f(R)} * sin(a)), fw = normalize(-ro);
  vec3 rt = normalize(cross(vec3(0, 1, 0), fw)), rd = mat3(rt, cross(fw, rt), fw) * normalize(vec3(P(fc), 1.6));
  float pa = .75 / (min(res.x, res.y) * 1.6);   // angular size of a pixel
  float dist = 0., st = 0.; bool hit = false;
  for (int i = 0; i < 160; i++) {
    float d = de(ro + rd * dist);
    if (d < pa * dist) { hit = true; break; }
    dist += d; st++;
    if (dist > ${f(R * 2.5)}) break;
  }
  vec3 col = mix(bg, ca, pow(st / 160., 2.) * .6);                  // faint glow where rays graze it
  if (!hit) return col;
  vec3 p = ro + rd * dist; vec2 e = vec2(pa * dist, 0);
  vec3 n = normalize(vec3(de(p + e.xyy) - de(p - e.xyy), de(p + e.yxy) - de(p - e.yxy), de(p + e.yyx) - de(p - e.yyx)));
  vec3 l = normalize(-fw * .7 + cross(fw, rt) * .6 + rt * .4);  // key light rides with the camera, above and to the right
  float dif = clamp(dot(n, l), 0., 1.);
  float sha = dif > 0. ? shadow(p + n * e.x * 4., l) : 0.;
  float ao = occlusion(p, n);
  float spe = pow(clamp(dot(n, normalize(l - rd)), 0., 1.), 40.) * dif;
  float rim = pow(1. - abs(dot(n, rd)), 3.);
  float lit = clamp((.3 + .7 * dif * sha) * ao + rim * .35 * ao, 0., 1.);
  col = mix(bg, pal(length(p) * 4. + t * 2.), lit) + spe * sha * .55 * mix(vec3(1), ca, .35);
  return mix(col, bg, smoothstep(${f(R * .75)}, ${f(R * 1.6)}, dist));  // depth fog
}` + MAIN; };

const MANDELBULB = `float de(vec3 p) {
  vec3 z = p; float dr = 1., r = 0.;
  for (int i = 0; i < 8; i++) {
    r = length(z); if (r > 2.) break;
    float th = acos(z.y / r) * 8., ph = atan(z.z, z.x) * 8.;
    dr = pow(r, 7.) * 8. * dr + 1.;
    z = pow(r, 8.) * vec3(sin(th) * cos(ph), cos(th), sin(th) * sin(ph)) + p;
  }
  return .5 * log(r) * r / dr;
}`;
const MANDELBOX = `float de(vec3 p) {
  vec4 z = vec4(p, 1), c = z;
  for (int i = 0; i < 12; i++) {
    z.xyz = clamp(z.xyz, -1., 1.) * 2. - z.xyz;                     // box fold
    z *= clamp(1. / dot(z.xyz, z.xyz), 1., 4.);                     // sphere fold
    z.xyz = z.xyz * -1.75 + c.xyz; z.w = z.w * 1.75 + 1.;           // w tracks the running derivative
  }
  return (length(z.xyz) - 2.75) / z.w - pow(1.75, -11.);
}`;
const MENGER = `float de(vec3 p) {
  vec3 q = abs(p) - 1.;
  float d = length(max(q, 0.)) + min(max(q.x, max(q.y, q.z)), 0.), s = 1.;
  for (int m = 0; m < 4; m++) {
    vec3 a = mod(p * s, 2.) - 1.; s *= 3.;
    vec3 r = abs(1. - 3. * abs(a));
    d = max(d, (min(max(r.x, r.y), min(max(r.y, r.z), max(r.z, r.x))) - 1.) / s);
  }
  return d;
}`;
const SIERPINSKI = `float de(vec3 z) {
  for (int i = 0; i < 10; i++) {
    if (z.x + z.y < 0.) z.xy = -z.yx;
    if (z.x + z.z < 0.) z.xz = -z.zx;
    if (z.y + z.z < 0.) z.zy = -z.yz;
    z = z * 2. - 1.;
  }
  return length(z) * pow(2., -10.);
}`;

// Point clouds: each vertex starts at a random seed, iterates its own orbit, and lands on the attractor.
// Rendered as a density map: every point adds its color into a half-float buffer, then a tone-map pass
// turns hit counts into light (log curve), so dense strands glow and sparse ones stay as fine silk.
const N_MAX = 1600000;
const PTS_VS = body => `attribute vec2 a0; uniform float t, ps; uniform vec2 res; uniform vec3 ca, cb; varying vec3 col;
float h(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  vec2 q; float v;
  ${body}
  gl_Position = vec4(q * min(res.x, res.y) / res, 0, 1);
  gl_PointSize = ps;
  col = mix(ca, cb, .5 + .5 * sin(v));
}`;
const ACC_FS = 'precision mediump float; varying vec3 col; void main() { gl_FragColor = vec4(col, 1); }';
const TONE_FS = `precision highp float;
uniform sampler2D acc; uniform vec2 res; uniform vec3 bg; uniform float t, gain;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 a = texture2D(acc, gl_FragCoord.xy / res);                   // rgb = summed color, a = hit count
  float i = clamp(log2(1. + a.a * gain) / 5., 0., 1.);
  vec3 c = mix(bg, a.a > 0. ? a.rgb / a.a : bg, i);
  gl_FragColor = vec4(c + (hash(gl_FragCoord.xy + fract(t * 7.)) - .5) / 255., 1);
}`;
// Fallback when float render targets are unavailable: translucent dots.
const PTS_FS = alpha => `precision mediump float; varying vec3 col; void main() { gl_FragColor = vec4(col, ${alpha}); }`;

const CLIFFORD = `
  float a = -1.4 + .2 * sin(t * .37), b = 1.6 + .2 * cos(t * .29), c = 1. + .1 * sin(t * .53), d = .7 + .15 * cos(t * .41);
  vec2 p = a0 * 2. - 1., pp = p;
  for (int i = 0; i < 24; i++) { pp = p; p = vec2(sin(a * p.y) + c * cos(a * p.x), sin(b * p.x) + d * cos(b * p.y)); }
  q = p / (1. + max(abs(c), abs(d))) * .9;
  v = atan(p.y - pp.y, p.x - pp.x) + t;                             // color by direction of travel`;
const BARNSLEY = `
  vec2 p = vec2(0); float s = a0.x * 1000. + a0.y;
  for (int i = 0; i < 40; i++) {
    float r = h(s + float(i) * 1.618);
    if (r < .01) p = vec2(0, .16 * p.y);
    else if (r < .86) p = vec2(.85 * p.x + .04 * p.y, -.04 * p.x + .85 * p.y + 1.6);
    else if (r < .93) p = vec2(.2 * p.x - .26 * p.y, .23 * p.x + .22 * p.y + 1.6);
    else p = vec2(-.15 * p.x + .28 * p.y, .26 * p.x + .24 * p.y + .44);
  }
  p.x += sin(t * 1.5 + p.y * .4) * .02 * p.y;                       // wind sway, stronger toward the tip
  q = vec2(p.x - .3, p.y - 5.) / 5.3;
  v = p.y * .5 + t;`;

// Curves: an L-system turtle walk, drawn in and back out over time while slowly turning.
const LINE_VS = `attribute vec2 a0; attribute float a1; uniform float t; uniform vec2 res; uniform vec3 ca, cb; varying vec3 col;
void main() {
  float r = t * .1;
  gl_Position = vec4(mat2(cos(r), sin(r), -sin(r), cos(r)) * a0 * .9 * min(res.x, res.y) / res, 0, 1);
  col = mix(ca, cb, .5 + .5 * sin(a1 * 12. + t * 2.));
}`;
const LINE_FS = 'precision mediump float; varying vec3 col; void main() { gl_FragColor = vec4(col, .9); }';

// Expand an L-system and walk it. Returns [x, y, k] per vertex, fit to [-1, 1], k = 0..1 along the curve.
function lsys(axiom, rules, n, deg, draw) {
  let s = axiom;
  for (let i = 0; i < n; i++) s = s.replace(/./g, ch => rules[ch] ?? ch);
  const turn = deg * Math.PI / 180, pts = [[0, 0]];
  let x = 0, y = 0, a = 0;
  for (const ch of s) {
    if (draw.includes(ch)) { x += Math.cos(a); y += Math.sin(a); pts.push([x, y]); }
    else if (ch === '+') a += turn; else if (ch === '-') a -= turn;
  }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const k = 2 / Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return new Float32Array(pts.flatMap(([px, py], i) => [(px - cx) * k, (py - cy) * k, i / (pts.length - 1)]));
}

const HILBERT = ['A', { A: '+BF-AFA-FB+', B: '-AF+BFB+FA-' }, 'F'];
const DRAGON = ['F', { F: 'F+G', G: 'F-G' }, 'FG'];
const GOSPER = ['A', { A: 'A-B--B+A++AA+B-', B: '+A-AA--B-A++A+B' }, 'AB'];
const curve = ([axiom, rules, draw], n, deg) => [axiom, rules, n, deg, draw];

// ---------- icons (24x24, stroke = currentColor) ----------
const svg = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
// A curve icon is the real curve at low order.
const curveIcon = c => {
  const d = lsys(...c);
  let path = '';
  for (let i = 0; i < d.length; i += 3) path += (i ? 'L' : 'M') + (12 + d[i] * 8.5).toFixed(1) + ' ' + (12 - d[i + 1] * 8.5).toFixed(1);
  return svg(`<path d="${path}" stroke-width="1.3"/>`);
};
const ICON = {
  mandelbox: svg('<path d="M4 7l8-4 8 4v10l-8 4-8-4z M4 7l8 4 8-4 M12 11v10"/><path d="M9 10.5l3 1.5 3-1.5v3.5l-3 1.5-3-1.5z" opacity=".55"/>'),
  menger: svg('<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/><rect x="9" y="9" width="6" height="6" fill="currentColor" opacity=".3"/>'),
  sierpinski: svg('<path d="M12 3l9 16H3z"/><path d="M7.5 11h9L12 19z"/><path d="M9.75 7h4.5L12 11z M5.25 15h4.5L7.5 19z M14.25 15h4.5L16.5 19z" opacity=".55"/>'),
  mandelbulb: svg('<circle cx="12" cy="12" r="5"/><circle cx="12" cy="4.5" r="2"/><circle cx="12" cy="19.5" r="2"/><circle cx="4.5" cy="12" r="2"/><circle cx="19.5" cy="12" r="2"/><circle cx="6.7" cy="6.7" r="1.2"/><circle cx="17.3" cy="6.7" r="1.2"/><circle cx="6.7" cy="17.3" r="1.2"/><circle cx="17.3" cy="17.3" r="1.2"/>'),
  julia: svg('<path d="M12 12c0-1 1-1.5 1.8-1 1.2.8.8 2.8-.8 3.3-2.2.7-4-1.2-3.6-3.4.5-3 3.8-4.4 6.4-3.2 3.4 1.6 4 6 1.7 8.8-2.6 3.2-7.6 3.4-10.4.6"/>'),
  mandelbrot: svg('<path d="M20 12c-1.5-2-3-5-6.5-5S8 9.5 8 12s2 5 5.5 5 5-3 6.5-5z"/><circle cx="5.3" cy="12" r="2.7"/><circle cx="13.5" cy="4.6" r="1.1"/><circle cx="13.5" cy="19.4" r="1.1"/>'),
  apollonian: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="7.5" r="4.5"/><circle cx="12" cy="16.5" r="4.5"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="12" r="3"/>'),
  barnsley: svg('<path d="M6 21C8 15 12 9 19 3"/><path d="M7.5 17.5C5.5 17 4 15.5 3.5 14 M9 15C7 14 6 12.5 6 11 M10.8 12.5C9.5 11 9 9.5 9.5 8 M12.8 10C12 8.5 12 7 12.8 5.8 M9 17.5c1.8.7 3.5.5 4.8-.3 M10.5 14.8c1.8.4 3.3 0 4.5-1 M12.3 12.2c1.6.2 3-.3 4-1.3 M14.5 9.3c1.3 0 2.5-.6 3.2-1.5"/>'),
  ship: svg('<path d="M2.5 15.5h19l-3 4.5H5.5z"/><path d="M8 15.5V7 M13 15.5V3.5 M17.5 15.5V9"/><path d="M8 8l-3.5 6H8 M13 4.5L8.8 13H13 M17.5 10l3 4h-3" opacity=".7"/>'),
  clifford: svg('<path d="M12 12C9 7 3 8 3 12s6 5 9 0 9-4 9 0-6 5-9 0"/><path d="M12 12c-2-3-6-3.5-6.5 0s4.5 3 6.5 0 4.5-3 6.5 0-4.5 3.5-6.5 0" opacity=".5"/>'),
  newton: svg('<circle cx="12" cy="12" r="9"/><path d="M12 12V3 M12 12l7.8 4.5 M12 12l-7.8 4.5"/><circle cx="16.5" cy="9" r="1.3" fill="currentColor"/><circle cx="7.5" cy="9" r="1.3" fill="currentColor"/><circle cx="12" cy="17.5" r="1.3" fill="currentColor"/>'),
  hilbert: curveIcon(curve(HILBERT, 2, 90)),
  dragon: curveIcon(curve(DRAGON, 7, 90)),
  gosper: curveIcon(curve(GOSPER, 2, 60)),
  none: svg('<circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/>'),
};

// ---------- registry (drives the dropdown, the hero formula, and the renderer) ----------
const G1 = '3D architecture', G2 = 'Organic & ethereal', G3 = 'Flames & chaos', G4 = 'Space-filling curves';
const GROUP_TAG = { [G1]: '3D', [G2]: 'Organic', [G3]: 'Chaos', [G4]: 'Curve' };
const FRACTALS = [
  { id: 'mandelbox', group: G1, name: 'Mandelbox', sub: 'box + sphere folds', type: 'ray', glsl: ray(MANDELBOX, 12., 4.),
    eq: 'z ↦ s·fold<sub>sphere</sub>(fold<sub>box</sub>(z)) + c,&nbsp; s = −1.75' },
  { id: 'menger', group: G1, name: 'Menger Sponge', sub: 'dim = log 20 / log 3', type: 'ray', glsl: ray(MENGER, 5.2, 2.2),
    eq: 'M = ⋂<sub>n</sub> M<sub>n</sub>,&nbsp; dim = log 20 / log 3 ≈ 2.727' },
  { id: 'sierpinski', group: G1, name: 'Sierpinski Tetrahedron', sub: 'dim = log 4 / log 2', type: 'ray', glsl: ray(SIERPINSKI, 5.2, 1.4),
    eq: 'T = ⋃<sub>i=1..4</sub> ½(T + v<sub>i</sub>),&nbsp; dim = 2' },
  { id: 'mandelbulb', group: G2, name: 'Mandelbulb', sub: 'z ↦ z⁸ + c in ℝ³', type: 'ray', glsl: ray(MANDELBULB, 4., 1.2),
    eq: 'z ↦ z<sup>8</sup> + c,&nbsp; (r, θ, φ) ↦ (r<sup>8</sup>, 8θ, 8φ)' },
  { id: 'julia', group: G2, name: 'Julia', sub: 'z ↦ z² + c', type: 'esc', glsl: escape(0),
    eq: 'z<sub>n+1</sub> = z<sub>n</sub>² + c,&nbsp; c = 0.7885·e<sup>iθ</sup>' },
  { id: 'mandelbrot', group: G2, name: 'Mandelbrot', sub: 'z₀ = 0, c ∈ ℂ', type: 'esc', glsl: escape(1),
    zoom: { home: [-0.6, 0], target: [-0.743643887, 0.131825904], depth: 8 },   // Seahorse Valley
    eq: 'z<sub>n+1</sub> = z<sub>n</sub>² + c,&nbsp; z<sub>0</sub> = 0' },
  { id: 'apollonian', group: G2, name: 'Apollonian Gasket', sub: 'tangent circle packing', type: 'esc', glsl: APOLLONIAN,
    eq: '(k<sub>1</sub>+k<sub>2</sub>+k<sub>3</sub>+k<sub>4</sub>)² = 2(k<sub>1</sub>²+k<sub>2</sub>²+k<sub>3</sub>²+k<sub>4</sub>²)' },
  { id: 'barnsley', group: G2, name: 'Barnsley Fern', sub: '4-map IFS', type: 'pts', glsl: BARNSLEY, alpha: .55,
    eq: 'x ↦ A<sub>i</sub>x + b<sub>i</sub>,&nbsp; p = (.01, .85, .07, .07)' },
  { id: 'ship', group: G3, name: 'Burning Ship', sub: 'z ↦ (|x|+i|y|)² + c', type: 'esc', glsl: escape(2),
    zoom: { home: [-1.0, 0.5], target: [-1.7621, 0.0281], depth: 3.5 },        // the little "ship"
    eq: 'z<sub>n+1</sub> = (|x<sub>n</sub>| + i|y<sub>n</sub>|)² + c' },
  { id: 'clifford', group: G3, name: 'Clifford Attractor', sub: 'strange attractor', type: 'pts', glsl: CLIFFORD, alpha: .28,
    eq: 'x′ = sin(a·y) + c·cos(a·x),&nbsp; y′ = sin(b·x) + d·cos(b·y)' },
  { id: 'newton', group: G3, name: 'Newton Fractal', sub: 'z ↦ z − f/f′', type: 'esc', glsl: NEWTON,
    eq: 'z<sub>n+1</sub> = z<sub>n</sub> − a·(z<sub>n</sub>³ − 1) / 3z<sub>n</sub>²' },
  { id: 'hilbert', group: G4, name: 'Hilbert Curve', sub: 'space-filling, 90°', type: 'line', lsys: curve(HILBERT, 6, 90),
    eq: 'A → +BF−AFA−FB+,&nbsp; B → −AF+BFB+FA−' },
  { id: 'dragon', group: G4, name: 'Dragon Curve', sub: 'paper folding, 90°', type: 'line', lsys: curve(DRAGON, 14, 90),
    eq: 'F → F+G,&nbsp; G → F−G,&nbsp; θ = 90°' },
  { id: 'gosper', group: G4, name: 'Gosper Curve', sub: 'hexagonal, 60°', type: 'line', lsys: curve(GOSPER, 4, 60),
    eq: 'A → A−B−−B+A++AA+B−,&nbsp; B → +A−AA−−B−A++A+B' },
  { id: 'none', name: 'Off', sub: 'plain background', eq: '' },
];
for (const f of FRACTALS) f.icon = ICON[f.id];

// ---------- engine ----------
// Quality ladders, lowest to highest: [render scale (× CSS pixels, capped at devicePixelRatio), samples per pixel, points].
// Each fractal starts high (2D at full device resolution with 2x supersampling, 3D at 1.5x, point clouds at 1.6M):
// fast GPUs climb further, and a GPU that can't keep up steps down within about a second.
const LADDER = {
  esc:  { start: r => r[1] === 2 && r[0] === Math.min(2, devicePixelRatio || 1), steps: [[1, 1], [1.5, 1], [2, 1], [2, 2], [2, 4]] },
  ray:  { start: r => r[0] === Math.min(1.5, devicePixelRatio || 1), steps: [[.75, 1], [1, 1], [1.5, 1], [2, 1]] },
  pts:  { start: r => r[2] === 1.6e6, steps: [[2, 1, 500e3], [2, 1, 1e6], [2, 1, 1.6e6]] },
  line: { start: () => true, steps: [[1, 1]] },
};

// Returns draw(id, t, [bg, accent, accent2]) or null when WebGL is unavailable.
function Fractals(canvas) {
  const opts = { antialias: true, premultipliedAlpha: false };
  const gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
  if (!gl) return null;
  const gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const byId = Object.fromEntries(FRACTALS.map(f => [f.id, f]));
  const buf = data => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
  const tri = buf(new Float32Array([-1, -1, 3, -1, -1, 3]));             // one triangle covers the screen
  const cache = {};
  let seeds, tone, acc;

  // half-float render target for the point-cloud density map (null → fall back to translucent dots)
  let halfTex = null;
  if (gl2 && (gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')))
    halfTex = (w, h) => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else if (!gl2) {
    const ext = gl.getExtension('OES_texture_half_float');
    gl.getExtension('EXT_color_buffer_half_float');
    if (ext) halfTex = (w, h) => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, ext.HALF_FLOAT_OES, null);
  }
  function accTarget(w, h) {
    if (acc && acc.w === w && acc.h === h) return acc;
    if (!halfTex) return null;
    if (acc) { gl.deleteTexture(acc.tex); gl.deleteFramebuffer(acc.fb); acc = null; }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
                          [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    halfTex(w, h);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) { gl.deleteTexture(tex); gl.deleteFramebuffer(fb); halfTex = null; return null; }
    return (acc = { tex, fb, w, h });
  }

  function compile(vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.bindAttribLocation(p, 0, 'a0'); gl.bindAttribLocation(p, 1, 'a1');
    gl.linkProgram(p);
    const U = {};
    for (const k of ['res', 't', 'scl', 'ctr', 'bg', 'ca', 'cb', 'ss', 'rs', 'ps', 'gain']) U[k] = gl.getUniformLocation(p, k);
    return { p, U };
  }

  function get(f) {
    if (cache[f.id]) return cache[f.id];
    let c;
    if (f.type === 'pts') {
      if (!seeds) { const a = new Float32Array(N_MAX * 2); for (let i = 0; i < a.length; i++) a[i] = Math.random(); seeds = buf(a); }
      c = { acc: compile(PTS_VS(f.glsl), ACC_FS), dots: compile(PTS_VS(f.glsl), PTS_FS(f.alpha)), buf: seeds, mode: gl.POINTS };
      tone ||= compile(FULL_VS, TONE_FS);
    } else if (f.type === 'line') {
      const d = lsys(...f.lsys);
      c = { ...compile(LINE_VS, LINE_FS), buf: buf(d), count: d.length / 3, mode: gl.LINE_STRIP };
    } else {
      c = { ...compile(FULL_VS, HEAD + f.glsl), buf: tri, count: 3, mode: gl.TRIANGLES };
    }
    return (cache[f.id] = c);
  }

  // ---- adaptive quality: judge each ~60-frame window by its median frame time (robust to the jitter
  // of 120 Hz displays), step one level at a time, and never climb back to a level that was too slow ----
  const level = {}, ceil = {}, win = [];
  let lastId, lastT = 0, base = 16.7, coolUntil = 0, fps = 0, first = true;
  const stepsFor = f => {   // ladder for this device: render scale capped at devicePixelRatio, duplicates dropped
    const dpr = devicePixelRatio || 1, seen = new Set();
    return LADDER[f.type].steps.map(([r, ss, n]) => [Math.min(r, dpr), ss, n]).filter(s => !seen.has(s + '') && seen.add(s + ''));
  };
  addEventListener('resize', () => { for (const k in ceil) delete ceil[k]; });
  function tune(f, steps, now) {
    const dt = now - lastT; lastT = now;
    if (f.id !== lastId) { lastId = f.id; win.length = 0; coolUntil = 0; first = true; return; }
    if (dt > 100) return;                                     // tab switch, view transition, hiccup
    win.push(dt);
    if (win.length < (first ? 20 : 60)) return;           // quick first verdict after a switch
    first = false;
    const med = win.sort((a, b) => a - b)[win.length >> 1]; win.length = 0;
    fps = Math.round(1000 / med);
    base = Math.min(base, med);                               // fastest steady cadence seen ≈ display refresh
    if (now < coolUntil) return;
    const L = level[f.id];
    if (med > Math.max(base * 1.5, 20) && L > 0) {            // under ~50 fps: one step down, and remember the limit
      level[f.id] = ceil[f.id] = L - 1; coolUntil = now + 1500;
    } else if (med < base * 1.15 && L < Math.min(steps.length - 1, ceil[f.id] ?? Infinity)) {
      level[f.id] = L + 1; coolUntil = now + 1500;            // on time: try one step higher
    }
  }

  return draw;
  function draw(id, t, [bg, ca, cb]) {
    const f = byId[id];
    canvas.style.display = f && f.type ? '' : 'none';
    if (!f || !f.type) return;
    const steps = stepsFor(f);
    level[f.id] ??= Math.max(0, steps.findIndex(LADDER[f.type].start));
    level[f.id] = Math.min(level[f.id], steps.length - 1);
    tune(f, steps, performance.now());
    const [r, ss, n] = steps[level[f.id]];
    draw.stats = { id, scale: r, samples: ss, points: n, level: level[f.id] + 1 + '/' + steps.length, fps };
    const w = Math.max(1, innerWidth * r | 0), h = Math.max(1, innerHeight * r | 0);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);

    const c = get(f);
    const use = ({ p, U }) => {
      gl.useProgram(p);
      gl.uniform2f(U.res, w, h); gl.uniform1f(U.t, t); gl.uniform1f(U.rs, r); gl.uniform1i(U.ss, ss);
      gl.uniform3fv(U.bg, bg); gl.uniform3fv(U.ca, ca); gl.uniform3fv(U.cb, cb);
      return U;
    };
    const attribs = (b, line) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, line ? 12 : 0, 0);
      if (line) { gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8); }
      else gl.disableVertexAttribArray(1);
    };

    if (f.type === 'pts') {
      const target = accTarget(w, h);
      if (target) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);               // additive: count hits per pixel
        gl.uniform1f(use(c.acc).ps, 1);
        attribs(c.buf); gl.drawArrays(gl.POINTS, 0, n);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.disable(gl.BLEND);
        const U = use(tone);
        gl.uniform1f(U.gain, w * h / n * 1.4);                          // normalize brightness for point count and size
        gl.bindTexture(gl.TEXTURE_2D, target.tex);
        attribs(tri); gl.drawArrays(gl.TRIANGLES, 0, 3);
      } else {
        gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform1f(use(c.dots).ps, 1.5 * r);
        attribs(c.buf); gl.drawArrays(gl.POINTS, 0, Math.min(n, 250e3));
      }
      return;
    }

    const U = use(c);
    if (f.zoom) {
      // ponytail: depth capped ~e^-8 (scale 1e-3) by float32 precision; deeper needs double-float emulation
      // Ease in and back out (no jump on loop). The target stays put on screen because the center
      // slides toward it in proportion to the scale.
      const { home, target, depth } = f.zoom, s = 3 * Math.exp(-depth * (0.5 - 0.5 * Math.cos(t * 0.6)));
      gl.uniform2f(U.ctr, target[0] + (home[0] - target[0]) * s / 3, target[1] + (home[1] - target[1]) * s / 3);
      gl.uniform1f(U.scl, s);
    }
    const line = f.type === 'line';
    attribs(c.buf, line);
    let count = c.count;
    if (line) {
      gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      count = Math.max(2, Math.round(count * (0.02 + 0.98 * (0.5 - 0.5 * Math.cos(t * 0.5)))));
    } else gl.disable(gl.BLEND);
    gl.drawArrays(c.mode, 0, count);
  };
}
