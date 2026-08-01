// 0. Reset Scroll Position on Reload
if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
}
window.scrollTo(0, 0);

// Square custom scrollbar (native UI differs between browsers/OSes)
const customScrollbar = document.querySelector('.custom-scrollbar');
const customScrollbarThumb = document.querySelector('.custom-scrollbar-thumb');
let scrollbarThumbHeight = 0;

function updateCustomScrollbar() {
    const viewportHeight = window.innerHeight;
    const pageHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight
    );
    const maxScroll = pageHeight - viewportHeight;

    if (maxScroll <= 0) {
        customScrollbar.hidden = true;
        return;
    }

    customScrollbar.hidden = false;
    scrollbarThumbHeight = Math.max(40, (viewportHeight / pageHeight) * viewportHeight);
    const maxThumbTop = viewportHeight - scrollbarThumbHeight;
    const thumbTop = (window.scrollY / maxScroll) * maxThumbTop;

    customScrollbarThumb.style.height = `${scrollbarThumbHeight}px`;
    customScrollbarThumb.style.transform = `translateY(${thumbTop}px)`;
}

let isDraggingScrollbar = false;
let scrollbarDragStartY = 0;
let scrollbarDragStartScroll = 0;

customScrollbarThumb.addEventListener('pointerdown', (event) => {
    isDraggingScrollbar = true;
    scrollbarDragStartY = event.clientY;
    scrollbarDragStartScroll = window.scrollY;
    customScrollbarThumb.setPointerCapture(event.pointerId);
    event.preventDefault();
});

customScrollbarThumb.addEventListener('pointermove', (event) => {
    if (!isDraggingScrollbar) return;

    const pageHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight
    );
    const maxScroll = pageHeight - window.innerHeight;
    const maxThumbTop = window.innerHeight - scrollbarThumbHeight;

    if (maxThumbTop > 0) {
        const scrollDelta = (event.clientY - scrollbarDragStartY) * (maxScroll / maxThumbTop);
        window.scrollTo(0, scrollbarDragStartScroll + scrollDelta);
    }
    event.preventDefault();
});

function stopScrollbarDrag(event) {
    if (!isDraggingScrollbar) return;
    isDraggingScrollbar = false;
    if (customScrollbarThumb.hasPointerCapture(event.pointerId)) {
        customScrollbarThumb.releasePointerCapture(event.pointerId);
    }
}

customScrollbarThumb.addEventListener('pointerup', stopScrollbarDrag);
customScrollbarThumb.addEventListener('pointercancel', stopScrollbarDrag);

customScrollbar.addEventListener('pointerdown', (event) => {
    if (event.target === customScrollbarThumb) return;
    const maxThumbTop = window.innerHeight - scrollbarThumbHeight;
    if (maxThumbTop <= 0) return;

    const targetThumbTop = Math.max(
        0,
        Math.min(maxThumbTop, event.clientY - (scrollbarThumbHeight / 2))
    );
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, (targetThumbTop / maxThumbTop) * maxScroll);
});

window.addEventListener('scroll', updateCustomScrollbar, { passive: true });
window.addEventListener('resize', updateCustomScrollbar);
window.addEventListener('load', updateCustomScrollbar);
new ResizeObserver(updateCustomScrollbar).observe(document.documentElement);
updateCustomScrollbar();

// 1. Custom Cursor & Magnetic effect
const cursorDot = document.querySelector('.cursor-dot');
const cursorRing = document.querySelector('.cursor-ring');
let mouseX = 0, mouseY = 0, ringX = 0, ringY = 0;

window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX; mouseY = e.clientY;
    cursorDot.style.left = `${mouseX}px`;
    cursorDot.style.top = `${mouseY}px`;
});

function animateCursor() {
    ringX += (mouseX - ringX) * 0.15;
    ringY += (mouseY - ringY) * 0.15;
    cursorRing.style.left = `${ringX}px`;
    cursorRing.style.top = `${ringY}px`;
    requestAnimationFrame(animateCursor);
}
animateCursor();

