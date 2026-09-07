import { Particle, particleHash, particlePosition } from "./positions.wgsl";

@group(0) @binding(0) var<uniform> resolution: vec2f;
@group(0) @binding(1) var<uniform> time: f32;
@group(0) @binding(2) var<uniform> mode: f32;
@group(0) @binding(3) var<uniform> pointSize: f32;
@group(0) @binding(4) var<uniform> tint: vec4f;
@group(0) @binding(5) var<uniform> pointer: vec2f;
@group(0) @binding(6) var<uniform> response: f32;
@group(0) @binding(7) var<storage, read> particleState: array<Particle>;
@group(0) @binding(8) var<uniform> pointerMotion: vec4f;
// Size variation, opacity variation, softness, center clarity.
@group(0) @binding(9) var<uniform> appearance: vec4f;
// Pointer radius in CSS pixels and particle emphasis.
@group(0) @binding(10) var<uniform> hover: vec2f;

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
  var p = particlePosition(n, particleState[instance], mode, time, resolution);
  let offset = (p - pointer) * resolution;
  // Only nearby dots respond visually; no separate light or beam geometry.
  let light = exp(-dot(offset, offset) / (hover.x * hover.x * 0.64)) * pointerMotion.z
    * min(response * 2.0, 1.0) * hover.y * 2.0;
  let alpha = 1.0 - appearance.y + particleHash(n + 13.0) * appearance.y;
  let radius = pointSize * (1.0 + (particleHash(n + 37.0) * 2.0 - 1.0) * appearance.x) * (1.0 + light * 0.7);
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
  output.color = tint.rgb;
  return output;
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let alpha = 1.0 - smoothstep(mix(0.9, 0.05, appearance.z), 1.0, length(input.uv));
  let lowerPage = smoothstep(240.0, 440.0, input.screen.y * resolution.y);
  let side = smoothstep(0.1, mix(0.34, 0.44, lowerPage), abs(input.screen.x - 0.5));
  let textMask = mix(1.0, max(side, input.light * mix(0.12, 0.035, lowerPage)), appearance.w);
  return vec4f(input.color, min(1.0, alpha * input.opacity * tint.a * textMask * (1.0 + input.light * 2.0)));
}
