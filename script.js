/* ============================================================
   CBIGO — fixed-viewport index site
   1. Refraction backdrop (WebGL, 2D fallback)
   2. Cursor
   3. Router
   4. Preloader
   5. Works hover preview
   6. Music
   ============================================================ */

/* ------------------------------------------------------------
   1. Refraction backdrop
   ------------------------------------------------------------ */

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;

#define TRAIL 14

uniform vec2  u_res;
uniform float u_time;
uniform float u_energy;
uniform vec2  u_trail[TRAIL];   /* recent pointer path, newest first */
uniform vec2  u_vel[TRAIL];     /* how the pointer was moving at each sample */
uniform float u_age[TRAIL];     /* 1 = fresh, 0 = fully relaxed */

float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i),                hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
    for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p = rot * p * 2.02;
        a *= 0.5;
    }
    return v;
}

/* The pointer bends the direction of the flow — it does not raise a dome.
   Each sample drags the stream along the way the pointer was travelling and
   adds a little swirl around it; both fade as the sample ages. */
vec2 flowNudge(vec2 p) {
    vec2 nudge = vec2(0.0);
    for (int i = 0; i < TRAIL; i++) {
        vec2 d = p - u_trail[i];
        float f = u_age[i] * exp(-dot(d, d) * 6.0);
        vec2 swirl = vec2(-d.y, d.x);
        nudge += (u_vel[i] * 2.4 + swirl * 0.55) * f;
    }
    return nudge * (1.0 / float(TRAIL)) * 1.5;
}

/* Height field of the glass sheet: fbm warped by fbm, twice.
   Keeps its own slow current; the pointer only steers it. */
float glassHeight(vec2 p, float t) {
    vec2 q = vec2(fbm(p + vec2(0.0, t * 0.12)),
                  fbm(p + vec2(3.7, 1.3) - t * 0.09));
    vec2 r = vec2(fbm(p + 2.4 * q + vec2(1.7, 9.2) + t * 0.10),
                  fbm(p + 2.4 * q + vec2(8.3, 2.8) - t * 0.07));
    return fbm(p + 2.6 * r);
}

