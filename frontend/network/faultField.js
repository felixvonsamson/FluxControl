import { Geometry, Mesh, Shader } from 'pixi.js';

// The fault line, drawn when a switch splits the real grid into islands.
//
// Ported from the iOS app's FaultField.metal / FaultLineLayer.swift. Per pixel:
//   d_own   = smooth-min distance to the sites (base buses) of the pixel's own island
//   d_other = smooth-min distance to the sites of every other island
// F = d_other - d_own is zero exactly on the Voronoi boundary between the
// islands, so the line, glow and hatched strip are all bands of F. There is
// no polyline anywhere, hence nothing to wobble or seam, and k-way splits
// need no special case.
//
// Two independent knobs:
//  - CORNER_RADIUS (smooth-min k): rounds corners of the boundary.
//  - the band widths: F is not arc-length calibrated, so the shader divides by
//    |grad F| to get a first-order true perpendicular distance in screen px.
//
// The mesh lives in world space, so the vertex position IS the world position
// and the camera needs no handling beyond the zoom (for the pixel-constant
// band widths).

const MAX_SITES = 64;

const CORE_WIDTH = 1.5;    // screen px, half-width of the bright core
const GLOW_RADIUS = 7;     // screen px, e-folding of the halo
const STRIP_WIDTH = 13;    // screen px, half-width of the hatched strip
const CORNER_RADIUS = 35;  // world units, smooth-min k
const FADE_START = 130;    // world units from the nearest bus: drop-off start
const FADE_END = 320;      // ... and end

const vertex = /* glsl */ `
in vec2 aPosition;
out vec2 vWorld;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vWorld = aPosition;
}
`;

const fragment = /* glsl */ `
precision highp float;

#define MAX_SITES ${MAX_SITES}

in vec2 vWorld;
out vec4 finalColor;

uniform vec4 uFaultSites[MAX_SITES];   // x, y, island, unused
uniform float uFaultCount;
uniform float uFaultTime;
uniform float uFaultScale;             // world -> screen px
uniform vec3 uFaultColor;

// Polynomial smooth-min, accumulating value and gradient together.
void sminAccum(inout float d, inout vec2 g, float nd, vec2 ng, float k) {
  float h = clamp(0.5 + 0.5 * (nd - d) / k, 0.0, 1.0);
  d = mix(nd, d, h) - k * h * (1.0 - h);
  g = mix(ng, g, h);
}

void main() {
  int n = int(uFaultCount + 0.5);
  if (n < 2) {
    finalColor = vec4(0.0);
    return;
  }
  vec2 world = vWorld;

  // Pass 1: which island owns this pixel (hard nearest site).
  float nearest = 1e9;
  float own = 0.0;
  for (int i = 0; i < MAX_SITES; i++) {
    if (i >= n) break;
    vec4 s = uFaultSites[i];
    float d = distance(world, s.xy);
    if (d < nearest) {
      nearest = d;
      own = s.z;
    }
  }

  // Pass 2: smooth-min distance and gradient to own island vs the rest.
  float k = ${CORNER_RADIUS.toFixed(1)};
  float dOwn = 1e9;
  float dOther = 1e9;
  vec2 gOwn = vec2(0.0);
  vec2 gOther = vec2(0.0);
  for (int i = 0; i < MAX_SITES; i++) {
    if (i >= n) break;
    vec4 s = uFaultSites[i];
    float d = max(distance(world, s.xy), 1e-4);
    vec2 g = (world - s.xy) / d;
    if (abs(s.z - own) < 0.5) {
      sminAccum(dOwn, gOwn, d, g, k);
    } else {
      sminAccum(dOther, gOther, d, g, k);
    }
  }

  // First-order true distance to the fault, in screen px. The absolute value
  // keeps the field continuous across the hard ownership boundary; the
  // gradient floor stops the far field from re-inflating the band (the
  // drop-off fade owns that region anyway).
  float slope = max(length(gOther - gOwn), 0.3);
  float sd = abs(dOther - dOwn) / slope * uFaultScale;

  float aa = 0.75;  // smoothstep half-width ~ one device pixel
  float core = 1.0 - smoothstep(${CORE_WIDTH.toFixed(2)} - aa, ${CORE_WIDTH.toFixed(2)} + aa, sd);
  float glow = 0.5 * exp(-max(sd - ${CORE_WIDTH.toFixed(2)}, 0.0) / ${GLOW_RADIUS.toFixed(2)});

  // Dead strip: chevron ("hazard tape") hatching fixed in WORLD space. The
  // stripe coordinate is world.x shifted by a triangle wave in world.y, so
  // stripes run at +45 deg in one band and -45 deg in the next, meeting in
  // continuous V's. A fault running along one arm direction still crosses
  // the alternating bands, so no stretch reads as a solid fill.
  float strip = 1.0 - smoothstep(${STRIP_WIDTH.toFixed(2)} - aa, ${STRIP_WIDTH.toFixed(2)} + aa, sd);
  float spacing = 16.0;
  float period = 32.0;                          // chevron wavelength (world units)
  float saw = fract(world.y / period) - 0.5;    // [-0.5, 0.5)
  float chevron = period * (abs(saw) - 0.25);   // triangle wave, slope +-1
  float u = (world.x + chevron) * 0.70710678;
  float tri = abs(fract(u / spacing) - 0.5) * 2.0;
  float e = clamp(1.5 / (spacing * uFaultScale), 0.02, 0.45);
  float hatch = smoothstep(0.5 - e, 0.5 + e, tri);

  float pulse = 0.72 + 0.28 * sin(uFaultTime * 2.4);
  float fade = 1.0 - smoothstep(${FADE_START.toFixed(1)}, ${FADE_END.toFixed(1)}, dOwn);
  float alpha = clamp(core + glow + 0.22 * strip * hatch, 0.0, 1.0) * pulse * fade;

  // Premultiplied, as Pixi's normal blend mode expects.
  finalColor = vec4(uFaultColor * alpha, alpha);
}
`;

