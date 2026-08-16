/* ============================================================
   Viscous fluid backdrop — Stam-style incompressible solver.

   Per frame: splat -> curl -> vorticity -> divergence -> pressure
              -> gradient subtract -> advect velocity -> advect dye.

   The dye starts as the site's colour field and is then transported by the
   velocity field, so the pointer bends individual streams instead of
   warping the whole image at once.
   ============================================================ */

window.initFluidBackdrop = function (canvas) {

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
        DYE_RES: 256,             // warp-field resolution; low keeps it smooth
        VEL_DISSIPATION: 1.6,     // the flow settles instead of running on
        WARP_DISSIPATION: 0.9,    // how fast a stroke relaxes away
        PRESSURE: 0.80,
        PRESSURE_ITERATIONS: 18,
        CURL: 3.5,                // gentle eddies; high values self-amplify
        SPLAT_RADIUS: 0.0022,
        SPLAT_FORCE: 2600,
        /* The shader domain only spans about +-0.85, so the warp has to stay
           small or the noise field is scrambled into speckle. */
        WARP_INJECT: 0.000175,    // stroke -> warp field
        WARP_SCALE: 1.0,          // warp field -> glass noise domain
        WARP_COLOR: 7.0,          // warp field -> colour field (the visible part)
        MAX_STROKE: 0.030         // caps how hard one frame's stroke can hit
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

    /* The original refraction backdrop, unchanged — except that the fluid's
       warp field is added to the domain, so the water reacts locally while
       the look of the background stays exactly as it was. */
    const DISPLAY = HEAD + `
    uniform sampler2D u_warp;
    uniform vec2  u_res;
    uniform float u_time, u_energy, u_warpScale, u_warpColor;

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
    vec3 behind(vec2 uv, float t) {
        vec3 col = vec3(0.014, 0.018, 0.036);
        vec2 c1 = vec2(0.24 + sin(t * 0.42) * 0.10, 0.30 + cos(t * 0.35) * 0.09);
        vec2 c2 = vec2(0.78 + cos(t * 0.31) * 0.09, 0.36 + sin(t * 0.44) * 0.10);
        vec2 c3 = vec2(0.52 + sin(t * 0.27) * 0.12, 0.80 + cos(t * 0.38) * 0.08);
        col += smoothstep(0.62, 0.0, length((uv - c1) * vec2(1.5, 1.0))) * vec3(0.42, 0.06, 0.72);
        col += smoothstep(0.58, 0.0, length((uv - c2) * vec2(1.5, 1.0))) * vec3(0.00, 0.46, 0.60);
        col += smoothstep(0.66, 0.0, length((uv - c3) * vec2(1.5, 1.0))) * vec3(0.50, 0.04, 0.24);
        return col;
    }

    void main() {
        /* vUv and the original gl_FragCoord-based uv are both bottom-up. */
        vec2 uv = vUv;
        float m = min(u_res.x, u_res.y);
        vec2 p  = (vUv - 0.5) * (u_res / m);
        float t = u_time * 0.09;

        /* A local, fluid-transported displacement. Clamped so that violently
           shaking the pointer cannot blow the image apart. */
        vec2 w = texture(u_warp, vUv).xy * u_warpScale;
        w = clamp(w, vec2(-0.09), vec2(0.09));

        /* The warp moves the glass AND the colour field underneath it, so the
           background itself deforms rather than gaining an overlaid layer.
           The colour needs the larger share to actually read as movement. */
        vec2 sp  = p * 1.7 + w;
        vec2 uvW = uv + w * u_warpColor;

        float e  = 2.0 / m;
        float h  = glassHeight(sp, t);
        float hx = glassHeight(sp + vec2(e, 0.0), t);
        float hy = glassHeight(sp + vec2(0.0, e), t);
        vec3  n  = normalize(vec3(-(hx - h) / e * 0.05, -(hy - h) / e * 0.05, 1.0));

        vec2 off = n.xy * (0.17 + u_energy * 0.06);
        vec3 col;
        col.r = behind(uvW + off * 1.00, t).r;
        col.g = behind(uvW + off * 1.11, t).g;
        col.b = behind(uvW + off * 1.24, t).b;

        vec3 L = normalize(vec3(0.45, 0.80, 0.70));
        col += pow(max(dot(n, L), 0.0), 40.0) * 0.42;
        col += pow(1.0 - n.z, 2.2) * vec3(0.34, 0.42, 0.62) * 0.62;
        col += pow(abs(sin(h * 9.0 + t * 1.5)), 12.0)
             * vec3(0.52, 0.60, 0.86) * (0.26 + u_energy * 0.3);

        col *= 1.0 - 0.42 * pow(length(p) * 0.78, 2.0);
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
        display:    program(VERT, DISPLAY)
    };
    for (const k in progs) if (!progs[k]) return null;

    const RG = [gl.RG16F, gl.RG, gl.HALF_FLOAT];
    const R  = [gl.R16F, gl.RED, gl.HALF_FLOAT];

    let warp, velocity, divergenceFBO, curlFBO, pressure;
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
        // The warp field starts at zero, so the backdrop opens exactly as before.
        warp     = makeDoubleFBO(dyeW, dyeH, ...RG, lin);
        velocity = makeDoubleFBO(simW, simH, ...RG, lin);
        pressure = makeDoubleFBO(simW, simH, ...R, gl.NEAREST);
        divergenceFBO = makeFBO(simW, simH, ...R, gl.NEAREST);
        curlFBO       = makeFBO(simW, simH, ...R, gl.NEAREST);
    }

    function disposeTargets() {
        [warp, velocity, pressure].forEach(d => {
            if (!d) return;
            [d.read, d.write].forEach(f => { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fbo); });
        });
        [divergenceFBO, curlFBO].forEach(f => {
            if (!f) return;
            gl.deleteTexture(f.tex);
            gl.deleteFramebuffer(f.fbo);
        });
    }

    /* Inject along prev -> point, into velocity and (optionally) the warp
       field that the display shader reads. */
    function splat(x, y, px, py, dx, dy, radius, segment, warpAmount) {
        const aspect = canvas.width / canvas.height;

        let u = use(progs.splat, velocity.texelX, velocity.texelY);
        gl.uniform1i(u.u_target, velocity.read.attach(0));
        gl.uniform1f(u.u_aspect, aspect);
        gl.uniform2f(u.u_point, x, y);
        gl.uniform2f(u.u_prev, px, py);
        gl.uniform1f(u.u_segment, segment);
        gl.uniform1f(u.u_radius, radius);
        gl.uniform3f(u.u_color, dx, dy, 0.0);
        blit(velocity.write);
        velocity.swap();

        if (!warpAmount) return;
        u = use(progs.splat, warp.texelX, warp.texelY);
        gl.uniform1i(u.u_target, warp.read.attach(0));
        gl.uniform1f(u.u_aspect, aspect);
        gl.uniform2f(u.u_point, x, y);
        gl.uniform2f(u.u_prev, px, py);
        gl.uniform1f(u.u_segment, segment);
        gl.uniform1f(u.u_radius, radius);
        gl.uniform3f(u.u_color, dx * warpAmount, dy * warpAmount, 0.0);
        blit(warp.write);
        warp.swap();
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

        // Transport the warp field along the flow — this is what stretches a
        // stroke into filaments instead of a single blob.
        u = use(progs.advect, warp.texelX, warp.texelY);
        gl.uniform2f(u.u_texelSource, velocity.texelX, velocity.texelY);
        gl.uniform1f(u.u_dt, dt);
        gl.uniform1i(u.u_velocity, velocity.read.attach(0));
        gl.uniform1i(u.u_source, warp.read.attach(1));
        gl.uniform1f(u.u_dissipation, CONF.WARP_DISSIPATION);
        blit(warp.write);
        warp.swap();
    }

    function render(time, energy) {
        const u = use(progs.display, warp.texelX, warp.texelY);
        gl.uniform1i(u.u_warp, warp.read.attach(0));
        gl.uniform2f(u.u_res, canvas.width, canvas.height);
        gl.uniform1f(u.u_time, time);
        gl.uniform1f(u.u_energy, energy);
        gl.uniform1f(u.u_warpScale, CONF.WARP_SCALE);
        gl.uniform1f(u.u_warpColor, CONF.WARP_COLOR);
        blit(null);
    }

    /* ================= loop ================= */

    const ptr = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, dx: 0, dy: 0, moved: false };
    let accepting = true;

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

    let last = performance.now();
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
                  CONF.SPLAT_RADIUS, 1.0, CONF.WARP_INJECT);
            ptr.px = ptr.x;
            ptr.py = ptr.y;
        }

        step(dt);
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
        }
    };
};