document.querySelectorAll('.hover-target').forEach(el => {
    el.addEventListener('mouseenter', () => document.body.classList.add('hovering'));
    el.addEventListener('mouseleave', () => document.body.classList.remove('hovering'));
});

// 1-1. Organic 3D Point Cloud Background
const particleCanvas = document.getElementById('particle-bg');
const particleCtx = particleCanvas.getContext('2d', { alpha: true });
let particleW = 0;
let particleH = 0;
let particleDpr = 1;
let scrollHue = 0;
let audioEnergy = 0;
let pointClouds = [];
let ambientPoints = [];

const cloudPresets = [
    { color: [189, 0, 255], phase: 0.2, radius: 0.36, speed: 0.34, anchorX: 0.20, anchorY: 0.24, travelX: 0.16, travelY: 0.18 },
    { color: [0, 240, 255], phase: 2.4, radius: 0.32, speed: 0.28, anchorX: 0.78, anchorY: 0.34, travelX: 0.15, travelY: 0.16 },
    { color: [255, 0, 85], phase: 4.6, radius: 0.42, speed: 0.23, anchorX: 0.48, anchorY: 0.74, travelX: 0.18, travelY: 0.15 }
];

function makeCloudPoints(count, seed) {
    const points = [];
    for (let i = 0; i < count; i++) {
        const u = Math.random();
        const v = Math.random();
        const theta = Math.acos(2 * u - 1);
        const phi = Math.PI * 2 * v;
        const shellBias = Math.random();
        const radius = shellBias > 0.38
            ? 0.82 + Math.random() * 0.22
            : Math.pow(Math.random(), 0.42) * 0.82;

        points.push({
            theta,
            phi,
            radius,
            seed: seed + Math.random() * 20,
            orbit: (Math.random() - 0.5) * 0.36,
            driftSpeed: 0.55 + Math.random() * 1.25,
            driftAmp: 0.025 + Math.random() * 0.08,
            depthPulse: Math.random() * Math.PI * 2,
            sparkle: Math.random() > 0.975
        });
    }
    return points;
}

function makeAmbientPoints(count) {
    return Array.from({ length: count }, (_, index) => ({
        x: Math.random(),
        y: Math.random(),
        z: Math.random(),
        size: 0.45 + Math.random() * 1.9,
        speed: 0.012 + Math.random() * 0.032,
        phase: Math.random() * Math.PI * 2,
        color: cloudPresets[index % cloudPresets.length].color
    }));
}

function resizeParticleCanvas() {
    particleDpr = Math.min(window.devicePixelRatio || 1, 2);
    particleW = window.innerWidth;
    particleH = window.innerHeight;
    particleCanvas.width = Math.floor(particleW * particleDpr);
    particleCanvas.height = Math.floor(particleH * particleDpr);
    particleCanvas.style.width = `${particleW}px`;
    particleCanvas.style.height = `${particleH}px`;
    particleCtx.setTransform(particleDpr, 0, 0, particleDpr, 0, 0);

    const pointCount = particleW < 700 ? 980 : 1680;
    pointClouds = cloudPresets.map((preset, index) => ({
        ...preset,
        points: makeCloudPoints(pointCount + index * 240, index * 7.7)
    }));
    ambientPoints = makeAmbientPoints(particleW < 700 ? 90 : 180);
}

