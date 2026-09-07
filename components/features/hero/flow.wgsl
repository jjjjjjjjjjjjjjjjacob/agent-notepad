import { Particle, particleHash, particlePosition } from "./positions.wgsl";

@group(0) @binding(0) var<storage, read_write> particleState: array<Particle>;
@group(0) @binding(1) var<uniform> resolution: vec2f;
@group(0) @binding(2) var<uniform> time: f32;
@group(0) @binding(3) var<uniform> delta: f32;
// Drift, circulation, viscosity, ambient speed.
@group(0) @binding(4) var<uniform> liquid: vec4f;
@group(0) @binding(5) var<uniform> pointer: vec2f;
@group(0) @binding(6) var<uniform> response: f32;
@group(0) @binding(7) var<uniform> count: f32;
@group(0) @binding(8) var<uniform> pointerMotion: vec4f;
// Normalized click position and a one-frame impulse strength.
@group(0) @binding(9) var<uniform> scatter: vec4f;
@group(0) @binding(10) var<uniform> mode: f32;
// Current spatial frequency, fine eddies, pattern evolution.
@group(0) @binding(11) var<uniform> flowShape: vec4f;
// Hover radius, swirl, scatter radius, settling seconds.
@group(0) @binding(12) var<uniform> interaction: vec4f;

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

// The rotated gradient of a smooth noise potential gives a divergence-free
// current: nearby particles share an eddy without collecting around an anchor.
fn curl(p: vec2f) -> vec2f {
  let cell = floor(p);
  let f = fract(p);
  let blend = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let slope = 30.0 * f * f * (f - 1.0) * (f - 1.0);
  let a = hash(cell);
  let b = hash(cell + vec2f(1.0, 0.0));
  let c = hash(cell + vec2f(0.0, 1.0));
  let d = hash(cell + vec2f(1.0, 1.0));
  let gradient = vec2f(
    mix(b - a, d - c, blend.y) * slope.x,
    mix(c - a, d - b, blend.x) * slope.y
  );
  return vec2f(gradient.y, -gradient.x);
}

fn current(position: vec2f) -> vec2f {
  // A slow changing tide and broad recirculation replace the prevailing wind.
  // Neighbors share the same current, without individual speed jitter.
  let p = position * flowShape.x;
  let phase = time * flowShape.z;
  let tide = vec2f(sin(phase * 0.09), cos(phase * 0.07 + 1.3)) * 0.025 * liquid.x;
  let rolls = curl(p * 0.9 + vec2f(-phase * 0.025, phase * 0.018));
  let eddies = curl(p * 1.8 + vec2f(phase * 0.016, -phase * 0.025) + 13.4);
  let detail = mix(0.065, 0.025, liquid.z) * flowShape.y;
  return tide + (rolls * 0.18 + eddies * detail) * liquid.y;
}

@compute @workgroup_size(64)
fn advect(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= u32(count) { return; }
  var state = particleState[id.x];
  // A fixed physical scale keeps currents and interactions consistent as the
  // field grows. Interactions run in real time, even with ambient speed at zero.
  let metric = resolution / 360.0;
  let p = particlePosition(f32(id.x), state, mode, time, resolution) * metric;
  let offset = p - pointer * metric;
  let influence = exp(-dot(offset, offset) / (interaction.x * interaction.x)) * response * pointerMotion.z;
  let tangent = vec2f(-offset.y, offset.x);
  let wake = (tangent * (0.5 + pointerMotion.w * 1.2) * interaction.y
    + pointerMotion.xy * 0.85) * influence;

  // Add momentum once per click. A soft radius and slight variation avoid a
  // rigid expanding ring; velocity decays without pulling dots back to anchors.
  let clickOffset = p - scatter.xy * metric;
  let distance = length(clickOffset);
  let angle = particleHash(f32(id.x) + 43.0) * 6.283185;
  let direction = select(vec2f(cos(angle), sin(angle)),
    clickOffset / max(distance, 0.001), distance > 0.001);
  let falloff = 1.0 - smoothstep(interaction.z * 0.04, interaction.z, distance);
  let impulse = direction * falloff * scatter.z
    * (1.8 + particleHash(f32(id.x) + 71.0) * 1.2);
  let incoming = state.impulse + impulse;
  // Settling controls interaction momentum independently of liquid viscosity.
  state.impulse = mix(incoming, wake, 1.0 - exp(-delta * 6.0 / interaction.w));
  let travel = (incoming + state.impulse) * 0.5 * delta;

  if mode < 0.5 {
    let relaxation = mix(6.0, 2.8, liquid.z);
    let velocity = mix(state.velocity, current(p), 1.0 - exp(-delta * relaxation));
    state.position += ((state.velocity + velocity) * 0.5 * delta * liquid.w + travel) / metric;
    state.velocity = velocity;
    // Recycle beyond faded boundaries, avoiding visible resets.
    state.position = fract((state.position + 0.08) / 1.16) * 1.16 - 0.08;
  } else {
    // The alternate layouts keep their choreography but can be stirred and
    // scattered too. Displacement persists instead of snapping back on exit.
    let moved = (p + travel) / metric;
    let wrapped = fract((moved + 0.08) / 1.16) * 1.16 - 0.08;
    state.displacement += travel + (wrapped - moved) * metric;
  }
  particleState[id.x] = state;
}
