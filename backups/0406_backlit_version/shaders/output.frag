precision highp float;

uniform sampler2D uFinalFrame;
uniform vec2 uResolution;

varying vec2 vUv;

void main() {
  vec3 col = texture2D(uFinalFrame, vUv).rgb;

  // Vignette — dolly tunnel vision
  // Heavier at edges to enhance forward motion feel
  vec2 vigUV = vUv * (1.0 - vUv.yx);
  float vig = pow(vigUV.x * vigUV.y * 15.0, 0.35);
  // Extra radial darkening — peripheral fade like tunnel focus
  float radial = length(vUv - 0.5) * 2.0;
  float tunnel = smoothstep(0.5, 1.4, radial);
  col *= vig * (1.0 - tunnel * 0.4);

  // Gamma correction
  col = pow(max(col, 0.0), vec3(0.4545));

  gl_FragColor = vec4(col, 1.0);
}
