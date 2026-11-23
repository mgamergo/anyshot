import type { Rect } from '../shared/geometry';
import { roundMs } from '../shared/perf';
import type { Adjust } from './model';
import type { CensorRenderer } from './render';

const VERTEX = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// One fragment shader, several modes. GLSL ES 1.00 so WebGL1 works too.
const FRAGMENT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_size;
uniform int u_mode;          // 0 adjust, 1 pixelate, 2 blur
uniform vec2 u_dir;          // blur direction in pixels
uniform float u_radius;      // blur radius or pixel block size
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_sharpness;
uniform float u_invert;

vec4 tex(vec2 px) { return texture2D(u_tex, clamp(px / u_size, vec2(0.0), vec2(1.0))); }

void main() {
  vec2 px = v_uv * u_size;
  if (u_mode == 1) {
    vec2 cell = (floor(px / u_radius) + 0.5) * u_radius;
    gl_FragColor = tex(cell);
    return;
  }
  if (u_mode == 2) {
    float sigma = max(u_radius / 2.0, 0.5);
    float step = max(1.0, u_radius / 24.0);
    vec4 sum = vec4(0.0);
    float total = 0.0;
    for (int i = -24; i <= 24; i++) {
      float d = float(i) * step;
      float w = exp(-(d * d) / (2.0 * sigma * sigma));
      sum += tex(px + u_dir * d) * w;
      total += w;
    }
    gl_FragColor = sum / total;
    return;
  }
  vec4 c = tex(px);
  if (u_sharpness > 0.0) {
    vec4 n = tex(px + vec2(0.0, -1.0)) + tex(px + vec2(0.0, 1.0)) + tex(px + vec2(-1.0, 0.0)) + tex(px + vec2(1.0, 0.0));
    c.rgb = c.rgb + u_sharpness * (4.0 * c.rgb - n.rgb) * 0.5;
  }
  c.rgb *= 1.0 + u_brightness; // multiplies, like CSS brightness() in adjustFilter
  c.rgb = (c.rgb - 0.5) * u_contrast + 0.5;
  float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  c.rgb = mix(vec3(luma), c.rgb, u_saturation);
  c.rgb = mix(c.rgb, 1.0 - c.rgb, u_invert);
  gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), c.a);
}`;

type GL = WebGLRenderingContext;

/**
 * GPU image effects: censor (pixelate, blur) and colour adjustments run as
 * fragment shaders, never as CPU pixel loops. Works on the main thread and in
 * workers (OffscreenCanvas). Returns null from `create` if WebGL is missing.
 */
export class GlEffects {
  private readonly canvas: OffscreenCanvas;
  private readonly gl: GL;
  private readonly program: WebGLProgram;
  private readonly textures: [WebGLTexture, WebGLTexture];
  private readonly fbo: WebGLFramebuffer;
  private readonly staging = new OffscreenCanvas(1, 1);

  static lastCreateMs = 0;

  static create(): GlEffects | null {
    const t0 = performance.now();
    try {
      return new GlEffects();
    } catch {
      return null;
    } finally {
      GlEffects.lastCreateMs = roundMs(performance.now() - t0);
    }
  }

  private constructor() {
    this.canvas = new OffscreenCanvas(1, 1);
    const gl = this.canvas.getContext('webgl', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
    }) as GL | null;
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    this.program = link(gl, VERTEX, FRAGMENT);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.useProgram(this.program);
    const loc = gl.getAttribLocation(this.program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.textures = [texture(gl), texture(gl)];
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('No framebuffer');
    this.fbo = fbo;
  }

  censor: CensorRenderer = (source, rect, mode) => {
    if (this.gl.isContextLost()) return null;
    const size = Math.min(rect.width, rect.height);
    const patch =
      mode === 'pixelate'
        ? this.pixelate(source, rect, Math.max(6, Math.round(size / 12)))
        : this.blur(source, rect, Math.max(8, size * 0.12));
    return this.gl.getError() === this.gl.NO_ERROR && !this.gl.isContextLost() ? patch : null;
  };

  pixelate(source: CanvasImageSource, r: Rect, block: number): OffscreenCanvas {
    this.upload(source, r);
    this.draw(r.width, r.height, { mode: 1, radius: block }, null);
    return this.canvas;
  }

  blur(source: CanvasImageSource, r: Rect, radius: number): OffscreenCanvas {
    this.upload(source, r);
    this.draw(r.width, r.height, { mode: 2, radius, dir: [1, 0] }, this.fbo);
    this.draw(r.width, r.height, { mode: 2, radius, dir: [0, 1] }, null, 1);
    return this.canvas;
  }

  adjust(source: CanvasImageSource, width: number, height: number, adj: Adjust, invert: boolean) {
    this.upload(source, { x: 0, y: 0, width, height });
    this.draw(width, height, { mode: 0, adjust: adj, invert }, null);
    return this.canvas;
  }

  private upload(source: CanvasImageSource, r: Rect): void {
    const { gl } = this;
    this.staging.width = r.width;
    this.staging.height = r.height;
    const sctx = this.staging.getContext('2d');
    if (!sctx) throw new Error('2D context unavailable');
    sctx.clearRect(0, 0, r.width, r.height);
    sctx.drawImage(source, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.staging);
  }

  private draw(
    width: number,
    height: number,
    p: { mode: number; radius?: number; dir?: [number, number]; adjust?: Adjust; invert?: boolean },
    target: WebGLFramebuffer | null,
    input: 0 | 1 = 0,
  ): void {
    const { gl, program } = this;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (target) {
      gl.bindTexture(gl.TEXTURE_2D, this.textures[1]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.textures[1],
        0,
      );
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.textures[input]);
    gl.viewport(0, 0, width, height);
    const u = (name: string) => gl.getUniformLocation(program, name);
    const adj = p.adjust ?? { brightness: 0, contrast: 1, saturation: 1, sharpness: 0 };
    gl.uniform1i(u('u_tex'), 0);
    gl.uniform2f(u('u_size'), width, height);
    gl.uniform1i(u('u_mode'), p.mode);
    gl.uniform2f(u('u_dir'), p.dir?.[0] ?? 0, p.dir?.[1] ?? 0);
    gl.uniform1f(u('u_radius'), p.radius ?? 1);
    gl.uniform1f(u('u_brightness'), adj.brightness);
    gl.uniform1f(u('u_contrast'), adj.contrast);
    gl.uniform1f(u('u_saturation'), adj.saturation);
    gl.uniform1f(u('u_sharpness'), adj.sharpness);
    gl.uniform1f(u('u_invert'), p.invert ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

function texture(gl: GL): WebGLTexture {
  const t = gl.createTexture();
  if (!t) throw new Error('No texture');
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function compile(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('No shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compile failed');
  }
  return shader;
}

function link(gl: GL, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('No program');
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? 'Program link failed');
  }
  return program;
}

/** Canvas 2D filter equivalent of the adjust shader, used when WebGL is unavailable (no sharpness). */
export function adjustFilter(adjust: Adjust, invert: boolean): string {
  return [
    `brightness(${1 + adjust.brightness})`,
    `contrast(${adjust.contrast})`,
    `saturate(${adjust.saturation})`,
    invert ? 'invert(1)' : '',
  ]
    .filter(Boolean)
    .join(' ');
}
