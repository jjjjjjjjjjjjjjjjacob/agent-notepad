@group(0) @binding(0) var<storage, read_write> particleState: array<vec4f>;
@group(0) @binding(1) var<uniform> resolution: vec2f;
@group(0) @binding(2) var<uniform> time: f32;
@group(0) @binding(3) var<uniform> delta: f32;
@group(0) @binding(4) var<uniform> wind: f32;
@group(0) @binding(5) var<uniform> convection: f32;
@group(0) @binding(6) var<uniform> pointer: vec2f;
@group(0) @binding(7) var<uniform> response: f32;
@group(0) @binding(8) var<uniform> count: f32;
@group(0) @binding(9) var<uniform> pointerMotion: vec4f;
@group(0) @binding(10) var<uniform> viscosity: f32;

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

fn current(p: vec2f) -> vec2f {
  // A slow changing tide and broad recirculation replace the prevailing wind.
  // Neighbors share the same current, without individual speed jitter.
  let tide = vec2f(sin(time * 0.09), cos(time * 0.07 + 1.3)) * 0.025 * wind;
  let rolls = curl(p * 0.9 + vec2f(-time * 0.025, time * 0.018));
  let eddies = curl(p * 1.8 + vec2f(time * 0.016, -time * 0.025) + 13.4);
  let detail = mix(0.065, 0.025, viscosity);
  return tide + (rolls * 0.18 + eddies * detail) * convection;
}

@compute @workgroup_size(64)
fn advect(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= u32(count) { return; }
  let state = particleState[id.x];
  // A fixed physical scale keeps the liquid's pace and eddy size stable when
  // the field grows down the page or the browser is resized.
  let metric = resolution / 360.0;
  let p = state.xy * metric;
  let offset = p - pointer * metric;
  let influence = exp(-dot(offset, offset) * 4.5) * response * pointerMotion.z;
  // A broad stirring motion rolls through the liquid with a soft trailing wake.
  let tangent = vec2f(-offset.y, offset.x);
  let wake = (tangent * (0.5 + pointerMotion.w * 1.2)
    + pointerMotion.xy * 0.85) * influence;
  let flowVelocity = current(p) + wake;
  // Relax velocity, never position: particles keep traveling when a gust
  // passes and cannot spring back to a birthplace or a shared hub.
  let relaxation = mix(10.0, 3.5, viscosity);
  let velocity = mix(state.zw, flowVelocity, 1.0 - exp(-delta * relaxation));
  let position = state.xy + (state.zw + velocity) * 0.5 * delta / metric;
  // Recycle beyond the faded canvas edges, avoiding visible resets.
  let wrapped = fract((position + 0.08) / 1.16) * 1.16 - 0.08;
  particleState[id.x] = vec4f(wrapped, velocity);
}