function projectPoint(point, cloud, time, scaleBase) {
    const localTheta = point.theta + Math.sin(time * point.driftSpeed + point.seed) * 0.11;
    const localPhi = point.phi + time * point.orbit + Math.cos(time * (point.driftSpeed * 0.8) + point.seed) * 0.16;
    const wobble =
        1
        + Math.sin(localTheta * 3.1 + time * 1.05 + point.seed) * 0.12
        + Math.cos(localPhi * 2.4 - time * 0.82 + cloud.phase) * 0.10
        + Math.sin((localTheta + localPhi) * 4.2 + time * 0.48) * 0.06
        + Math.sin(time * point.driftSpeed + point.depthPulse) * point.driftAmp;

    const r = point.radius * wobble * scaleBase;
    let x = Math.sin(localTheta) * Math.cos(localPhi) * r;
    let y = Math.sin(localTheta) * Math.sin(localPhi) * r;
    let z = Math.cos(localTheta) * r;

    x += Math.sin(time * point.driftSpeed + point.seed * 1.7) * scaleBase * point.driftAmp;
    y += Math.cos(time * (point.driftSpeed * 0.7) + point.seed) * scaleBase * point.driftAmp;
    z += Math.sin(time * (point.driftSpeed * 0.5) + point.depthPulse) * scaleBase * point.driftAmp * 1.4;

    const rotY = time * cloud.speed + cloud.phase;
    const rotX = time * 0.14 + cloud.phase * 0.5;
    const cy = Math.cos(rotY);
    const sy = Math.sin(rotY);
    const cx = Math.cos(rotX);
    const sx = Math.sin(rotX);

    const x1 = x * cy - z * sy;
    const z1 = x * sy + z * cy;
    const y1 = y * cx - z1 * sx;
    const z2 = y * sx + z1 * cx;
    return { x: x1, y: y1, z: z2 };
}

function drawAmbientField(time) {
    particleCtx.save();
    particleCtx.globalCompositeOperation = 'lighter';
    ambientPoints.forEach(point => {
        const driftX = Math.sin(time * point.speed + point.phase) * particleW * 0.035;
        const driftY = Math.cos(time * point.speed * 1.7 + point.phase) * particleH * 0.045;
        const x = ((point.x * particleW + driftX + particleW) % particleW);
        const y = ((point.y * particleH + driftY + particleH) % particleH);
        const alpha = 0.026 + point.z * 0.045;
        particleCtx.fillStyle = `rgba(${point.color.join(',')}, ${alpha})`;
        particleCtx.beginPath();
        particleCtx.arc(x, y, point.size, 0, Math.PI * 2);
        particleCtx.fill();
    });
    particleCtx.restore();
}

function drawMovingColorWash(centers, time) {
    particleCtx.save();
    particleCtx.globalCompositeOperation = 'lighter';
    centers.forEach((center, index) => {
        const reach = Math.max(particleW, particleH) * (0.58 + index * 0.08);
        const breathing = 1 + Math.sin(time * (0.72 + index * 0.12) + index) * 0.08;
        const gradient = particleCtx.createRadialGradient(
            center.x,
            center.y,
            0,
            center.x,
            center.y,
            reach * breathing
        );
        gradient.addColorStop(0, `rgba(${center.color.join(',')}, ${0.12 + audioEnergy * 0.08})`);
        gradient.addColorStop(0.38, `rgba(${center.color.join(',')}, ${0.052 + audioEnergy * 0.04})`);
        gradient.addColorStop(0.72, `rgba(${center.color.join(',')}, 0.015)`);
        gradient.addColorStop(1, 'rgba(3,3,3,0)');
        particleCtx.fillStyle = gradient;
        particleCtx.beginPath();
        particleCtx.arc(center.x, center.y, reach * breathing, 0, Math.PI * 2);
        particleCtx.fill();
    });

    const veil = particleCtx.createLinearGradient(
        particleW * (0.1 + Math.sin(time * 0.3) * 0.08),
        0,
        particleW * (0.9 + Math.cos(time * 0.24) * 0.08),
        particleH
    );
    veil.addColorStop(0, 'rgba(255,255,255,0)');
    veil.addColorStop(0.5, 'rgba(255,255,255,0.025)');
    veil.addColorStop(1, 'rgba(255,255,255,0)');
    particleCtx.fillStyle = veil;
    particleCtx.fillRect(0, 0, particleW, particleH);
    particleCtx.restore();
}

