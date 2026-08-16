/* ============================================================
   Viscous fluid backdrop — Stam-style incompressible solver.

   Per frame: splat -> curl -> vorticity -> divergence -> pressure
              -> gradient subtract -> advect velocity -> advect dye.

   The dye starts as the site's colour field and is then transported by the
   velocity field, so the pointer bends individual streams instead of
   warping the whole image at once.
   ============================================================ */

window.initFluidBackdrop = function (canvas, onReady) {

    const gl = canvas.getContext('webgl2', {
        alpha: false, depth: false, stencil: false,
        antialias: false, powerPreference: 'high-performance'
    });
    if (!gl) return null;

    // Float render targets are required for the simulation state.
    const ext = gl.getExtension('EXT_color_buffer_float');
    if (!ext) return null;
    gl.getExtension('OES_texture_float_linear');

    const CONF = {
        SIM_RES: 160,
        DYE_RES: 512,             // the paint itself
        /* Transport is now the only visible channel, so the flow has to
           actually carry the paint: enough force and enough persistence to
           move it, but low curl so it never churns. */
        VEL_DISSIPATION: 0.55,
        DYE_DISSIPATION: 0.0,     // no loss — this is what was dimming it
        PRESSURE: 0.80,
        PRESSURE_ITERATIONS: 18,
        CURL: 4,                  // minimal: curl is what made it chaotic
        SPLAT_RADIUS: 0.0030,
        SPLAT_FORCE: 600,
        /* Slow enough that a stroke stays readable before the paint drifts
           back to its original layout. */
        RESEED: 0.003,
        COORD_RELAX: 0.004,       // how fast the water surface un-distorts
        MAX_STROKE: 0.030,        // caps how hard one frame's stroke can hit
        INTRO_SECONDS: 1.0,       // droplets of paint land until the canvas fills
        DROP_COLS: 4,             // one drop per cell, in shuffled order — 8 drops
        DROP_ROWS: 2,
        INK_RADIUS: 0.085         // logo-click drop; randomised 0.5x .. 1.5x
    };

    /* ---------- program helper ---------- */

    function compile(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.warn('fluid shader:', gl.getShaderInfoLog(s), src.slice(0, 200));
            return null;
        }
        return s;
    }

    function program(vsSrc, fsSrc) {
        const vs = compile(gl.VERTEX_SHADER, vsSrc);
        const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
        if (!vs || !fs) return null;
        const p = gl.createProgram();
        gl.attachShader(p, vs);
        gl.attachShader(p, fs);
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
            console.warn('fluid link:', gl.getProgramInfoLog(p));
            return null;
        }
        // cache uniform locations by name
        const u = {};
        const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) {
            const name = gl.getActiveUniform(p, i).name.replace('[0]', '');
            u[name] = gl.getUniformLocation(p, name);
        }
        return { p, u };
    }

    /* ---------- fullscreen triangle ---------- */

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    function blit(target) {
        if (target) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
            gl.viewport(0, 0, target.w, target.h);
        } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, canvas.width, canvas.height);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /* ---------- render targets ---------- */

    function makeFBO(w, h, internal, format, type, filter) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);

        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.viewport(0, 0, w, h);
        gl.clear(gl.COLOR_BUFFER_BIT);

        return {
            tex, fbo, w, h,
            texelX: 1 / w, texelY: 1 / h,
            attach(id) {
                gl.activeTexture(gl.TEXTURE0 + id);
                gl.bindTexture(gl.TEXTURE_2D, tex);
                return id;
            }
        };
    }

    function makeDoubleFBO(w, h, internal, format, type, filter) {
        let a = makeFBO(w, h, internal, format, type, filter);
        let b = makeFBO(w, h, internal, format, type, filter);
        return {
            w, h, texelX: a.texelX, texelY: a.texelY,
            get read() { return a; },
            get write() { return b; },
            swap() { const t = a; a = b; b = t; }
        };
    }

    /* ================= shaders ================= */

    const VERT = `#version 300 es
    precision highp float;
    layout(location = 0) in vec2 a_pos;
    out vec2 vUv; out vec2 vL; out vec2 vR; out vec2 vT; out vec2 vB;
    uniform vec2 u_texel;
    void main() {
        vUv = a_pos * 0.5 + 0.5;
        vL = vUv - vec2(u_texel.x, 0.0);
        vR = vUv + vec2(u_texel.x, 0.0);
        vT = vUv + vec2(0.0, u_texel.y);
        vB = vUv - vec2(0.0, u_texel.y);
        gl_Position = vec4(a_pos, 0.0, 1.0);
    }`;

    const HEAD = `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
    out vec4 o;`;

    /* Inject along the segment prev->point so fast strokes stay continuous. */
    const SPLAT = HEAD + `
    uniform sampler2D u_target;
    uniform float u_aspect, u_radius, u_segment;
    uniform vec3  u_color;
    uniform vec2  u_point, u_prev;

    float sdSeg(vec2 p, vec2 a, vec2 b) {
        vec2 pa = p - a, ba = b - a;
        float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
        return length(pa - ba * h);
    }
    void main() {
        vec2 p = vUv;      p.x *= u_aspect;
        vec2 a = u_prev;   a.x *= u_aspect;
        vec2 b = u_point;  b.x *= u_aspect;
        float d = mix(length(p - b), sdSeg(p, a, b), u_segment);
        float s = exp(-d * d / max(u_radius, 1e-6));
        o = vec4(texture(u_target, vUv).xyz + s * u_color, 1.0);
    }`;

    /* A single point vortex: rotational velocity around a centre, falling off
       as a Gaussian. Superposing several of these with random signs is what
       lets an arbitrary swirl emerge, instead of picking from a few presets. */
    const VORTEX = HEAD + `
    uniform sampler2D u_target;
    uniform vec2  u_center;
    uniform float u_strength, u_radius, u_aspect;
    void main() {
        vec2 p = vUv;       p.x *= u_aspect;
        vec2 c = u_center;  c.x *= u_aspect;
        vec2 d = p - c;
        vec2 rot = vec2(-d.y, d.x) * (u_strength * exp(-dot(d, d) / max(u_radius, 1e-6)));
        o = vec4(texture(u_target, vUv).xy + rot, 0.0, 1.0);
    }`;

    /* Semi-Lagrangian transport: walk backwards along the velocity field. */
    const ADVECT = HEAD + `
    uniform sampler2D u_velocity, u_source;
    uniform vec2  u_texelSource;
    uniform float u_dt, u_dissipation;
    void main() {
        vec2 coord = vUv - u_dt * texture(u_velocity, vUv).xy * u_texelSource;
        vec4 result = texture(u_source, coord);
        o = result / (1.0 + u_dissipation * u_dt);
    }`;

    const CURL = HEAD + `
    uniform sampler2D u_velocity;
    void main() {
        float L = texture(u_velocity, vL).y;
        float R = texture(u_velocity, vR).y;
        float T = texture(u_velocity, vT).x;
        float B = texture(u_velocity, vB).x;
        o = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);
    }`;

    /* Vorticity confinement — puts back the small eddies the solver damps,
       which is what keeps individual filaments legible. */
    const VORTICITY = HEAD + `
    uniform sampler2D u_velocity, u_curl;
    uniform float u_curlStrength, u_dt;
    void main() {
        float L = texture(u_curl, vL).x;
        float R = texture(u_curl, vR).x;
        float T = texture(u_curl, vT).x;
        float B = texture(u_curl, vB).x;
        float C = texture(u_curl, vUv).x;

        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 1e-4;
        force *= u_curlStrength * C;
        force.y *= -1.0;

        vec2 vel = texture(u_velocity, vUv).xy + force * u_dt;
        o = vec4(clamp(vel, -1000.0, 1000.0), 0.0, 1.0);
    }`;

    const DIVERGENCE = HEAD + `
    uniform sampler2D u_velocity;
    void main() {
        float L = texture(u_velocity, vL).x;
        float R = texture(u_velocity, vR).x;
        float T = texture(u_velocity, vT).y;
        float B = texture(u_velocity, vB).y;
        vec2 C = texture(u_velocity, vUv).xy;
        if (vL.x < 0.0) L = -C.x;
        if (vR.x > 1.0) R = -C.x;
        if (vT.y > 1.0) T = -C.y;
        if (vB.y < 0.0) B = -C.y;
        o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }`;

    const CLEAR = HEAD + `
    uniform sampler2D u_tex;
    uniform float u_value;
    void main() { o = u_value * texture(u_tex, vUv); }`;

    const PRESSURE = HEAD + `
    uniform sampler2D u_pressure, u_divergence;
    void main() {
        float L = texture(u_pressure, vL).x;
        float R = texture(u_pressure, vR).x;
        float T = texture(u_pressure, vT).x;
        float B = texture(u_pressure, vB).x;
        float div = texture(u_divergence, vUv).x;
        o = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
    }`;

    const GRADIENT = HEAD + `
    uniform sampler2D u_pressure, u_velocity;
    void main() {
        float L = texture(u_pressure, vL).x;
        float R = texture(u_pressure, vR).x;
        float T = texture(u_pressure, vT).x;
        float B = texture(u_pressure, vB).x;
        vec2 vel = texture(u_velocity, vUv).xy - vec2(R - L, T - B);
        o = vec4(vel, 0.0, 1.0);
    }`;

    /* ---- pigment space ----------------------------------------------------
       The dye is NOT stored as RGB. Advection and reseeding blend texels
       linearly, and linearly averaging two RGB colours desaturates toward
       grey instead of producing a new colour. Instead each texel holds
       (chroma.x, chroma.y, value), where chroma is the hue angle on the
       colour wheel scaled by saturation. Averaging that vector walks the hue
       around the wheel, so two pigments meeting yield the colour between
       them — the way yellow and blue give green. */
    const COLOR_LIB = `
    const float TAU = 6.28318530718;

    vec3 rgb2hsv(vec3 c) {
        vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
        vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
        vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
        float d = q.x - min(q.w, q.y);
        return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
    }
    vec3 hsv2rgb(vec3 c) {
        vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }
    vec3 rgbToPigment(vec3 rgb) {
        vec3 hsv = rgb2hsv(rgb);
        float a = hsv.x * TAU;
        return vec3(cos(a) * hsv.y, sin(a) * hsv.y, hsv.z);
    }
    vec3 pigmentToRgb(vec3 pig) {
        float s = length(pig.xy);
        float h = atan(pig.y, pig.x) / TAU;
        // Mixing shortens the chroma vector; lift it a little so blends stay
        // colourful rather than sliding toward grey.
        return hsv2rgb(vec3(fract(h + 1.0), clamp(s * 1.18, 0.0, 1.0), pig.z));
    }`;

    /* The paint's original layout: purple left, teal right, magenta low. */
    const BASE = HEAD + COLOR_LIB + `
    void main() {
        vec3 col = vec3(0.014, 0.018, 0.036);
        col += smoothstep(0.80, 0.0, length((vUv - vec2(0.24, 0.30)) * vec2(1.5, 1.0))) * vec3(0.42, 0.06, 0.72);
        col += smoothstep(0.76, 0.0, length((vUv - vec2(0.78, 0.36)) * vec2(1.5, 1.0))) * vec3(0.00, 0.46, 0.60);
        col += smoothstep(0.84, 0.0, length((vUv - vec2(0.52, 0.80)) * vec2(1.5, 1.0))) * vec3(0.50, 0.04, 0.24);
        o = vec4(rgbToPigment(col), 1.0);
    }`;

    /* Loading: the canvas starts empty and droplets of paint land on it,
       each one soft-edged so it reads as ink soaking in rather than a stamp. */
    /* A blot outline. The radius is perturbed by angle; the amplitudes and
       frequencies come in per drop, so drops differ in *shape* and not only
       in rotation. Frequencies must stay whole numbers or the outline does
       not close on itself. */
    const BLOB_LIB = `
    uniform vec2  u_point;
    uniform vec3  u_wobAmp, u_wobFreq;
    uniform float u_radius, u_aspect, u_strength, u_seed, u_soft;

    float blobMask(vec2 uv) {
        vec2 p = uv;       p.x *= u_aspect;
        vec2 c = u_point;  c.x *= u_aspect;

        vec2  d   = p - c;
        float ang = atan(d.y, d.x);
        float wob = sin(ang * u_wobFreq.x + u_seed)         * u_wobAmp.x
                  + sin(ang * u_wobFreq.y - u_seed * 1.7)   * u_wobAmp.y
                  + sin(ang * u_wobFreq.z + u_seed * 2.6)   * u_wobAmp.z;

        float r = u_radius * (1.0 + wob);
        return smoothstep(r, r * u_soft, length(d)) * u_strength;
    }`;

    const DROP = HEAD + BLOB_LIB + `
    uniform sampler2D u_dye, u_base;
    void main() {
        float m = blobMask(vUv);
        o = vec4(mix(texture(u_dye, vUv).xyz, texture(u_base, vUv).xyz, m), 1.0);
    }`;

    /* A single drop of an arbitrary colour. Same uneven outline as the intro
       drops, but it stains toward a given ink rather than the palette — the
       reseed pass then dissolves it back over the next few seconds. */
    const INK = HEAD + COLOR_LIB + BLOB_LIB + `
    uniform sampler2D u_dye;
    uniform vec3 u_ink;
    void main() {
        float m = blobMask(vUv);
        o = vec4(mix(texture(u_dye, vUv).xyz, rgbToPigment(u_ink), m), 1.0);
    }`;

    /* ---- flowing surface coordinates --------------------------------------
       The glass pattern is drawn from a coordinate field that is itself
       carried by the current, exactly like the paint. Transporting the
       coordinates makes the surface stretch and swirl with the water.
       (Offsetting them by the velocity instead would raise a lens under the
       cursor — that was the bulge.) */
    const COORD_INIT = HEAD + `
    void main() { o = vec4(vUv, 0.0, 1.0); }`;

    /* Relax the surface back toward an undistorted grid. */
    const COORD_RELAX = HEAD + `
    uniform sampler2D u_coord;
    uniform float u_amount;
    void main() {
        o = vec4(mix(texture(u_coord, vUv).xy, vUv, u_amount), 0.0, 1.0);
    }`;

    /* Ease the paint a hair back toward its original layout each frame. */
    const RESEED = HEAD + `
    uniform sampler2D u_dye, u_base;
    uniform float u_amount;
    void main() {
        o = vec4(mix(texture(u_dye, vUv).rgb, texture(u_base, vUv).rgb, u_amount), 1.0);
    }`;

    /* The approved refraction backdrop — but the colour now comes from the
       advected dye texture instead of a procedural function, so stirring
       genuinely mixes the pigments rather than displacing a fixed pattern. */
    const DISPLAY = HEAD + COLOR_LIB + `
    uniform sampler2D u_dye, u_coord;
    uniform vec2  u_res;
    uniform float u_time, u_energy;

    vec3 paint(vec2 uv) { return pigmentToRgb(texture(u_dye, uv).xyz); }

    float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
    }
    float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i),                 hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
        for (int i = 0; i < 5; i++) { v += a * noise(p); p = rot * p * 2.02; a *= 0.5; }
        return v;
    }
    float glassHeight(vec2 p, float t) {
        vec2 q = vec2(fbm(p + vec2(0.0, t * 0.12)),
                      fbm(p + vec2(3.7, 1.3) - t * 0.09));
        vec2 r = vec2(fbm(p + 2.4 * q + vec2(1.7, 9.2) + t * 0.10),
                      fbm(p + 2.4 * q + vec2(8.3, 2.8) - t * 0.07));
        return fbm(p + 2.6 * r);
    }
    void main() {
        /* vUv and the original gl_FragCoord-based uv are both bottom-up. */
        vec2 uv = vUv;
        float m = min(u_res.x, u_res.y);
        vec2 p  = (vUv - 0.5) * (u_res / m);
        float t = u_time * 0.09;

        /* Draw the surface from coordinates the current has carried, so the
           water stretches and swirls where it was stirred. This is transport,
           not a local offset, so no lens forms under the cursor. */
        vec2 fuv = texture(u_coord, vUv).xy;
        vec2 sp  = (fuv - 0.5) * (u_res / m) * 1.7;

        float e  = 2.0 / m;
        float h  = glassHeight(sp, t);
        float hx = glassHeight(sp + vec2(e, 0.0), t);
        float hy = glassHeight(sp + vec2(0.0, e), t);
        vec3  n  = normalize(vec3(-(hx - h) / e * 0.05, -(hy - h) / e * 0.05, 1.0));

        /* Refract the paint, with per-channel dispersion. Each tap has to be
           decoded out of pigment space before its channel is taken. */
        vec2 off = n.xy * (0.17 + u_energy * 0.06);
        vec3 col;
        col.r = paint(uv + off * 1.00).r;
        col.g = paint(uv + off * 1.11).g;
        col.b = paint(uv + off * 1.24).b;

        vec3 L = normalize(vec3(0.45, 0.80, 0.70));
        col += pow(max(dot(n, L), 0.0), 40.0) * 0.42;
        col += pow(1.0 - n.z, 2.2) * vec3(0.34, 0.42, 0.62) * 0.62;
        col += pow(abs(sin(h * 9.0 + t * 1.5)), 12.0)
             * vec3(0.52, 0.60, 0.86) * (0.26 + u_energy * 0.3);

        col *= 1.0 - 0.315 * pow(length(p) * 0.78, 2.0);
        o = vec4(pow(max(col, 0.0), vec3(0.88)), 1.0);
    }`;

    /* ================= simulation ================= */

    const progs = {
        splat:      program(VERT, SPLAT),
        advect:     program(VERT, ADVECT),
        curl:       program(VERT, CURL),
        vorticity:  program(VERT, VORTICITY),
        divergence: program(VERT, DIVERGENCE),
        clear:      program(VERT, CLEAR),
        pressure:   program(VERT, PRESSURE),
        gradient:   program(VERT, GRADIENT),
        base:       program(VERT, BASE),
        reseed:     program(VERT, RESEED),
        drop:       program(VERT, DROP),
        ink:        program(VERT, INK),
        vortex:     program(VERT, VORTEX),
        coordInit:  program(VERT, COORD_INIT),
        coordRelax: program(VERT, COORD_RELAX),
        display:    program(VERT, DISPLAY)
    };
    for (const k in progs) if (!progs[k]) return null;

    const RG = [gl.RG16F, gl.RG, gl.HALF_FLOAT];
    const R  = [gl.R16F, gl.RED, gl.HALF_FLOAT];
    const RGBA = [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT];

    let dye, baseFBO, coord, velocity, divergenceFBO, curlFBO, pressure;
    let introDone = false;
    let dropped = 0;

    // Every cell gets exactly one drop, visited in random order.
    const dropCells = [];
    for (let cy = 0; cy < CONF.DROP_ROWS; cy++) {
        for (let cx = 0; cx < CONF.DROP_COLS; cx++) dropCells.push({ cx, cy });
    }
    for (let i = dropCells.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [dropCells[i], dropCells[j]] = [dropCells[j], dropCells[i]];
    }
    let simW, simH, dyeW, dyeH;

    function use(prog, texelX, texelY) {
        gl.useProgram(prog.p);
        if (prog.u.u_texel) gl.uniform2f(prog.u.u_texel, texelX, texelY);
        return prog.u;
    }

    function buildTargets() {
        // A viewport can momentarily report zero during a resize; a degenerate
        // aspect ratio there would create zero-size, incomplete framebuffers.
        let ar = canvas.width / canvas.height;
        if (!isFinite(ar) || ar <= 0) ar = 1;

        const px = v => Math.max(2, Math.round(v));
        simW = px(CONF.SIM_RES * (ar > 1 ? ar : 1));
        simH = px(CONF.SIM_RES * (ar > 1 ? 1 : 1 / ar));
        dyeW = px(CONF.DYE_RES * (ar > 1 ? ar : 1));
        dyeH = px(CONF.DYE_RES * (ar > 1 ? 1 : 1 / ar));

        const lin = gl.LINEAR;
        dye      = makeDoubleFBO(dyeW, dyeH, ...RGBA, lin);
        baseFBO  = makeFBO(dyeW, dyeH, ...RGBA, lin);
        velocity = makeDoubleFBO(simW, simH, ...RG, lin);
        pressure = makeDoubleFBO(simW, simH, ...R, gl.NEAREST);
        divergenceFBO = makeFBO(simW, simH, ...R, gl.NEAREST);
        curlFBO       = makeFBO(simW, simH, ...R, gl.NEAREST);

        coord = makeDoubleFBO(dyeW, dyeH, ...RG, lin);

        // Paint the original layout into the reference target.
        use(progs.base, 1 / dyeW, 1 / dyeH);
        blit(baseFBO);

        // On first load the dye stays empty so the intro can fill it. On a
        // later rebuild (a resize) it is seeded full — no replaying the intro.
        if (introDone) {
            use(progs.base, 1 / dyeW, 1 / dyeH);
            blit(dye.write);
            dye.swap();
        }

        // The surface starts as an undistorted grid.
        use(progs.coordInit, 1 / dyeW, 1 / dyeH);
        blit(coord.write);
        coord.swap();
    }

    function disposeTargets() {
        [dye, coord, velocity, pressure].forEach(d => {
            if (!d) return;
            [d.read, d.write].forEach(f => { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fbo); });
        });
        [divergenceFBO, curlFBO, baseFBO].forEach(f => {
            if (!f) return;
            gl.deleteTexture(f.tex);
            gl.deleteFramebuffer(f.fbo);
        });
    }

    const pick = a => a[Math.floor(Math.random() * a.length)];

    /* One drop's outline: phase, edge softness, and the wobble that gives it
       its shape. Whole-number frequencies keep the outline closed. */
    function randomBlob() {
        return {
            seed: Math.random() * 20,
            soft: 0.20 + Math.random() * 0.34,
            freq: [pick([2, 3]), pick([3, 4, 5]), pick([5, 6, 7, 8])],
            amp: [0.05 + Math.random() * 0.15,
                  0.03 + Math.random() * 0.09,
                  0.02 + Math.random() * 0.06]
        };
    }

    function setBlob(u, b, x, y, r, strength) {
        gl.uniform2f(u.u_point, x, y);
        gl.uniform1f(u.u_radius, r);
        gl.uniform1f(u.u_aspect, canvas.width / canvas.height);
        gl.uniform1f(u.u_strength, strength);
        gl.uniform1f(u.u_seed, b.seed);
        gl.uniform1f(u.u_soft, b.soft);
        gl.uniform3f(u.u_wobFreq, b.freq[0], b.freq[1], b.freq[2]);
        gl.uniform3f(u.u_wobAmp, b.amp[0], b.amp[1], b.amp[2]);
    }

    /* The disturbance a landing drop leaves.

       A straight jet always rolls up into a counter-rotating PAIR, so
       randomising only its direction and strength still yields the same
       two-sided shape every time. Real variety needs different force
       *arrangements*, so pick between four: a jet, a one-way vortex, a
       radial burst, and a shear band. */
    const TAU = Math.PI * 2;

    function vortex(cx, cy, radius, strength) {
        const u = use(progs.vortex, velocity.texelX, velocity.texelY);
        gl.uniform1i(u.u_target, velocity.read.attach(0));
        gl.uniform2f(u.u_center, cx, cy);
        gl.uniform1f(u.u_radius, radius);
        gl.uniform1f(u.u_strength, strength);
        gl.uniform1f(u.u_aspect, canvas.width / canvas.height);
        blit(velocity.write);
        velocity.swap();
    }

    /* Scatter point vortices with random count, placement, size, strength and
       spin, then let the solver resolve the superposition. The shape is not
       chosen — it emerges — so this samples a continuous space of swirls
       rather than a handful of presets: sometimes one clean spiral, sometimes
       a counter-rotating pair, a chain, or something with no name. */
    function swirl(x, y, spread) {
        const ar = canvas.width / canvas.height;

        // Anywhere from a single eye to a crowded cluster.
        const n = 1 + Math.floor(Math.random() * 9);

        // Each drop gets its own spin bias: near 0 or 1 the vortices nearly all
        // turn the same way and merge into one big swirl; near 0.5 they fight
        // and break into pairs and chains.
        const bias = Math.random();

        // How far the cluster spreads varies per drop as well.
        const reach = spread * (0.6 + Math.random() * 2.4);

        for (let i = 0; i < n; i++) {
            const th = Math.random() * TAU;
            const off = Math.random() * reach;
            const cx = x + Math.cos(th) * off / ar;
            const cy = y + Math.sin(th) * off;

            // random() squared skews small, so most are tight with the
            // occasional wide one — more varied than a flat range.
            const rad = 0.0005 + Math.random() * Math.random() * 0.0130;
            const str = 180 + Math.random() * Math.random() * 3200;
            vortex(cx, cy, rad, str * (Math.random() < bias ? 1 : -1));
        }

        // Often a drift too, so the whole thing travels while it turns.
        if (Math.random() < 0.55) {
            const a = Math.random() * TAU;
            const f = 30 + Math.random() * 150;
            splat(x, y, x, y, Math.cos(a) * f, Math.sin(a) * f,
                  0.0015 + Math.random() * 0.0055, 0.0);
        }
    }

    /* Push the water along prev -> point. No pigment is added: the pointer
       only stirs the paint that is already there. */
    function splat(x, y, px, py, dx, dy, radius, segment) {
        const u = use(progs.splat, velocity.texelX, velocity.texelY);
        gl.uniform1i(u.u_target, velocity.read.attach(0));
        gl.uniform1f(u.u_aspect, canvas.width / canvas.height);
        gl.uniform2f(u.u_point, x, y);
        gl.uniform2f(u.u_prev, px, py);
        gl.uniform1f(u.u_segment, segment);
        gl.uniform1f(u.u_radius, radius);
        gl.uniform3f(u.u_color, dx, dy, 0.0);
        blit(velocity.write);
        velocity.swap();
    }

    function step(dt) {
        gl.disable(gl.BLEND);

        let u = use(progs.curl, velocity.texelX, velocity.texelY);
        gl.uniform1i(u.u_velocity, velocity.read.attach(0));
        blit(curlFBO);

        u = use(progs.vorticity, velocity.texelX, velocity.texelY);
        gl.uniform1i(u.u_velocity, velocity.read.attach(0));
        gl.uniform1i(u.u_curl, curlFBO.attach(1));
        gl.uniform1f(u.u_curlStrength, CONF.CURL);
        gl.uniform1f(u.u_dt, dt);
        blit(velocity.write);
        velocity.swap();

        u = use(progs.divergence, velocity.texelX, velocity.texelY);
        gl.uniform1i(u.u_velocity, velocity.read.attach(0));
        blit(divergenceFBO);

        u = use(progs.clear, pressure.texelX, pressure.texelY);
        gl.uniform1i(u.u_tex, pressure.read.attach(0));
        gl.uniform1f(u.u_value, CONF.PRESSURE);
        blit(pressure.write);
        pressure.swap();

        u = use(progs.pressure, pressure.texelX, pressure.texelY);
        gl.uniform1i(u.u_divergence, divergenceFBO.attach(0));
        for (let i = 0; i < CONF.PRESSURE_ITERATIONS; i++) {
            gl.uniform1i(u.u_pressure, pressure.read.attach(1));
            blit(pressure.write);
            pressure.swap();
        }

        u = use(progs.gradient, velocity.texelX, velocity.texelY);
        gl.uniform1i(u.u_pressure, pressure.read.attach(0));
        gl.uniform1i(u.u_velocity, velocity.read.attach(1));
        blit(velocity.write);
        velocity.swap();

        // Advect velocity by itself, then the dye by the velocity field.
        u = use(progs.advect, velocity.texelX, velocity.texelY);
        gl.uniform2f(u.u_texelSource, velocity.texelX, velocity.texelY);
        gl.uniform1f(u.u_dt, dt);
        gl.uniform1i(u.u_velocity, velocity.read.attach(0));
        gl.uniform1i(u.u_source, velocity.read.attach(0));
        gl.uniform1f(u.u_dissipation, CONF.VEL_DISSIPATION);
        blit(velocity.write);
        velocity.swap();

        // Carry the paint along the flow. This is the mixing: pigment that
        // lands on another colour stays there.
        u = use(progs.advect, dye.texelX, dye.texelY);
        gl.uniform2f(u.u_texelSource, velocity.texelX, velocity.texelY);
        gl.uniform1f(u.u_dt, dt);
        gl.uniform1i(u.u_velocity, velocity.read.attach(0));
        gl.uniform1i(u.u_source, dye.read.attach(1));
        gl.uniform1f(u.u_dissipation, CONF.DYE_DISSIPATION);
        blit(dye.write);
        dye.swap();

        // Skipped during the intro, or it would flood the empty canvas at once.
        if (introDone) {
            u = use(progs.reseed, dye.texelX, dye.texelY);
            gl.uniform1i(u.u_dye, dye.read.attach(0));
            gl.uniform1i(u.u_base, baseFBO.attach(1));
            gl.uniform1f(u.u_amount, CONF.RESEED);
            blit(dye.write);
            dye.swap();
        }

        // Carry the surface coordinates along the same current, so the water
        // itself stretches and swirls rather than only the pigment.
        u = use(progs.advect, coord.texelX, coord.texelY);
        gl.uniform2f(u.u_texelSource, velocity.texelX, velocity.texelY);
        gl.uniform1f(u.u_dt, dt);
        gl.uniform1i(u.u_velocity, velocity.read.attach(0));
        gl.uniform1i(u.u_source, coord.read.attach(1));
        gl.uniform1f(u.u_dissipation, 0.0);
        blit(coord.write);
        coord.swap();

        u = use(progs.coordRelax, coord.texelX, coord.texelY);
        gl.uniform1i(u.u_coord, coord.read.attach(0));
        gl.uniform1f(u.u_amount, CONF.COORD_RELAX);
        blit(coord.write);
        coord.swap();
    }

    function render(time, energy) {
        const u = use(progs.display, dye.texelX, dye.texelY);
        gl.uniform1i(u.u_dye, dye.read.attach(0));
        gl.uniform1i(u.u_coord, coord.read.attach(1));
        gl.uniform2f(u.u_res, canvas.width, canvas.height);
        gl.uniform1f(u.u_time, time);
        gl.uniform1f(u.u_energy, energy);
        blit(null);
    }

    /* ================= loop ================= */

    const ptr = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, dx: 0, dy: 0, moved: false };
    let accepting = true;

    /* Queued ink drops, so they land one after another instead of at once. */
    const inkQueue = [];

    function hsvToRgb(h, s, v) {
        const i = Math.floor(h * 6);
        const f = h * 6 - i;
        const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
        return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    }

    function pourInk(now) {
        while (inkQueue.length && inkQueue[0].at <= now) {
            const k = inkQueue.shift();
            const u = use(progs.ink, dye.texelX, dye.texelY);
            gl.uniform1i(u.u_dye, dye.read.attach(0));
            gl.uniform3f(u.u_ink, k.c[0], k.c[1], k.c[2]);
            setBlob(u, k.blob, k.x, k.y, k.r, 0.95);
            blit(dye.write);
            dye.swap();

            swirl(k.x, k.y, k.r * 0.4);
        }
    }

    function resizeCanvas() {
        const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
        const w = Math.max(1, Math.floor(window.innerWidth * dpr));
        const h = Math.max(1, Math.floor(window.innerHeight * dpr));
        if (canvas.width === w && canvas.height === h) return false;
        canvas.width = w;
        canvas.height = h;
        return true;
    }

    resizeCanvas();
    buildTargets();
    window.addEventListener('resize', () => {
        if (!resizeCanvas()) return;
        disposeTargets();
        buildTargets();
    });

    const start = performance.now();
    let last = start;
    (function frame(now) {
        const dt = Math.min((now - last) / 1000, 0.0166);
        last = now;

        const t = now * 0.001;

        /* No ambient forcing: the backdrop already drifts on its own inside
           the display shader. Injecting a current here made the whole field
           pour. The water is still until the pointer disturbs it. */

        if (ptr.moved) {
            ptr.moved = false;
            splat(ptr.x, ptr.y, ptr.px, ptr.py,
                  ptr.dx * CONF.SPLAT_FORCE, ptr.dy * CONF.SPLAT_FORCE,
                  CONF.SPLAT_RADIUS, 1.0);
            ptr.px = ptr.x;
            ptr.py = ptr.y;
        }

        step(dt);

        if (!introDone) {
            const elapsed = (now - start) / 1000;

            /* Paced by time, but held back by how far the document actually
               got: the drops stall part-way while the page is still loading
               and only complete once it is ready. */
            const ready = document.readyState;
            const cap = ready === 'complete' ? 1 : ready === 'interactive' ? 0.7 : 0.4;
            const prog = Math.min(elapsed / CONF.INTRO_SECONDS, cap);

            const want = Math.floor(prog * dropCells.length);
            const aspect = canvas.width / canvas.height;

            // Drops land in a shuffled order over a jittered grid. Stratifying
            // them this way means the drops alone cover the canvas — no global
            // flood at the end, which is what read as "it just fills".
            while (dropped < want) {
                const cell = dropCells[dropped];
                const x = (cell.cx + 0.15 + 0.70 * Math.random()) / CONF.DROP_COLS;
                const y = (cell.cy + 0.15 + 0.70 * Math.random()) / CONF.DROP_ROWS;
                const k = dropped / dropCells.length;
                // Fewer, larger drops — the radius has to grow with the cell
                // size or the gaps between cells never close.
                const r = (0.51 + 0.18 * k) * (0.9 + 0.2 * Math.random());

                const d = use(progs.drop, dye.texelX, dye.texelY);
                gl.uniform1i(d.u_dye, dye.read.attach(0));
                gl.uniform1i(d.u_base, baseFBO.attach(1));
                setBlob(d, randomBlob(), x, y, r, 0.9);
                blit(dye.write);
                dye.swap();

                // Intro drops are far bigger than the ink drops, so scale the
                // spread down — at r * 0.5 the vortex ring spans the screen
                // instead of curling inside the drop.
                swirl(x, y, r * 0.10);
                dropped++;
            }

            if (prog >= 1 && dropped >= dropCells.length) {
                introDone = true;
                if (onReady) onReady();
            }
        }

        pourInk(now);
        render(t, window.__bgEnergy || 0);
        requestAnimationFrame(frame);
    })(last);

    return {
        /* clientX/clientY in CSS pixels */
        setPointer(cx, cy) {
            if (!accepting) return;
            const x = cx / window.innerWidth;
            const y = 1 - cy / window.innerHeight;   // GL space is bottom-up

            // Cap a single frame's stroke, so shaking the pointer hard does
            // not fire off a shockwave.
            let dx = x - ptr.x;
            let dy = y - ptr.y;
            const len = Math.hypot(dx, dy);
            if (len > CONF.MAX_STROKE) {
                const k = CONF.MAX_STROKE / len;
                dx *= k;
                dy *= k;
            }

            ptr.dx = dx;
            ptr.dy = dy;
            ptr.x = x;
            ptr.y = y;
            ptr.moved = true;
        },
        /* while a panel is open the pointer belongs to the content */
        setAccepting(v) {
            if (!v) ptr.moved = false;
            accepting = v;
        },

        /* One small, randomly coloured drop at a random spot. It mixes into
           the water and the reseed pass dissolves it within a few seconds. */
        ink() {
            if (!introDone) return;
            inkQueue.push({
                at: performance.now(),
                x: 0.10 + Math.random() * 0.80,
                y: 0.14 + Math.random() * 0.72,
                // 0.5x to 1.5x of the base size.
                r: CONF.INK_RADIUS * (0.5 + Math.random()),
                c: hsvToRgb(Math.random(), 0.85, 0.90),
                blob: randomBlob()
            });
        }
    };
};
