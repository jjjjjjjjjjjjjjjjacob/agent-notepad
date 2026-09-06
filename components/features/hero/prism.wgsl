@group(0) @binding(0) var<uniform> resolution: vec2f;
@group(0) @binding(1) var<uniform> pointer: vec2f;
@group(0) @binding(2) var<uniform> pointerMotion: vec4f;
@group(0) @binding(3) var<uniform> optics: vec2f;
@group(0) @binding(4) var<uniform> response: f32;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) screen: vec2f,
};

@vertex fn vs_main(@builtin(vertex_index) vertex: u32) -> VertexOutput {
  let vertices = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let p = vertices[vertex];
  var output: VertexOutput;
  output.position = vec4f(p, 0.0, 1.0);
  output.screen = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return output;
}

fn gaussian(distance: f32, width: f32) -> f32 {
  let d = distance / width;
  return exp(-d * d);
}

fn rayCoordinates(offset: vec2f, direction: vec2f) -> vec2f {
  return vec2f(dot(offset, direction), dot(offset, vec2f(-direction.y, direction.x)));
}

@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let pixel = input.screen * resolution;
  let offset = (input.screen - pointer) * resolution;
  // An incident white beam enters from the right, bends at the cursor, and
  // continues across the page. Widths stay in CSS pixels, never a cone angle.
  let incoming = rayCoordinates(offset, normalize(vec2f(1.0, 0.32 + (pointer.y - 0.5) * 0.14)));
  let outgoing = rayCoordinates(offset, normalize(vec2f(-1.0, 0.10 + pointerMotion.y * 0.025)));
  let inGate = smoothstep(-3.0, 4.0, incoming.x);
  let outGate = smoothstep(-3.0, 4.0, outgoing.x);
  let inCore = gaussian(incoming.y, 1.4) * inGate;
  let outCore = gaussian(outgoing.y, 1.5) * outGate;
  let inBloom = (gaussian(incoming.y, 7.0) * 0.5 + gaussian(incoming.y, 26.0) * 0.10) * inGate;
  let distance = max(outgoing.x, 0.0);
  // Dispersion stays tightly bundled around the luminous core. Only the
  // fine colored fringes separate as light travels away from the refraction.
  let split = min(distance * 0.012, 14.0);
  let fringeWidth = 2.0 + min(distance * 0.002, 2.0);
  let spectrum = vec3f(
    gaussian(outgoing.y - split, fringeWidth),
    gaussian(outgoing.y, fringeWidth),
    gaussian(outgoing.y + split, fringeWidth)
  );
  let spectralGlow = vec3f(
    gaussian(outgoing.y - split, 10.0),
    gaussian(outgoing.y, 10.0),
    gaussian(outgoing.y + split, 10.0)
  );
  let outLight = (spectrum * 1.0 + spectralGlow * 0.2) * outGate;
  let focus = gaussian(length(offset), 4.0) * 1.8;
  let light = vec3f(0.93, 0.97, 1.0) * (inCore * 4.0 + outCore * 2.6 + inBloom + focus) + outLight;
  let peak = max(light.r, max(light.g, light.b));
  var color = light / max(peak, 0.001);
  // On a white canvas, a cool refractive halo outlines the white-hot center.
  if optics.y < 0.5 {
    color = mix(color * vec3f(0.30, 0.48, 0.72), vec3f(1.0), min((inCore + outCore + focus) * 0.85, 1.0));
  }
  let side = smoothstep(0.1, 0.42, abs(input.screen.x - 0.5));
  let readingMask = mix(mix(0.55, 1.0, side), mix(0.16, 1.0, side), smoothstep(240.0, 430.0, pixel.y));
  let edge = smoothstep(0.0, 0.025, input.screen.x) * (1.0 - smoothstep(0.975, 1.0, input.screen.x));
  let strength = pointerMotion.z * optics.x * min(response * 3.0, 1.0);
  let alpha = (1.0 - exp(-peak * strength)) * readingMask * edge;
  return vec4f(color, alpha);
}