function drawCloudRibbons(centers, time) {
    particleCtx.save();
    particleCtx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < centers.length; i++) {
        const a = centers[i];
        const b = centers[(i + 1) % centers.length];
        const gradient = particleCtx.createLinearGradient(a.x, a.y, b.x, b.y);
        gradient.addColorStop(0, `rgba(${a.color.join(',')}, 0.09)`);
        gradient.addColorStop(0.5, 'rgba(255,255,255,0.045)');
        gradient.addColorStop(1, `rgba(${b.color.join(',')}, 0.09)`);
        particleCtx.strokeStyle = gradient;
        particleCtx.lineWidth = 1.2 + audioEnergy * 3.4;
        particleCtx.beginPath();
        particleCtx.moveTo(a.x, a.y);
        particleCtx.bezierCurveTo(
            particleW * (0.34 + Math.sin(time + i) * 0.08),
            particleH * (0.22 + Math.cos(time * 0.7 + i) * 0.22),
            particleW * (0.66 + Math.cos(time * 0.8 + i) * 0.08),
            particleH * (0.76 + Math.sin(time * 0.6 + i) * 0.18),
            b.x,
            b.y
        );
        particleCtx.stroke();
    }
    particleCtx.restore();
}

function drawParticleBackground(now) {
    const time = now * 0.00042;

    particleCtx.clearRect(0, 0, particleW, particleH);
    particleCtx.globalCompositeOperation = 'source-over';
    particleCtx.fillStyle = '#030303';
    particleCtx.fillRect(0, 0, particleW, particleH);

    const centers = pointClouds.map((cloud, index) => {
        const t = time + cloud.phase;
        return {
            x: particleW * (
                cloud.anchorX
                + Math.sin(t * (0.95 + index * 0.08)) * cloud.travelX
                + Math.cos(t * 0.41 + cloud.phase) * cloud.travelX * 0.55
            ),
            y: particleH * (
                cloud.anchorY
                + Math.cos(t * (0.78 + index * 0.07)) * cloud.travelY
                + Math.sin(t * 0.49 + cloud.phase * 1.4) * cloud.travelY * 0.52
            ),
            color: cloud.color
        };
    });

    drawMovingColorWash(centers, time);
    drawAmbientField(time);
    drawCloudRibbons(centers, time);

    pointClouds.forEach((cloud, cloudIndex) => {
        const center = centers[cloudIndex];
        const baseSize = Math.max(particleW, particleH) * cloud.radius * (1 + audioEnergy * 0.12);
        const halo = particleCtx.createRadialGradient(center.x, center.y, 0, center.x, center.y, baseSize * 1.08);
        halo.addColorStop(0, `rgba(${cloud.color.join(',')}, ${0.055 + audioEnergy * 0.07})`);
        halo.addColorStop(0.48, `rgba(${cloud.color.join(',')}, ${0.026 + audioEnergy * 0.026})`);
        halo.addColorStop(1, 'rgba(3,3,3,0)');
        particleCtx.fillStyle = halo;
        particleCtx.beginPath();
        particleCtx.arc(center.x, center.y, baseSize * 1.08, 0, Math.PI * 2);
        particleCtx.fill();

        particleCtx.globalCompositeOperation = 'lighter';
        cloud.points.forEach(point => {
            const p = projectPoint(point, cloud, time, baseSize);
            const perspective = 960 / (960 + p.z);
            const x = center.x + p.x * perspective;
            const y = center.y + p.y * perspective * 0.72;

            if (x < -40 || x > particleW + 40 || y < -40 || y > particleH + 40) return;

            const depth = Math.max(0, Math.min(1, (p.z / baseSize + 1) * 0.5));
            const alpha = (0.022 + depth * 0.16) * (0.85 + audioEnergy * 1.05);
            const size = (0.32 + depth * 1.25 + (point.sparkle ? 0.95 : 0)) * (1 + audioEnergy * 0.72);
            const whiteMix = point.sparkle ? 92 : 14 + depth * 42;
            const r = Math.min(255, cloud.color[0] + whiteMix);
            const g = Math.min(255, cloud.color[1] + whiteMix);
            const b = Math.min(255, cloud.color[2] + whiteMix);

            particleCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
            particleCtx.beginPath();
            particleCtx.arc(x, y, size, 0, Math.PI * 2);
            particleCtx.fill();
        });
    });

    requestAnimationFrame(drawParticleBackground);
}