let sharedShader = null;

function getShader() {
  if (!sharedShader) {
    sharedShader = Shader.from({
      gl: { vertex, fragment },
      resources: {
        faultUniforms: {
          uFaultSites: { value: new Float32Array(MAX_SITES * 4), type: 'vec4<f32>', size: MAX_SITES },
          uFaultCount: { value: 0, type: 'f32' },
          uFaultTime: { value: 0, type: 'f32' },
          uFaultScale: { value: 1, type: 'f32' },
          uFaultColor: { value: new Float32Array([1, 0, 0]), type: 'vec3<f32>' },
        },
      },
    });
  }
  return sharedShader;
}

/**
 * Build the fault-line mesh for a split grid.
 *
 * @param {{x:number,y:number,island:number}[]} sites  base buses labelled by island
 * @param {number} color  0xRRGGBB fault colour
 * @returns {{ mesh: Mesh, update(seconds: number, cameraScale: number): void }}
 */
export function createFaultField(sites, color) {
  const shader = getShader();
  const uniforms = shader.resources.faultUniforms.uniforms;

  const packed = uniforms.uFaultSites;
  packed.fill(0);
  const count = Math.min(sites.length, MAX_SITES);
  for (let i = 0; i < count; i++) {
    packed[i * 4] = sites[i].x;
    packed[i * 4 + 1] = sites[i].y;
    packed[i * 4 + 2] = sites[i].island;
  }
  uniforms.uFaultCount = count;
  uniforms.uFaultColor = new Float32Array([
    ((color >> 16) & 0xff) / 255,
    ((color >> 8) & 0xff) / 255,
    (color & 0xff) / 255,
  ]);

  // The field is zero beyond the drop-off distance from the grid, so a quad
  // covering the buses plus that margin (and the glow) is enough.
  const pad = FADE_END + 40;
  const xs = sites.map(s => s.x);
  const ys = sites.map(s => s.y);
  const x0 = Math.min(...xs) - pad;
  const x1 = Math.max(...xs) + pad;
  const y0 = Math.min(...ys) - pad;
  const y1 = Math.max(...ys) + pad;

  const geometry = new Geometry({
    attributes: {
      aPosition: new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]),
    },
    indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
  });

  const mesh = new Mesh({ geometry, shader });
  mesh.eventMode = 'none';
  mesh.on('destroyed', () => geometry.destroy());

  return {
    mesh,
    update(seconds, cameraScale) {
      uniforms.uFaultTime = seconds;
      uniforms.uFaultScale = cameraScale;
    },
  };
}
