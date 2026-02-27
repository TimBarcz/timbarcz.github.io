/**
 * WebGL Fluid Simulation — Background Effect
 *
 * Adapted from Pavel Dobryakov's WebGL-Fluid-Simulation (MIT License)
 * https://github.com/PavelDoGreat/WebGL-Fluid-Simulation
 *
 * Implements a GPU-based Navier-Stokes solver with:
 *   - Advection, divergence, curl, vorticity, pressure, gradient subtraction
 *   - Double-buffered framebuffers (ping-pong)
 *   - Pointer-reactive splats
 */

(function () {
  'use strict';

  const canvas = document.getElementById('fluid-canvas');
  if (!canvas) return;

  const config = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1024,
    DENSITY_DISSIPATION: 1.5,
    VELOCITY_DISSIPATION: 0.6,
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 20,
    CURL: 30,
    SPLAT_RADIUS: 0.3,
    SPLAT_FORCE: 6000,
    COLOR_UPDATE_SPEED: 10,
    BACK_COLOR: { r: 0.02, g: 0.02, b: 0.02 },
    TRANSPARENT: false,
    BLOOM: false,
    PAUSED: false,
  };

  // Accent green palette for splats
  const PALETTE = [
    [0.0, 0.91, 0.43],   // #00e86e
    [0.0, 0.7, 0.35],    // darker green
    [0.0, 0.55, 0.28],   // deep green
    [0.08, 0.95, 0.55],   // bright lime-green
    [0.0, 0.4, 0.2],     // very dark green
  ];

  function getRandomColor () {
    const c = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    return { r: c[0] * 0.25, g: c[1] * 0.25, b: c[2] * 0.25 };
  }

  // ─── WebGL Setup ───────────────────────────────────────────────

  function getWebGLContext (canvas) {
    const params = {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false,
    };

    let gl = canvas.getContext('webgl2', params);
    const isWebGL2 = !!gl;
    if (!isWebGL2) {
      gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
    }
    if (!gl) return null;

    let halfFloat;
    let supportLinearFiltering;

    if (isWebGL2) {
      gl.getExtension('EXT_color_buffer_float');
      supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
    } else {
      halfFloat = gl.getExtension('OES_texture_half_float');
      supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
    }

    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : (halfFloat && halfFloat.HALF_FLOAT_OES);
    let formatRGBA, formatRG, formatR;

    if (isWebGL2) {
      formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
      formatRG   = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
      formatR    = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
    } else {
      formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatRG   = formatRGBA;
      formatR    = formatRGBA;
    }

    return {
      gl,
      ext: {
        formatRGBA,
        formatRG,
        formatR,
        halfFloatTexType,
        supportLinearFiltering,
      },
    };
  }

  function getSupportedFormat (gl, internalFormat, format, type) {
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
      switch (internalFormat) {
        case gl.R16F:    return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
        case gl.RG16F:   return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
        default:         return null;
      }
    }
    return { internalFormat, format };
  }

  function supportRenderTextureFormat (gl, internalFormat, format, type) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(fbo);
    return status === gl.FRAMEBUFFER_COMPLETE;
  }

  const context = getWebGLContext(canvas);
  if (!context) return;

  const { gl, ext } = context;

  function resizeCanvas () {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.floor(canvas.clientWidth * dpr) ||
        canvas.height !== Math.floor(canvas.clientHeight * dpr)) {
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);
      return true;
    }
    return false;
  }

  // ─── Shader Compilation ────────────────────────────────────────

  const baseVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;
    void main () {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `);

  const clearShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    uniform float value;
    void main () {
      gl_FragColor = value * texture2D(uTexture, vUv);
    }
  `);

  const displayShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform vec3 backColor;
    void main () {
      vec3 c = texture2D(uTexture, vUv).rgb;
      gl_FragColor = vec4(c + backColor, 1.0);
    }
  `);

  const splatShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float aspectRatio;
    uniform vec3 color;
    uniform vec2 point;
    uniform float radius;
    void main () {
      vec2 p = vUv - point.xy;
      p.x *= aspectRatio;
      vec3 splat = exp(-dot(p, p) / radius) * color;
      vec3 base = texture2D(uTarget, vUv).xyz;
      gl_FragColor = vec4(base + splat, 1.0);
    }
  `);

  const advectionShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform vec2 dyeTexelSize;
    uniform float dt;
    uniform float dissipation;
    vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
      vec2 st = uv / tsize - 0.5;
      vec2 iuv = floor(st);
      vec2 fuv = fract(st);
      vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
      vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
      vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
      vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
      return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }
    void main () {
      vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
      vec4 result = bilerp(uSource, coord, dyeTexelSize);
      float decay = 1.0 + dissipation * dt;
      gl_FragColor = result / decay;
    }
  `);

  const divergenceShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).x;
      float R = texture2D(uVelocity, vR).x;
      float T = texture2D(uVelocity, vT).y;
      float B = texture2D(uVelocity, vB).y;
      vec2 C = texture2D(uVelocity, vUv).xy;
      if (vL.x < 0.0) L = -C.x;
      if (vR.x > 1.0) R = -C.x;
      if (vT.y > 1.0) T = -C.y;
      if (vB.y < 0.0) B = -C.y;
      float div = 0.5 * (R - L + T - B);
      gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }
  `);

  const curlShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).y;
      float R = texture2D(uVelocity, vR).y;
      float T = texture2D(uVelocity, vT).x;
      float B = texture2D(uVelocity, vB).x;
      float vorticity = R - L - T + B;
      gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
    }
  `);

  const vorticityShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float curl;
    uniform float dt;
    void main () {
      float L = texture2D(uCurl, vL).x;
      float R = texture2D(uCurl, vR).x;
      float T = texture2D(uCurl, vT).x;
      float B = texture2D(uCurl, vB).x;
      float C = texture2D(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001;
      force *= curl * C;
      force.y *= -1.0;
      vec2 vel = texture2D(uVelocity, vUv).xy;
      gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);
    }
  `);

  const pressureShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      float C = texture2D(uPressure, vUv).x;
      float divergence = texture2D(uDivergence, vUv).x;
      float pressure = (L + R + B + T - divergence) * 0.25;
      gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
    }
  `);

  const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      vec2 velocity = texture2D(uVelocity, vUv).xy;
      velocity.xy -= vec2(R - L, T - B);
      gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
  `);

  function compileShader (type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  // ─── Programs ──────────────────────────────────────────────────

  function createProgram (vertexShader, fragmentShader) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      return null;
    }
    return program;
  }

  function Program (vertexShader, fragmentShader) {
    this.program = createProgram(vertexShader, fragmentShader);
    this.uniforms = getUniforms(this.program);
  }

  Program.prototype.bind = function () {
    gl.useProgram(this.program);
  };

  function getUniforms (program) {
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      uniforms[info.name] = gl.getUniformLocation(program, info.name);
    }
    return uniforms;
  }

  const clearProgram            = new Program(baseVertexShader, clearShader);
  const displayProgram          = new Program(baseVertexShader, displayShader);
  const splatProgram            = new Program(baseVertexShader, splatShader);
  const advectionProgram        = new Program(baseVertexShader, advectionShader);
  const divergenceProgram       = new Program(baseVertexShader, divergenceShader);
  const curlProgram             = new Program(baseVertexShader, curlShader);
  const vorticityProgram        = new Program(baseVertexShader, vorticityShader);
  const pressureProgram         = new Program(baseVertexShader, pressureShader);
  const gradientSubtractProgram = new Program(baseVertexShader, gradientSubtractShader);

  // ─── Geometry ──────────────────────────────────────────────────

  const blit = (() => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    return (target) => {
      if (target == null) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };
  })();

  // ─── Framebuffers ──────────────────────────────────────────────

  function createFBO (w, h, internalFormat, format, type, filtering) {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filtering);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filtering);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      texture,
      fbo,
      width: w,
      height: h,
      attach (id) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
    };
  }

  function createDoubleFBO (w, h, internalFormat, format, type, filtering) {
    let fbo1 = createFBO(w, h, internalFormat, format, type, filtering);
    let fbo2 = createFBO(w, h, internalFormat, format, type, filtering);
    return {
      width: w,
      height: h,
      texelSizeX: 1.0 / w,
      texelSizeY: 1.0 / h,
      get read () { return fbo1; },
      set read (v) { fbo1 = v; },
      get write () { return fbo2; },
      set write (v) { fbo2 = v; },
      swap () { const t = fbo1; fbo1 = fbo2; fbo2 = t; },
    };
  }

  function getResolution (resolution) {
    let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspectRatio < 1) aspectRatio = 1.0 / aspectRatio;
    const min = Math.round(resolution);
    const max = Math.round(resolution * aspectRatio);
    return gl.drawingBufferWidth > gl.drawingBufferHeight
      ? { width: max, height: min }
      : { width: min, height: max };
  }

  let dye, velocity, divergence, curl, pressure;

  function initFramebuffers () {
    const simRes = getResolution(config.SIM_RESOLUTION);
    const dyeRes = getResolution(config.DYE_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const rgba    = ext.formatRGBA;
    const rg      = ext.formatRG;
    const r       = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    if (!rgba || !rg) return;

    dye        = createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
    velocity   = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
    divergence = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    curl       = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    pressure   = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
  }

  resizeCanvas();
  initFramebuffers();

  // ─── Pointer Tracking ─────────────────────────────────────────

  const pointers = [{ id: -1, texcoordX: 0, texcoordY: 0, prevTexcoordX: 0, prevTexcoordY: 0, deltaX: 0, deltaY: 0, down: false, moved: false, color: { r: 0, g: 0, b: 0 } }];

  canvas.style.pointerEvents = 'none';

  window.addEventListener('pointermove', (e) => {
    const p = pointers[0];
    p.prevTexcoordX = p.texcoordX;
    p.prevTexcoordY = p.texcoordY;
    p.texcoordX = e.clientX / canvas.clientWidth;
    p.texcoordY = 1.0 - e.clientY / canvas.clientHeight;
    p.deltaX = correctDeltaX(p.texcoordX - p.prevTexcoordX);
    p.deltaY = correctDeltaY(p.texcoordY - p.prevTexcoordY);
    p.moved = Math.abs(p.deltaX) > 0 || Math.abs(p.deltaY) > 0;
    p.down = true;
  });

  window.addEventListener('touchmove', (e) => {
    const touch = e.touches[0];
    const p = pointers[0];
    p.prevTexcoordX = p.texcoordX;
    p.prevTexcoordY = p.texcoordY;
    p.texcoordX = touch.clientX / canvas.clientWidth;
    p.texcoordY = 1.0 - touch.clientY / canvas.clientHeight;
    p.deltaX = correctDeltaX(p.texcoordX - p.prevTexcoordX);
    p.deltaY = correctDeltaY(p.texcoordY - p.prevTexcoordY);
    p.moved = Math.abs(p.deltaX) > 0 || Math.abs(p.deltaY) > 0;
    p.down = true;
  }, { passive: true });

  function correctDeltaX (delta) {
    const aspectRatio = canvas.width / canvas.height;
    return aspectRatio < 1 ? delta * aspectRatio : delta;
  }

  function correctDeltaY (delta) {
    const aspectRatio = canvas.width / canvas.height;
    return aspectRatio > 1 ? delta / aspectRatio : delta;
  }

  // ─── Auto-splats (ambient motion) ─────────────────────────────

  let autoSplatTimer = 0;

  function autoSplat (dt) {
    autoSplatTimer += dt;
    if (autoSplatTimer > 0.4) {
      autoSplatTimer = 0;
      const x = Math.random();
      const y = Math.random();
      const dx = (Math.random() - 0.5) * 0.0003;
      const dy = (Math.random() - 0.5) * 0.0003;
      const color = getRandomColor();
      splat(x, y, dx, dy, color);
    }
  }

  // ─── Simulation Step ──────────────────────────────────────────

  function step (dt) {
    gl.disable(gl.BLEND);

    // Curl
    curlProgram.bind();
    gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    // Vorticity
    vorticityProgram.bind();
    gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    // Divergence
    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    // Clear pressure
    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
    blit(pressure.write);
    pressure.swap();

    // Pressure solve (Jacobi iteration)
    pressureProgram.bind();
    gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    // Gradient subtract
    gradientSubtractProgram.bind();
    gl.uniform2f(gradientSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradientSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradientSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    // Advect velocity
    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!ext.supportLinearFiltering) {
      gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    }
    const velocityId = velocity.read.attach(0);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
    gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write);
    velocity.swap();

    // Advect dye
    gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write);
    dye.swap();
  }

  function render (target) {
    displayProgram.bind();
    gl.uniform3f(displayProgram.uniforms.backColor, config.BACK_COLOR.r, config.BACK_COLOR.g, config.BACK_COLOR.b);
    gl.uniform1i(displayProgram.uniforms.uTexture, dye.read.attach(0));
    blit(target);
  }

  function splat (x, y, dx, dy, color) {
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform3f(splatProgram.uniforms.color, dx * config.SPLAT_FORCE, dy * config.SPLAT_FORCE, 0.0);
    gl.uniform1f(splatProgram.uniforms.radius, correctRadius(config.SPLAT_RADIUS / 100.0));
    blit(velocity.write);
    velocity.swap();

    gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
    blit(dye.write);
    dye.swap();
  }

  function correctRadius (radius) {
    const aspectRatio = canvas.width / canvas.height;
    return aspectRatio > 1 ? radius * aspectRatio : radius;
  }

  // ─── Animation Loop ───────────────────────────────────────────

  let lastTime = Date.now();
  let colorTimer = 0;

  function update () {
    const now = Date.now();
    let dt = (now - lastTime) / 1000;
    dt = Math.min(dt, 0.016667);
    lastTime = now;

    if (resizeCanvas()) {
      initFramebuffers();
    }

    // Pointer splats
    const p = pointers[0];
    if (p.moved) {
      p.moved = false;
      colorTimer += dt * config.COLOR_UPDATE_SPEED;
      p.color = getRandomColor();
      splat(p.texcoordX, p.texcoordY, p.deltaX, p.deltaY, p.color);
    }

    // Ambient splats
    autoSplat(dt);

    step(dt);
    render(null);

    requestAnimationFrame(update);
  }

  // Initial splats
  for (let i = 0; i < 4; i++) {
    const color = getRandomColor();
    const x = Math.random();
    const y = Math.random();
    const dx = (Math.random() - 0.5) * 0.001;
    const dy = (Math.random() - 0.5) * 0.001;
    splat(x, y, dx, dy, color);
  }

  update();
})();