resizeParticleCanvas();
window.addEventListener('resize', resizeParticleCanvas);
requestAnimationFrame(drawParticleBackground);

// 2. Fullscreen Preloader Logic
window.addEventListener('load', () => {
    let count = 0;
    const counterEl = document.getElementById('counter');
    const preloader = document.getElementById('preloader');
    
    let interval = setInterval(() => {
        count += Math.floor(Math.random() * 8) + 2;
        if(count >= 100) {
            count = 100;
            clearInterval(interval);
            counterEl.innerText = count + '%';
            
            setTimeout(() => {
                preloader.style.opacity = '0';
                preloader.style.pointerEvents = 'none';
                document.documentElement.classList.remove('is-loading');
                document.body.classList.remove('is-loading');
                
                setTimeout(() => {
                    typeEffect(); 
                    window.dispatchEvent(new Event('scroll'));
                }, 500);
            }, 500);
        } else {
            counterEl.innerText = count + '%';
        }
    }, 30);
});

// 3. Typing Effect
const typeEl = document.getElementById('typing-text');
const words = ["Robotics", "Computer Vision", "Bimanual Manipulation", "Task Planning", "Everything New"];
let wIdx = 0, cIdx = 0, isDeleting = false;

function typeEffect() {
    const current = words[wIdx];
    if(isDeleting) {
        typeEl.innerText = current.substring(0, cIdx - 1);
        cIdx--;
    } else {
        typeEl.innerText = current.substring(0, cIdx + 1);
        cIdx++;
    }

    let speed = isDeleting ? 40 : 100;
    if(!isDeleting && cIdx === current.length) { speed = 2000; isDeleting = true; }
    else if(isDeleting && cIdx === 0) { isDeleting = false; wIdx = (wIdx + 1) % words.length; speed = 500; }
    
    setTimeout(typeEffect, speed);
}

// 4. Navigation Active State & Multi-Directional Scroll Reveal
const sections = document.querySelectorAll('section');
const navLinks = document.querySelectorAll('.nav-links a');

window.addEventListener('scroll', () => {
    let current = '';
    sections.forEach(sec => {
        const secTop = sec.offsetTop;
        if(scrollY >= secTop - window.innerHeight / 3) current = sec.getAttribute('id');
    });
    navLinks.forEach(a => {
        a.classList.remove('active');
        if(a.getAttribute('href').includes(current)) a.classList.add('active');
    });
    
    // Dynamic Background Animation on Scroll
    const scrolled = window.scrollY;
    const maxScroll = document.body.scrollHeight - window.innerHeight;
    const scrollRatio = maxScroll > 0 ? scrolled / maxScroll : 0;
    
    // Change hue based on scroll position (0 to 360deg)
    scrollHue = scrollRatio * 360;
    document.querySelector('.fluid-bg').style.filter = `hue-rotate(${scrollHue}deg) saturate(${1.05 + scrollRatio * 0.35})`;
});

// Use IntersectionObserver for natural scroll reveals
const revealOptions = {
    root: null,
    rootMargin: '0px 0px -100px 0px',
    threshold: 0.1
};

const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('active');
        } else if (entry.boundingClientRect.top > 0) {
            // Only reset when scrolling up (element goes off the bottom of the viewport)
            entry.target.classList.remove('active');
        }
    });
}, revealOptions);

document.querySelectorAll('.reveal-left, .reveal-right, .reveal-up').forEach(el => {
    revealObserver.observe(el);
});