/* The colour field sitting behind the glass, drifting on its own current. */
vec3 behind(vec2 uv, float t) {
    vec3 col = vec3(0.014, 0.018, 0.036);

    vec2 c1 = vec2(0.24 + sin(t * 0.42) * 0.10, 0.30 + cos(t * 0.35) * 0.09);
    vec2 c2 = vec2(0.78 + cos(t * 0.31) * 0.09, 0.36 + sin(t * 0.44) * 0.10);
    vec2 c3 = vec2(0.52 + sin(t * 0.27) * 0.12, 0.80 + cos(t * 0.38) * 0.08);

    float a = smoothstep(0.62, 0.0, length((uv - c1) * vec2(1.5, 1.0)));
    float b = smoothstep(0.58, 0.0, length((uv - c2) * vec2(1.5, 1.0)));
    float c = smoothstep(0.66, 0.0, length((uv - c3) * vec2(1.5, 1.0)));

    col += a * vec3(0.42, 0.06, 0.72);
    col += b * vec3(0.00, 0.46, 0.60);
    col += c * vec3(0.50, 0.04, 0.24);
    return col;
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_res.xy;
    float m = min(u_res.x, u_res.y);
    vec2 p  = (gl_FragCoord.xy - 0.5 * u_res.xy) / m;
    float t = u_time * 0.09;

    /* The pointer only steers the current — it is folded into the domain,
       never into the refraction offset, so no dome forms under the cursor. */
    vec2 sp = p * 1.7 + flowNudge(p);

    /* Surface normal from the height field. */
    float e  = 2.0 / m;
    float h  = glassHeight(sp, t);
    float hx = glassHeight(sp + vec2(e, 0.0), t);
    float hy = glassHeight(sp + vec2(0.0, e), t);
    vec3  n  = normalize(vec3(-(hx - h) / e * 0.05, -(hy - h) / e * 0.05, 1.0));

    /* Refract, with per-channel dispersion. */
    vec2 off = n.xy * (0.17 + u_energy * 0.06);
    vec3 col;
    col.r = behind(uv + off * 1.00, t).r;
    col.g = behind(uv + off * 1.11, t).g;
    col.b = behind(uv + off * 1.24, t).b;

    /* Specular glint off the ridges. */
    vec3 L = normalize(vec3(0.45, 0.80, 0.70));
    col += pow(max(dot(n, L), 0.0), 40.0) * 0.42;

    /* Fresnel rim. */
    col += pow(1.0 - n.z, 2.2) * vec3(0.34, 0.42, 0.62) * 0.62;

    /* Caustic banding. */
    col += pow(abs(sin(h * 9.0 + t * 1.5)), 12.0)
         * vec3(0.52, 0.60, 0.86) * (0.26 + u_energy * 0.3);

    /* Vignette + gamma. */
    col *= 1.0 - 0.42 * pow(length(p) * 0.78, 2.0);
    col = pow(max(col, 0.0), vec3(0.88));

    gl_FragColor = vec4(col, 1.0);
}
`;

let backdropCanvas = document.getElementById('backdrop-canvas');
let audioEnergy = 0;

const TRAIL = 14;                                   // must match #define TRAIL
const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

/* Screen px -> the shader's aspect-corrected space:
   p = (fragCoord - 0.5 * res) / min(res), with Y pointing up. */
function toShaderSpace(cx, cy) {
    const w = window.innerWidth, h = window.innerHeight;
    const m = Math.min(w, h);
    return { x: (cx - w / 2) / m, y: (h / 2 - cy) / m };
}

function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn('shader:', gl.getShaderInfoLog(s));
        gl.deleteShader(s);
        return null;
    }
    return s;
}

function initWebGLBackdrop() {
    const gl = backdropCanvas.getContext('webgl', {
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance'
    });
    if (!gl) return false;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.warn('link:', gl.getProgramInfoLog(prog));
        return false;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes    = gl.getUniformLocation(prog, 'u_res');
    const uTime   = gl.getUniformLocation(prog, 'u_time');
    const uEnergy = gl.getUniformLocation(prog, 'u_energy');
    const uTrail  = gl.getUniformLocation(prog, 'u_trail[0]') || gl.getUniformLocation(prog, 'u_trail');
    const uVel    = gl.getUniformLocation(prog, 'u_vel[0]')   || gl.getUniformLocation(prog, 'u_vel');
    const uAge    = gl.getUniformLocation(prog, 'u_age[0]')   || gl.getUniformLocation(prog, 'u_age');

    function resize() {
        // Cap DPR — this shader is fill-rate bound.
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        const w = Math.floor(window.innerWidth * dpr);
        const h = Math.floor(window.innerHeight * dpr);
        if (backdropCanvas.width !== w || backdropCanvas.height !== h) {
            backdropCanvas.width = w;
            backdropCanvas.height = h;
            gl.viewport(0, 0, w, h);
        }
    }
    resize();
    window.addEventListener('resize', resize);

    const trailPos = new Float32Array(TRAIL * 2);
    const trailVel = new Float32Array(TRAIL * 2);
    const trailAge = new Float32Array(TRAIL);
    let head = 0;
    let lastX = 0, lastY = 0;

    const start = performance.now();
    (function frame(now) {
        const t = (now - start) * 0.001;

        // While a panel is open the pointer belongs to the content, so it
        // stops stirring the water and the existing ripples simply settle.
        const panelOpen = document.body.dataset.view !== 'index';

        // Viscous follow — the flow lags behind the cursor.
        pointer.x += (pointer.tx - pointer.x) * 0.16;
        pointer.y += (pointer.ty - pointer.y) * 0.16;

        const vx = pointer.x - lastX;
        const vy = pointer.y - lastY;
        lastX = pointer.x;
        lastY = pointer.y;

        // Existing disturbances relax back into the ambient current.
        for (let i = 0; i < TRAIL; i++) trailAge[i] *= panelOpen ? 0.90 : 0.955;

        if (!panelOpen) {
            // Deposit a sample; only real movement bends the flow, so a resting
            // cursor leaves the water undisturbed.
            head = (head + 1) % TRAIL;
            trailPos[head * 2] = pointer.x;
            trailPos[head * 2 + 1] = pointer.y;
            trailVel[head * 2] = vx;
            trailVel[head * 2 + 1] = vy;
            trailAge[head] = Math.min(1, Math.hypot(vx, vy) * 26);
        }

        gl.uniform2f(uRes, backdropCanvas.width, backdropCanvas.height);
        gl.uniform1f(uTime, t);
        gl.uniform1f(uEnergy, audioEnergy);
        gl.uniform2fv(uTrail, trailPos);
        gl.uniform2fv(uVel, trailVel);
        gl.uniform1fv(uAge, trailAge);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        requestAnimationFrame(frame);
    })(start);

    return true;
}

/* Soft animated-gradient fallback when WebGL is unavailable. */
function initCanvasBackdrop() {
    const ctx = backdropCanvas.getContext('2d');
    let w = 0, h = 0;

    function resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        w = window.innerWidth;
        h = window.innerHeight;
        backdropCanvas.width = Math.floor(w * dpr);
        backdropCanvas.height = Math.floor(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    const blobs = [
        { c: [107, 15, 184], ax: 0.24, ay: 0.30, r: 0.62, s: 0.42 },
        { c: [0, 117, 153],  ax: 0.78, ay: 0.36, r: 0.58, s: 0.31 },
        { c: [128, 10, 61],  ax: 0.52, ay: 0.80, r: 0.66, s: 0.27 }
    ];

    (function frame(now) {
        const t = now * 0.0002;
        ctx.fillStyle = '#05060a';
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'lighter';
        blobs.forEach((b, i) => {
            const x = w * (b.ax + Math.sin(t * b.s * 4 + i) * 0.10);
            const y = h * (b.ay + Math.cos(t * b.s * 3.4 + i) * 0.09);
            const rad = Math.max(w, h) * b.r;
            const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
            g.addColorStop(0, `rgba(${b.c.join(',')},0.5)`);
            g.addColorStop(0.5, `rgba(${b.c.join(',')},0.12)`);
            g.addColorStop(1, 'rgba(5,6,10,0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(x, y, rad, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.globalCompositeOperation = 'source-over';
        requestAnimationFrame(frame);
    })(0);
}

/* Prefer the real fluid simulation; fall back to the procedural refraction
   shader, then to a plain animated gradient. */
let fluid = null;
// revealSite is a hoisted declaration further down; the fluid calls it once
// the paint has finished filling the canvas.
try { fluid = window.initFluidBackdrop(backdropCanvas, revealSite); } catch (e) { fluid = null; }

if (!fluid) {
    // A canvas keeps its first context type, so hand the fallback a fresh one.
    const fresh = backdropCanvas.cloneNode(false);
    backdropCanvas.replaceWith(fresh);
    backdropCanvas = fresh;
    if (!initWebGLBackdrop()) initCanvasBackdrop();
}

/* ------------------------------------------------------------
   2. Cursor
   ------------------------------------------------------------ */

const cursorDot = document.querySelector('.cursor-dot');
const cursorRing = document.querySelector('.cursor-ring');
let mx = window.innerWidth / 2, my = window.innerHeight / 2;
let rx = mx, ry = my;

window.addEventListener('mousemove', (e) => {
    mx = e.clientX;
    my = e.clientY;
    cursorDot.style.transform = `translate(${mx}px, ${my}px) translate(-50%, -50%)`;

    const s = toShaderSpace(mx, my);
    pointer.tx = s.x;
    pointer.ty = s.y;
    if (fluid) fluid.setPointer(mx, my);
});

// Touch drags stir the fluid too.
window.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (!t) return;
    const s = toShaderSpace(t.clientX, t.clientY);
    pointer.tx = s.x;
    pointer.ty = s.y;
    if (fluid) fluid.setPointer(t.clientX, t.clientY);
}, { passive: true });

(function animateCursor() {
    rx += (mx - rx) * 0.14;
    ry += (my - ry) * 0.14;
    cursorRing.style.transform = `translate(${rx}px, ${ry}px) translate(-50%, -50%)`;
    requestAnimationFrame(animateCursor);
})();

document.addEventListener('mouseover', (e) => {
    if (e.target.closest('.hover-target')) document.body.classList.add('hovering');
});
document.addEventListener('mouseout', (e) => {
    if (e.target.closest('.hover-target')) document.body.classList.remove('hovering');
});

/* ------------------------------------------------------------
   3. Router — the index swaps content in place, never scrolls
   ------------------------------------------------------------ */

const PAGES = ['works', 'about', 'research', 'contact'];
const pageEls = {};
PAGES.forEach(p => { pageEls[p] = document.getElementById(`page-${p}`); });
const navLinks = document.querySelectorAll('.index-list a');

function showPage(name) {
    const target = PAGES.includes(name) ? name : 'index';

    Object.entries(pageEls).forEach(([key, el]) => {
        el.classList.toggle('active', key === target);
    });
    navLinks.forEach(a => {
        a.classList.toggle('active', a.dataset.nav === target);
    });
    document.body.dataset.view = target;

    // With a panel open the pointer belongs to the content, not the water.
    if (fluid) fluid.setAccepting(target === 'index');

    // Reset the panel's internal scroll so each page opens at the top.
    if (pageEls[target]) {
        const sc = pageEls[target].querySelector('.page-scroll');
        if (sc) sc.scrollTop = 0;
    }

    // The address bar is deliberately left alone — panels are not routes.

    // rAF, so this is safe on the first call (before updateRail's consts exist).
    requestAnimationFrame(() => requestAnimationFrame(updateRail));
}

document.querySelectorAll('[data-nav]').forEach(a => {
    a.addEventListener('click', (e) => {
        e.preventDefault();
        const want = a.dataset.nav;
        const here = document.body.dataset.view;

        // On the home screen the logo has nothing to navigate to, so it
        // drips ink into the water instead.
        if (want === 'index' && here === 'index') {
            if (fluid) fluid.ink();
            return;
        }

        // Clicking the menu you are already on closes the panel.
        showPage(here === want ? 'index' : want);
    });
});

document.getElementById('close-btn').addEventListener('click', () => showPage('index'));

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') showPage('index');
});

/* Clicking outside the content closes the panel.

   Testing the click target's class fails wherever a full-width layout wrapper
   sits under the pointer (the area beside the Contact photo, for one). So
   instead ask whether the point actually landed on something that draws:
   an element rendering its own text, or an image. Everything else is layout. */
function pointHitsContent(panel, x, y) {
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
        const tag = el.tagName.toLowerCase();
        const draws = tag === 'img' || tag === 'svg' ||
            [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        if (!draws) continue;

        const r = el.getBoundingClientRect();
        if (r.width && r.height && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
            return true;
        }
    }
    return false;
}

document.addEventListener('click', (e) => {
    if (document.body.dataset.view === 'index') return;
    if (e.target.closest('.index, #close-btn, .music-ctrl')) return;

    /* Interactive elements and list rows count as content wherever inside
       them the click lands. Their boxes are wider and taller than the text
       they hold — hit-testing the text alone closed the panel on clicks that
       had in fact landed on a link, or between the columns of a row. */
    if (e.target.closest('a, button, input, textarea, select, label, summary, .area, .pub-item, .cv li')) return;

    const panel = document.querySelector('.page.active');
    if (panel && pointHitsContent(panel, e.clientX, e.clientY)) return;

    showPage('index');
});

// Always open on the index; there are no panel URLs to restore.
showPage('index');

/* ------------------------------------------------------------
   3b. Scroll indicator for the open page
   ------------------------------------------------------------ */

const scrollRail = document.getElementById('scroll-rail');
const scrollThumb = document.getElementById('scroll-thumb');

function activeScroller() {
    const page = document.querySelector('.page.active .page-scroll');
    return page || null;
}

function updateRail() {
    const sc = activeScroller();
    if (!sc) { scrollRail.classList.remove('on'); return; }

    const { scrollTop, scrollHeight, clientHeight } = sc;
    const overflow = scrollHeight - clientHeight;

    if (overflow <= 4) { scrollRail.classList.remove('on'); return; }
    scrollRail.classList.add('on');

    const railH = scrollRail.clientHeight;
    const thumbH = Math.max(26, (clientHeight / scrollHeight) * railH);
    const y = (scrollTop / overflow) * (railH - thumbH);

    scrollThumb.style.height = `${thumbH}px`;
    scrollThumb.style.transform = `translateY(${y}px)`;
}

// The active panel changes on navigation, so rebind on every page show.
document.addEventListener('scroll', updateRail, true);
window.addEventListener('resize', updateRail);
new ResizeObserver(updateRail).observe(document.body);
document.querySelectorAll('.page-scroll').forEach(el => {
    new ResizeObserver(updateRail).observe(el);
});

/* ------------------------------------------------------------
   4. Reveal — the paint filling the canvas *is* the loading screen
   ------------------------------------------------------------ */

function revealSite() {
    document.documentElement.classList.remove('is-loading');
    document.body.classList.remove('is-loading');
}

// If the fluid never started (no WebGL2), don't wait on an intro that will
// never finish — reveal as soon as the page is loaded.
if (!fluid) {
    if (document.readyState === 'complete') revealSite();
    else window.addEventListener('load', revealSite);
}

/* ------------------------------------------------------------
   5. Works hover preview
   ------------------------------------------------------------ */

const hoverImg = document.getElementById('hover-img');
let ix = 0, iy = 0, itx = 0, ity = 0;

/* Decode the previews up front. Swapping to an undecoded image blanks the
   element for a frame, which is what made the change look like a cut. */
document.querySelectorAll('.pub-item[data-img]').forEach(el => {
    const im = new Image();
    im.src = el.dataset.img;
    if (im.decode) im.decode().catch(() => {});
});

document.querySelectorAll('.pub-item').forEach(el => {
    el.addEventListener('mouseenter', () => {
        const src = el.dataset.img;
        if (!src) { hoverImg.classList.remove('show'); return; }

        // Only re-seat the frame when it first appears; moving from one entry
        // to the next swaps the picture in place instead of fading out and
        // flying back in.
        if (!hoverImg.classList.contains('show')) {
            itx = ix = mx;
            ity = iy = my;
        }
        hoverImg.src = src;
        hoverImg.classList.add('show');
    });
    el.addEventListener('mousemove', () => { itx = mx; ity = my; });
});

/* Hide only once the pointer leaves the whole list. */
const pubList = document.querySelector('.pub-list');
if (pubList) pubList.addEventListener('mouseleave', () => hoverImg.classList.remove('show'));

(function animateHoverImg() {
    if (hoverImg.classList.contains('show')) {
        ix += (itx - ix) * 0.09;
        iy += (ity - iy) * 0.09;
        hoverImg.style.left = `${ix}px`;
        hoverImg.style.top = `${iy}px`;
    }
    requestAnimationFrame(animateHoverImg);
})();

/* ------------------------------------------------------------
   6. Music — drives u_energy in the backdrop shader
   ------------------------------------------------------------ */

const bgMusic = document.getElementById('bg-music');
const musicBtn = document.getElementById('music-btn');
const musicIcon = musicBtn.querySelector('i');
const TRACKS = ['./bgm_0.mp3'];

let isPlaying = false;
let audioCtx, analyser, freqData;
let needsSeek = true;      // seek once per track, as soon as a duration exists

/* The track is large, so metadata often is not ready when the user hits play.
   Seek whenever the duration first becomes known, and again at play time. */
function seekRandom() {
    if (!needsSeek) return;
    const d = bgMusic.duration;
    if (!Number.isFinite(d) || d <= 0) return;

    // A host without HTTP range support reports nothing seekable; retry later
    // rather than giving up, so the seek lands as soon as it becomes possible.
    if (!bgMusic.seekable.length || bgMusic.seekable.end(0) <= 0) return;

    bgMusic.currentTime = d * 0.1 + Math.random() * d * 0.8;
    if (bgMusic.currentTime > 0) needsSeek = false;
}

function loadTrack(autoplay) {
    needsSeek = true;
    bgMusic.src = TRACKS[Math.floor(Math.random() * TRACKS.length)];
    bgMusic.load();
    if (autoplay) bgMusic.play().catch(() => {});
}

['loadedmetadata', 'durationchange', 'canplay', 'progress', 'playing']
    .forEach(ev => bgMusic.addEventListener(ev, seekRandom));

loadTrack(false);
bgMusic.addEventListener('ended', () => loadTrack(true));

function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        freqData = new Uint8Array(analyser.frequencyBinCount);
        audioCtx.createMediaElementSource(bgMusic).connect(analyser);
        analyser.connect(audioCtx.destination);

        (function readEnergy() {
            requestAnimationFrame(readEnergy);
            if (isPlaying) {
                analyser.getByteFrequencyData(freqData);
                let bass = 0;
                for (let i = 0; i < 8; i++) bass += freqData[i];
                audioEnergy += ((bass / 8 / 255) - audioEnergy) * 0.18;
            } else {
                audioEnergy *= 0.93;
            }
            window.__bgEnergy = audioEnergy;   // read by the fluid backdrop
        })();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

musicBtn.addEventListener('click', () => {
    initAudio();
    if (isPlaying) {
        bgMusic.pause();
        musicIcon.classList.replace('fa-pause', 'fa-play');
        musicBtn.classList.remove('playing');
    } else {
        seekRandom();                      // in case metadata only just arrived
        bgMusic.play().catch(() => {});
        musicIcon.classList.replace('fa-play', 'fa-pause');
        musicBtn.classList.add('playing');
    }
    isPlaying = !isPlaying;
});
