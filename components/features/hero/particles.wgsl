@group(0) @binding(0) var<uniform> resolution: vec2f;
@group(0) @binding(1) var<uniform> time: f32;
@group(0) @binding(2) var<uniform> mode: f32;
@group(0) @binding(3) var<uniform> pointSize: f32;
@group(0) @binding(4) var<uniform> tint: vec4f;
@group(0) @binding(5) var<uniform> pointer: vec2f;
@group(0) @binding(6) var<uniform> response: f32;
@group(0) @binding(7) var<storage, read> particleState: array<vec4f>;
@group(0) @binding(8) var<uniform> pointerMotion: vec4f;
@group(0) @binding(9) var<uniform> optics: vec2f;

fn hash(n: f32) -> f32 { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
fn particlePosition(n: f32) -> vec2f {
  if mode < 0.5 { return particleState[u32(n)].xy; }
  let a = hash(n + 1.0);
  let b = hash(n + 7.0);
  let c = hash(n + 19.0);
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
  let offset = p - pointer;
  p += offset * exp(-dot(offset, offset) * 18.0) * response * pointerMotion.z * 0.12;
  return p;
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) opacity: f32,
  @location(2) screen: vec2f,
  @location(3) light: f32,
  @location(4) color: vec3f,
};
@vertex fn vs_main(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  let corners = array<vec2f, 6>(vec2f(-1.0,-1.0),vec2f(1.0,-1.0),vec2f(-1.0,1.0),vec2f(-1.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,1.0));
  let corner = corners[vertex];
  let n = f32(instance);
  var p = particlePosition(n);
  let offset = (p - pointer) * resolution;
  let incoming = normalize(vec2f(1.0, 0.32 + (pointer.y - 0.5) * 0.14));
  let outgoing = normalize(vec2f(-1.0, 0.10 + pointerMotion.y * 0.025));
  let inDistance = select(10000.0, abs(dot(offset, vec2f(-incoming.y, incoming.x))), dot(offset, incoming) > 0.0);
  let outDistance = select(10000.0, abs(dot(offset, vec2f(-outgoing.y, outgoing.x))), dot(offset, outgoing) > 0.0);
  let beamDistance = min(inDistance, outDistance);
  let illumination = exp(-dot(offset, offset) / 18000.0) * 0.35 + exp(-beamDistance * beamDistance / 400.0) * 0.65;
  let light = illumination * pointerMotion.z
    * optics.x * min(response * 3.0, 1.0);
  let alpha = 0.35 + hash(n + 13.0) * 0.65;
  let radius = pointSize * (0.65 + hash(n + 37.0) * 0.6) * (1.0 + light * 0.7);
  p += corner * radius / resolution;
  // A quiet center keeps the headline and buttons readable in either theme.
  let edgeMask = smoothstep(0.0, 0.07, p.x) * (1.0 - smoothstep(0.93, 1.0, p.x))
    * smoothstep(0.0, 0.08, p.y) * (1.0 - smoothstep(0.92, 1.0, p.y));
  var output: VertexOutput;
  output.position = vec4f(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  output.uv = corner;
  output.opacity = alpha * edgeMask;
  output.screen = p;
  output.light = light;
  let scattered = mix(vec3f(0.24, 0.52, 0.82), vec3f(0.85, 0.94, 1.0), optics.y);
  output.color = mix(tint.rgb, scattered, min(light * 1.5, 1.0));
  return output;
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let alpha = 1.0 - smoothstep(0.3, 1.0, length(input.uv));
  let lowerPage = smoothstep(240.0, 440.0, input.screen.y * resolution.y);
  let side = smoothstep(0.1, mix(0.34, 0.44, lowerPage), abs(input.screen.x - 0.5));
  let textMask = max(side, input.light * mix(0.12, 0.035, lowerPage));
  return vec4f(input.color, min(1.0, alpha * input.opacity * tint.a * textMask * (1.0 + input.light * 2.0)));
}