// 5. Image Reveal on Publication Hover 
const hoverImg = document.getElementById('hover-img');
let imgTargetX = 0, imgTargetY = 0, imgX = 0, imgY = 0;

document.querySelectorAll('.img-trigger').forEach(trigger => {
    trigger.addEventListener('mouseenter', (e) => {
        const src = trigger.getAttribute('data-img');
        if(src) { hoverImg.src = src; hoverImg.classList.add('show'); }
    });
    trigger.addEventListener('mouseleave', () => hoverImg.classList.remove('show'));
    trigger.addEventListener('mousemove', (e) => {
        imgTargetX = e.clientX; imgTargetY = e.clientY;
    });
});

function animateHoverImage() {
    if(hoverImg.classList.contains('show')) {
        imgX += (imgTargetX - imgX) * 0.1;
        imgY += (imgTargetY - imgY) * 0.1;
        hoverImg.style.left = `${imgX}px`;
        hoverImg.style.top = `${imgY}px`;
    }
    requestAnimationFrame(animateHoverImage);
}
animateHoverImage();

// Smooth Scroll for Anchors
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        e.preventDefault();
        document.querySelector(this.getAttribute('href')).scrollIntoView({ behavior: 'smooth' });
    });
});

// 6. Audio Visualizer -> Point Cloud Interaction
const bgMusic = document.getElementById('bg-music');
const musicBtn = document.getElementById('music-btn');
const musicIcon = musicBtn.querySelector('i');
const bgmList = ['./bgm_0.mp3'];

let isPlaying = false, audioCtx, analyser, dataArray, source;

function playRandomTrack(isInitial = false) {
    bgMusic.src = bgmList[Math.floor(Math.random() * bgmList.length)];
    bgMusic.load();
    
    if(isInitial) {
        bgMusic.addEventListener('loadedmetadata', function setRandomTime() {
            let dur = bgMusic.duration;
            if(Number.isFinite(dur) && dur > 0) {
                bgMusic.currentTime = (dur * 0.1) + Math.random() * (dur * 0.8);
            }
            bgMusic.removeEventListener('loadedmetadata', setRandomTime);
        });
    } else {
        bgMusic.play();
    }
}
playRandomTrack(true);
bgMusic.addEventListener('ended', () => playRandomTrack(false));

function initAudio() {
    if(!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        source = audioCtx.createMediaElementSource(bgMusic);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        analyser.fftSize = 256;
        dataArray = new Uint8Array(analyser.frequencyBinCount);
        renderAudioVisuals();
    }
    if(audioCtx.state === 'suspended') audioCtx.resume();
}

function renderAudioVisuals() {
    requestAnimationFrame(renderAudioVisuals);
    if(isPlaying) {
        analyser.getByteFrequencyData(dataArray);
        
        let bass = 0; 
        for(let i=0; i<8; i++) bass += dataArray[i]; 
        
        let normalizedBass = (bass / 8) / 255; 
        audioEnergy += (normalizedBass - audioEnergy) * 0.18;
    } else {
        audioEnergy *= 0.92;
    }
}

musicBtn.addEventListener('click', () => {
    initAudio();
    if(isPlaying) {
        bgMusic.pause();
        musicIcon.classList.replace('fa-pause', 'fa-play');
        musicBtn.classList.remove('playing');
    } else {
        bgMusic.play();
        musicIcon.classList.replace('fa-play', 'fa-pause');
        musicBtn.classList.add('playing');
    }
    isPlaying = !isPlaying;
});

// 7. Toast Notification Popup
let toastTimeout;
function showWipToast() {
    const toast = document.getElementById('toast-msg');
    toast.classList.add('show');
    
    // 기존 타이머가 있으면 초기화 (연속 클릭 시 사라지지 않도록)
    clearTimeout(toastTimeout);
    
    // 3초 뒤에 토스트 숨김
    toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}
