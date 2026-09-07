// Simulation and rendering share the same layout and particle coordinates.
export struct Particle {
  position: vec2f,
  velocity: vec2f,
  displacement: vec2f,
  impulse: vec2f,
};

export fn particleHash(n: f32) -> f32 { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
export fn particlePosition(n: f32, state: Particle, mode: f32, time: f32, resolution: vec2f) -> vec2f {
  if mode < 0.5 { return state.position; }
  let a = particleHash(n + 1.0);
  let b = particleHash(n + 7.0);
  let c = particleHash(n + 19.0);
  let angle = a * 6.283185 + time * (0.06 + c * 0.08);
  var p: vec2f;
  if mode < 1.5 {
    let x = a * 1.2 - 0.1;
    let depth = b * b;
    p = vec2f(x, 0.3 + depth * 0.8 + sin(x * 11.0 + depth * 4.0 + time * 0.7) * 0.14
      + cos(x * 6.0 - depth * 5.0 - time * 0.4) * 0.1);
  } else if mode < 2.5 {
    let ring = floor(b * 4.0);
    let t = angle + ring * 0.8;
    let radius = 0.34 + ring * 0.035 + (c - 0.5) * 0.022;
    p = vec2f(0.5 + cos(t) * radius, 0.5 + sin(t) * (0.18 + ring * 0.035)
      + cos(t) * (ring - 1.5) * 0.17);
  } else {
    let sheet = floor(c * 3.0);
    let page = vec2f(select(0.1, 0.8, a > 0.5) + fract(a * 2.0) * 0.11 + sheet * 0.025,
      b * 0.62 + sheet * 0.07 + 0.08);
    let loose = vec2f(a, b) + vec2f(sin(angle), cos(angle)) * 0.08;
    let assemble = smoothstep(-0.25, 0.6, sin(time * 0.32));
    p = mix(loose, page, assemble);
  }
  return p + state.displacement * 360.0 / resolution;
}
