/* =========================================================
   Login screen: a GPU particle field that morphs between shapes,
   kinetic type, and the choreography around the sign-in card.
   app.js owns the auth logic; this file only animates it.
   ========================================================= */
const Login = (() => {
  const auth = $('auth'), card = $('authForm'), inner = $('authIn'), canvas = $('authCanvas'), go = $('authSave');
  let gl = null, running = false, raf = 0, last = 0, mode = 'login', fromApp = false;
  const mouse = { x: 9, y: 9, sx: 9, sy: 9 };

  /* ---------- kinetic type: split text into per-letter spans ---------- */
  function split(root, delay) {
    let i = 0;
    root.style.setProperty('--d0', delay + 'ms');
    const hide = !!root.closest('[aria-label]');
    const walk = el => [...el.childNodes].forEach(n => {
      if (n.nodeType === 1) return walk(n);
      if (n.nodeType !== 3) return;
      const frag = document.createDocumentFragment();
      [...n.textContent].forEach(c => {
        const s = document.createElement('span');
        s.className = 'ch' + (c === ' ' ? ' sp' : '');
        s.textContent = c === ' ' ? ' ' : c;
        s.style.setProperty('--i', i++);
        if (hide) s.setAttribute('aria-hidden', 'true');
        frag.appendChild(s);
      });
      n.replaceWith(frag);
    });
    walk(root);
  }
  split(document.querySelector('.auth-brand .split'), 500);
  split(document.querySelector('.auth-head'), 650);

  /* ---------- title decoder: old text scrambles into the new one ---------- */
  const GLYPHS = '$¢€£¥%#&+=0123456789';
  function title(text) {
    const el = $('authTitle');
    cancelAnimationFrame(el._raf);
    if (RM || !el.textContent || auth.hidden) { el.textContent = text; return; }
    const from = el.textContent, len = Math.max(from.length, text.length), t0 = performance.now(), dur = 700;
    const step = now => {
      const p = Math.min((now - t0) / dur, 1);
      if (p === 1) { el.textContent = text; return; }
      let out = '';
      for (let i = 0; i < len; i++) {
        const at = i / len * .75;                       // when this letter settles
        if (p >= at + .25) out += esc(text[i] || '');
        else if (p >= at) out += text[i] === ' ' ? ' ' : `<span class="sc">${GLYPHS[(Math.random() * GLYPHS.length) | 0]}</span>`;
        else out += esc(from[i] || '');
      }
      el.innerHTML = out;
      el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }

  /* ---------- card height glides when its content changes ---------- */
  function morph(apply) {
    const h = inner.offsetHeight;
    apply();
    if (RM || auth.hidden || !h) return;
    const h2 = inner.offsetHeight;
    if (Math.abs(h2 - h) > 1) inner.animate([{ height: h + 'px' }, { height: h2 + 'px' }], { duration: 550, easing: 'cubic-bezier(.34,1.4,.64,1)' });
  }

  /* ---------- fields ---------- */
  const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const email = $('aEmail'), pass = $('aPass'), eye = $('aEye');
  const checkEmail = () => email.parentNode.classList.toggle('valid', EMAIL.test(email.value.trim()));
  email.addEventListener('input', checkEmail);

  const SEG = ['#FF7A59', '#FFD166', '#D7FF3D', '#7CF3FF'];
  function meter() {
    const pw = pass.value, segs = $('pwMeter').querySelectorAll('i');
    let n = 0, label = 'At least 8 characters';
    if (pw.length && pw.length < 8) { n = 1; label = `${8 - pw.length} more character${8 - pw.length > 1 ? 's' : ''}`; }
    else if (pw.length >= 8) {
      n = 1 + (pw.length >= 12) + (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) + (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw));
      n = Math.min(n, 4); label = ['Okay', 'Okay', 'Good', 'Strong', 'Excellent'][n];
    }
    segs.forEach((s, i) => { s.classList.toggle('on', i < n); s.style.setProperty('--pc', SEG[Math.max(n - 1, 0)]); });
    $('pwLbl').textContent = label;
  }
  pass.addEventListener('input', () => { if (mode === 'signup') meter(); kick(.35); });
  email.addEventListener('input', () => kick(.12));
  const caps = e => { if (e.getModifierState) $('capsChip').hidden = !e.getModifierState('CapsLock'); };
  pass.addEventListener('keydown', caps); pass.addEventListener('keyup', caps);
  pass.addEventListener('blur', () => { $('capsChip').hidden = true; });

  eye.addEventListener('click', () => {
    const show = pass.type === 'password';
    eye.classList.add('blink');
    setTimeout(() => {
      pass.type = show ? 'text' : 'password';
      eye.setAttribute('aria-pressed', show); eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      eye.classList.remove('blink');
    }, 140);
    pass.focus();
  });

  /* ---------- card tilt + sheen ---------- */
  if (FINE && !RM) {
    go.classList.add('mag');
    auth.addEventListener('pointermove', e => {
      mouse.x = e.clientX / innerWidth * 2 - 1; mouse.y = -(e.clientY / innerHeight * 2 - 1);
      const r = card.getBoundingClientRect();
      const px = Math.max(-.5, Math.min(1.5, (e.clientX - r.left) / r.width)), py = Math.max(-.5, Math.min(1.5, (e.clientY - r.top) / r.height));
      card.style.setProperty('--ry', ((px - .5) * 7) + 'deg'); card.style.setProperty('--rx', ((.5 - py) * 6) + 'deg');
      card.style.setProperty('--mx', px * 100 + '%'); card.style.setProperty('--my', py * 100 + '%');
    }, { passive: true });
    auth.addEventListener('pointerleave', () => { mouse.x = mouse.y = 9; card.style.setProperty('--rx', '0deg'); card.style.setProperty('--ry', '0deg'); });
  }
  card.addEventListener('animationend', e => { if (e.animationName === 'cardIn') card.classList.add('settled'); });

  /* =========================================================
     Particle field
     ========================================================= */
  function shape(N, kind) {
    const a = new Float32Array(N * 3), R = Math.random;
    for (let i = 0; i < N; i++) {
      let x, y, z;
      if (kind === 'orb') {
        if (i < N * .74) {                                   // fibonacci shell
          const k = i / (N * .74), phi = Math.acos(1 - 2 * k), th = Math.PI * (1 + Math.sqrt(5)) * i, r = 2.05 + (R() - .5) * .08;
          x = Math.sin(phi) * Math.cos(th) * r; y = Math.cos(phi) * r; z = Math.sin(phi) * Math.sin(th) * r;
        } else {                                             // a tilted ring, like the app's orb
          const th = R() * Math.PI * 2, r = 2.7 + Math.pow(R(), 1.6) * .9;
          x = Math.cos(th) * r; y = (R() - .5) * .05; z = Math.sin(th) * r;
          const c = Math.cos(.42), s = Math.sin(.42); [y, z] = [y * c - z * s, y * s + z * c];
        }
      } else if (kind === 'knot') {                          // a (2,3) torus knot with a fuzzy tube
        const t = R() * Math.PI * 2, rr = Math.cos(3 * t) + 2.2;
        const u = R() * Math.PI * 2, tube = .28 * Math.sqrt(R());
        x = (rr * Math.cos(2 * t)) * .95 + Math.cos(u) * tube; y = (rr * Math.sin(2 * t)) * .95 + Math.sin(u) * tube; z = -Math.sin(3 * t) * 1.1 + Math.cos(u + 1) * tube;
      } else {                                               // galaxy: where everything starts
        const arm = i % 3, d = Math.pow(R(), .7) * 9, th = d * .55 + arm * 2.094 + (R() - .5) * .6;
        x = Math.cos(th) * d; y = (R() - .5) * (1.6 - d * .1); z = Math.sin(th) * d - 3;
      }
      a[i * 3] = x; a[i * 3 + 1] = y; a[i * 3 + 2] = z;
    }
    return a;
  }

  function initGL() {
    if (gl !== null) return gl;
    gl = false;
    if (RM || !window.THREE) return gl;
    let R;
    try { R = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' }); } catch (e) { return gl; }
    if (!R.getContext()) return gl;
    R.setPixelRatio(Math.min(devicePixelRatio, 2));
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(40, 1, .1, 100);
    cam.position.z = 8;
    const N = innerWidth < 720 ? 6000 : 12000;
    const shapes = { orb: shape(N, 'orb'), knot: shape(N, 'knot'), galaxy: shape(N, 'galaxy') };
    const rnd = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) rnd.set([Math.random(), .45 + Math.random() * 1.1, Math.random(), Math.random()], i * 4);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(shapes.orb), 3));
    geo.setAttribute('aFrom', new THREE.BufferAttribute(new Float32Array(shapes.galaxy), 3));
    geo.setAttribute('aTo', new THREE.BufferAttribute(new Float32Array(shapes.orb), 3));
    geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 4));
    const uni = {
      uT: { value: 0 }, uTime: { value: 0 }, uEnergy: { value: 0 }, uBad: { value: 0 }, uWarp: { value: 0 },
      uPixel: { value: R.getPixelRatio() }, uAspect: { value: 1 }, uMouse: { value: new THREE.Vector2(9, 9) },
      uA: { value: new THREE.Color('#D7FF3D').multiplyScalar(.95) }, uB: { value: new THREE.Color('#8B7BFF') }, uC: { value: new THREE.Color('#ffffff') },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: uni, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `
        uniform float uT, uTime, uEnergy, uBad, uWarp, uPixel, uAspect;
        uniform vec2 uMouse; uniform vec3 uA, uB, uC;
        attribute vec3 aFrom, aTo; attribute vec4 aRnd;
        varying vec3 vCol; varying float vA;
        float ease(float x){ return x < .5 ? 4. * x * x * x : 1. - pow(-2. * x + 2., 3.) / 2.; }
        mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
        void main(){
          float p = ease(clamp((uT - aRnd.x * .45) / .55, 0., 1.));
          vec3 pos = mix(aFrom, aTo, p);
          pos.xz = rot(sin(p * 3.14159) * (aRnd.z - .5) * 3.2) * pos.xz;          // swirl mid-flight
          float n = sin(uTime * 1.3 + aRnd.z * 40.) * .5 + .5;
          pos += normalize(pos + 1e-4) * (n * .05 + uEnergy * .22 * sin(uTime * 11. + aRnd.w * 60.));
          float w1 = smoothstep(0., .42, uWarp), w2 = smoothstep(.42, 1., uWarp);  // implode, then fling outward
          pos *= mix(1., .02, w1);
          pos += normalize(aTo + 1e-4) * w2 * (5. + aRnd.y * 16.);
          pos.z += w2 * 7. * aRnd.x;
          vec4 mv = modelViewMatrix * vec4(pos, 1.);
          vec4 clip = projectionMatrix * mv;
          vec2 dm = (clip.xy / clip.w - uMouse) * vec2(uAspect, 1.);
          float push = smoothstep(.42, 0., length(dm)) * (1. - w1);
          mv.xy += normalize(dm + 1e-5) * push * .85;                          // cursor parts the field
          gl_Position = projectionMatrix * mv;
          float depth = clamp((-mv.z - 4.5) / 7., 0., 1.);
          gl_PointSize = uPixel * aRnd.y * (3.4 + push * 4. + w1 * 3. + uEnergy * 1.5) * (8. / max(-mv.z, .5));
          vec3 c = mix(uA, uB, smoothstep(.6, 1., aRnd.w));
          c = mix(c, uC, step(.975, aRnd.w));
          c = mix(c, vec3(1., .38, .26), uBad * (.6 + .4 * aRnd.z));
          c += push * vec3(.5, .55, .3) + w1 * .5;
          vCol = c;
          vA = mix(1., .3, depth) * (.55 + n * .45) * (1. - smoothstep(.82, 1., uWarp));
        }`,
      fragmentShader: `
        varying vec3 vCol; varying float vA;
        void main(){ float d = length(gl_PointCoord - .5); if (d > .5) discard; float a = 1. - d * 2.; gl_FragColor = vec4(vCol, a * vA); }`,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false; scene.add(pts);
    gl = { R, scene, cam, pts, geo, uni, shapes, cur: 'orb', dur: 2.6, warp: null, spin: 0 };
    resize(); addEventListener('resize', resize);
    return gl;
  }

  // keep the shape centred behind the card, wherever the layout puts it
  function resize() {
    if (!gl) return;
    const w = innerWidth, h = innerHeight;
    gl.R.setSize(w, h, false); gl.cam.aspect = w / h; gl.cam.updateProjectionMatrix();
    gl.uni.uAspect.value = w / h;
    const r = card.getBoundingClientRect(), halfH = Math.tan(20 * Math.PI / 180) * gl.cam.position.z, halfW = halfH * w / h;
    const wide = w > 980;
    gl.pts.position.set(wide ? ((r.left + r.width / 2) / w * 2 - 1) * halfW : 0, wide ? 0 : .6, 0);
    gl.pts.scale.setScalar(wide ? Math.max(1, Math.min(1.35, r.width / 330)) : Math.min(1, w / 520));
  }

  function setShape(name, from) {
    if (!gl) return;
    const A = gl.geo.attributes, f = A.aFrom.array, t = A.aTo.array, rnd = A.aRnd.array, T = gl.uni.uT.value;
    if (from) f.set(gl.shapes[from]);
    else for (let i = 0; i < f.length / 3; i++) {             // start from wherever each particle is now
      let p = Math.max(0, Math.min(1, (T - rnd[i * 4] * .45) / .55));
      p = p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      for (let k = 0; k < 3; k++) f[i * 3 + k] += (t[i * 3 + k] - f[i * 3 + k]) * p;
    }
    t.set(gl.shapes[name]);
    A.aFrom.needsUpdate = A.aTo.needsUpdate = true;
    gl.uni.uT.value = 0; gl.cur = name; gl.dur = from ? 2.8 : 1.7;
  }

  function kick(e) { if (gl) gl.uni.uEnergy.value = Math.min(1.4, gl.uni.uEnergy.value + e); }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (document.hidden || !gl) return;
    const dt = Math.min((now - last) / 1000, .05); last = now;
    const u = gl.uni;
    u.uTime.value += dt;
    u.uT.value = Math.min(1, u.uT.value + dt / gl.dur);
    u.uEnergy.value *= .93; u.uBad.value *= .965;
    mouse.sx += (mouse.x - mouse.sx) * .12; mouse.sy += (mouse.y - mouse.sy) * .12;
    u.uMouse.value.set(mouse.sx, mouse.sy);
    const mx = Math.abs(mouse.x) > 2 ? 0 : mouse.x, my = Math.abs(mouse.y) > 2 ? 0 : mouse.y;
    gl.spin *= .95;
    gl.pts.rotation.y += dt * (.14 + u.uEnergy.value * .6) + gl.spin;
    gl.pts.rotation.x += ((.32 - my * .25) - gl.pts.rotation.x) * .04;
    gl.pts.rotation.z += ((-.12 + mx * .12) - gl.pts.rotation.z) * .04;
    if (gl.warp) u.uWarp.value = Math.min(1, (now - gl.warp) / 1150);
    gl.R.render(gl.scene, gl.cam);
  }

  /* =========================================================
     Hooks for app.js
     ========================================================= */
  function show() {
    if (running) return;                                    // already on screen (e.g. switching log in / sign up)
    card.classList.remove('settled', 'shake'); auth.classList.remove('warp', 'flash');
    go.classList.remove('loading', 'ok');
    checkEmail(); meter();
    if (!initGL()) return;
    gl.warp = null; gl.uni.uWarp.value = 0;
    setShape(mode === 'signup' ? 'knot' : 'orb', 'galaxy');
    resize();
    if (!running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  function hide() {
    running = false; cancelAnimationFrame(raf);
    if (fromApp) {
      fromApp = false;
      document.body.classList.add('app-enter');
      setTimeout(() => document.body.classList.remove('app-enter'), 1300);
    }
  }

  function setMode(m) {
    const changed = m !== mode; mode = m;
    $('authEyebrowTxt').textContent = m === 'signup' ? 'New account' : 'Secure sign-in';
    $('pwMeter').hidden = m !== 'signup';
    if (m === 'signup') meter();
    if (changed && gl && running) { setShape(m === 'signup' ? 'knot' : 'orb'); gl.spin = .08; }
  }

  function busy(on) { go.classList.toggle('loading', on); if (on) kick(.6); }

  function fail() {
    busy(false);
    if (RM) return;
    card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
    setTimeout(() => card.classList.remove('shake'), 650);
    if (gl) { gl.uni.uBad.value = 1; kick(1); gl.spin = -.06; }
  }

  // check draws -> field implodes behind the card -> flash -> everything flies past the camera
  function success() {
    fromApp = true;
    go.classList.remove('loading'); go.classList.add('ok');
    if (RM) return new Promise(r => setTimeout(r, 250));
    return new Promise(resolve => {
      setTimeout(() => {
        if (gl) gl.warp = performance.now();
        auth.classList.add('warp');
      }, 420);
      setTimeout(() => {
        const r = card.getBoundingClientRect();
        auth.style.setProperty('--fx', (r.left + r.width / 2) + 'px'); auth.style.setProperty('--fy', (r.top + r.height / 2) + 'px');
        auth.classList.add('flash');
      }, 820);
      setTimeout(resolve, 1250);
    });
  }

  return { show, hide, setMode, title, morph, busy, fail, success };
})();
