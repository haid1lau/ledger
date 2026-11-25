/* =========================================================
   3D budget orb (Three.js) — liquid level = share of budget spent
   ========================================================= */
const Orb = (() => {
  const stage = $('orbStage'), canvas = $('orbCanvas');
  let rings = [], orbits, plight, glowTex, ok = false, R, scene, cam, group, sphere, glow, pts, ptsStart, ptsEnd, ptsDelay, sats = [], satSig = '';
  let level = 0, vel = 0, target = 0, slosh = 0, visible = true, t0 = performance.now(), lastT = 0;
  let spinner, orbitTilt, drag = null, yawV = 0, pitchV = 0, hover = -1, pinUntil = 0, ray, hovered = null;
  const pend = { x: 0, y: 0 }, ptr = { x: 0, y: 0, inside: false };
  const AX = { x: null, y: null }, qa = { a: null, b: null };
  const mouse = { x: 0, y: 0 }, rot = { x: 0, y: 0 };
  let col, colTarget, uni;

  function fallback() { document.documentElement.classList.add('no-gl'); }

  function init() {
    if (!window.THREE) return fallback();
    try { R = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch (e) { return fallback(); }
    if (!R.getContext()) return fallback();
    ok = true;
    R.setPixelRatio(Math.min(devicePixelRatio, 2));
    scene = new THREE.Scene();
    cam = new THREE.PerspectiveCamera(32, 1, .1, 100); cam.position.set(0, 0, 7.2);
    group = new THREE.Group(); scene.add(group);
    col = new THREE.Color('#D7FF3D'); colTarget = col.clone();

    uni = { uTime: { value: 0 }, uLevel: { value: 0 }, uSlosh: { value: 0 }, uTilt: { value: new THREE.Vector2() }, uColor: { value: col } };
    sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 128), new THREE.ShaderMaterial({
      uniforms: uni,
      vertexShader: `varying vec3 vPos; varying vec3 vObj; varying vec3 vN; varying vec3 vView;
        void main(){ vObj = position; vPos = normalize(mat3(modelMatrix) * position); vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform float uTime, uLevel, uSlosh; uniform vec2 uTilt; uniform vec3 uColor;
        varying vec3 vPos; varying vec3 vObj; varying vec3 vN; varying vec3 vView;
        float gridLine(float v, float n, float w){ return 1.0 - smoothstep(0.0, w, 0.5 - abs(fract(v * n) - 0.5)); }
        void main(){
          float fres = pow(1.0 - max(dot(vN, vView), 0.0), 2.4);
          float surf = mix(-1.02, 1.0, uLevel)
            + sin(vPos.x * 4.0 + uTime * 2.1) * (0.022 + 0.13 * uSlosh)
            + sin(vPos.z * 5.0 - uTime * 1.7) * (0.018 + 0.09 * uSlosh)
            + uTilt.x * vPos.x + uTilt.y * vPos.z;
          float inside = smoothstep(surf + 0.012, surf - 0.012, vPos.y);
          float depth = clamp((surf - vPos.y) * 0.55, 0.0, 1.0);
          vec3 L = normalize(vec3(-0.5, 0.8, 0.6));
          float diff = max(dot(vN, L), 0.0);
          vec3 liquid = mix(uColor * 1.15, uColor * 0.22, depth) + uColor * diff * 0.28;
          liquid += vec3(0.08) * sin(vPos.y * 30.0 - uTime * 3.0) * (1.0 - depth) * 0.25;
          vec3 glass = vec3(0.03, 0.03, 0.05) + vec3(0.55, 0.57, 0.72) * fres * 0.55;
          float lon = atan(vObj.z, vObj.x) / 6.2831853, lat = asin(clamp(vObj.y, -1.0, 1.0)) / 3.1415927 + 0.5;
          float grid = max(gridLine(lon, 12.0, 0.03), gridLine(lat, 8.0, 0.045));
          float eq = 1.0 - smoothstep(0.0, 0.012, abs(vObj.y));
          glass += vec3(0.62, 0.64, 0.82) * (grid * 0.16 + eq * 0.3) * (0.4 + fres);
          vec3 col = mix(glass, liquid, inside);
          float line = 1.0 - smoothstep(0.0, 0.028, abs(vPos.y - surf));
          col += vec3(1.0, 1.0, 0.92) * line * 0.85 * step(0.001, uLevel);
          float spec = pow(max(dot(reflect(-L, vN), vView), 0.0), 48.0);
          col += spec * 0.9 + uColor * fres * 0.3;
          gl_FragColor = vec4(col, 1.0);
        }`,
    }));
    spinner = new THREE.Group(); group.add(spinner); spinner.add(sphere);
    AX.x = new THREE.Vector3(1, 0, 0); AX.y = new THREE.Vector3(0, 1, 0); qa.a = new THREE.Quaternion(); qa.b = new THREE.Quaternion();
    ray = new THREE.Raycaster();

    glow = new THREE.Mesh(new THREE.SphereGeometry(1.32, 64, 64), new THREE.ShaderMaterial({
      uniforms: { uColor: uni.uColor },
      vertexShader: `varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; varying vec3 vN; void main(){ float i = pow(max(-dot(vN, vec3(0.0,0.0,1.0)), 0.0), 1.6); gl_FragColor = vec4(uColor, i * 0.6); }`,
      side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    }));
    scene.add(glow);

    // orbit system: its own group that parallaxes with the cursor so depth reads clearly
    orbitTilt = new THREE.Group(); scene.add(orbitTilt);
    orbits = new THREE.Group(); orbitTilt.add(orbits);
    scene.fog = new THREE.Fog(0x07070B, 6.8, 10.8);          // far side of each orbit sinks into the dark
    scene.add(new THREE.AmbientLight(0x6a6a88, .45));
    const key = new THREE.DirectionalLight(0xffffff, 1.35); key.position.set(-3, 4, 5); scene.add(key);
    const rim = new THREE.DirectionalLight(0x8B7BFF, .6); rim.position.set(4, -2, -4); scene.add(rim);
    plight = new THREE.PointLight(0xD7FF3D, 2.2, 5, 1.6); scene.add(plight);   // the orb lights its moons
    const gc = document.createElement('canvas'); gc.width = gc.height = 64;
    const gx = gc.getContext('2d'), gr = gx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.25, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    gx.fillStyle = gr; gx.fillRect(0, 0, 64, 64); glowTex = new THREE.CanvasTexture(gc);

    const ringMat = new THREE.MeshBasicMaterial({ color: 0x34344A, transparent: true, opacity: .9 });
    [[1.72, .0045, -0.32, .18], [2.02, .003, .42, -.25]].forEach(([r, t, rx, rz]) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, t, 8, 220), ringMat);
      m.rotation.set(Math.PI / 2 + rx, 0, rz); orbits.add(m); rings.push(m);
    });

    // particle halo — assembles on boot
    const N = 1600, pos = new Float32Array(N * 3);
    ptsStart = new Float32Array(N * 3); ptsEnd = new Float32Array(N * 3); ptsDelay = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      const r = 1.45 + Math.pow(Math.random(), 2.2) * 1.4, R0 = 9 + Math.random() * 8;
      ptsEnd.set([s * Math.cos(th) * r, u * r * .9, s * Math.sin(th) * r], i * 3);
      const u2 = Math.random() * 2 - 1, th2 = Math.random() * Math.PI * 2, s2 = Math.sqrt(1 - u2 * u2);
      ptsStart.set([s2 * Math.cos(th2) * R0, u2 * R0, s2 * Math.sin(th2) * R0], i * 3);
      ptsDelay[i] = Math.random() * .7;
    }
    pos.set(RM ? ptsEnd : ptsStart);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xA9A9C0, size: .022, transparent: true, opacity: .75, depthWrite: false }));
    scene.add(pts);

    resize();
    new ResizeObserver(resize).observe(stage);
    new IntersectionObserver(es => { visible = es[0].isIntersecting; }).observe(stage);
    addEventListener('pointermove', e => { mouse.x = e.clientX / innerWidth * 2 - 1; mouse.y = e.clientY / innerHeight * 2 - 1; }, { passive: true });

    // drag to spin like a trackball: left→right turns it anticlockwise (seen from above),
    // top→bottom rolls the top toward you. Tap the glass to splash, tap a moon to name it.
    const local = e => { const r = stage.getBoundingClientRect(); ptr.x = e.clientX - r.left; ptr.y = e.clientY - r.top; };
    stage.addEventListener('pointerdown', e => {
      drag = { x: e.clientX, y: e.clientY, moved: 0 }; local(e);
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', e => {
      local(e); ptr.inside = true;
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
      pend.x += dx; pend.y += dy;
    });
    const end = e => {
      if (!drag) return;
      if (drag.moved < 5) {
        local(e); const h = pick();
        if (h >= 0) { hover = h; pinUntil = performance.now() + 2600; } else splash();
      }
      drag = null;
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', () => { drag = null; });
    stage.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') ptr.inside = false; });
    requestAnimationFrame(loop);
  }

  function resize() {
    if (!ok) return;
    const w = stage.clientWidth, h = stage.clientHeight;
    R.setSize(w, h, false); cam.aspect = w / h;
    cam.position.z = w < 420 ? 8.6 : 7.2; cam.updateProjectionMatrix();
  }

  function setSats(list) {
    const sig = list.map(s => s.color + s.share.toFixed(2)).join();
    if (sig === satSig) { sats.forEach((s, i) => s.data = list[i]); return; } satSig = sig;
    sats.forEach(s => orbits.remove(s.pivot)); sats = [];
    const SEG = 200;
    list.forEach((c, i) => {
      const color = new THREE.Color(c.color), size = .075 + Math.sqrt(c.share) * .085;
      const r = 1.55 + i * .2 + (i % 2) * .06;
      // each moon gets its own tilted orbital plane
      const pivot = new THREE.Object3D();
      pivot.rotation.set((i % 2 ? 1 : -1) * (.35 + i * .13), i * 1.1, (i % 3 - 1) * .18);
      orbits.add(pivot);

      // orbit path: fades toward the back, glows as a comet tail just behind the moon
      const pp = new Float32Array((SEG + 1) * 3), at = new Float32Array(SEG + 1);
      for (let k = 0; k <= SEG; k++) { const th = k / SEG * Math.PI * 2; pp.set([Math.cos(th) * r, 0, Math.sin(th) * r], k * 3); at[k] = k / SEG; }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(pp, 3)); lg.setAttribute('aT', new THREE.BufferAttribute(at, 1));
      const lineMat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: color }, uHead: { value: 0 }, uCamZ: { value: cam.position.z }, uBoost: { value: 0 } },
        vertexShader: `attribute float aT; varying float vT; varying float vZ;
          void main(){ vT = aT; vec4 mv = modelViewMatrix * vec4(position, 1.0); vZ = mv.z; gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `uniform vec3 uColor; uniform float uHead, uCamZ, uBoost; varying float vT; varying float vZ;
          void main(){
            float front = smoothstep(-uCamZ - 2.2, -uCamZ + 2.0, vZ);
            float tail = exp(-fract(uHead - vT) * 9.0);
            float a = mix(.06, .38, front) + tail * mix(.4, 1.0, front) + uBoost * mix(.25, .6, front);
            gl_FragColor = vec4(mix(vec3(.55, .55, .7), uColor, min(1.0, .35 + tail * .65 + uBoost)), a);
          }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      pivot.add(new THREE.Line(lg, lineMat));

      // the moon: a lit, slightly glossy sphere with a soft halo
      const moon = new THREE.Mesh(new THREE.SphereGeometry(size, 40, 40), new THREE.MeshStandardMaterial({
        color, roughness: .32, metalness: .15, emissive: color, emissiveIntensity: .12,
      }));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity: .55, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.scale.setScalar(size * 7);
      moon.add(halo);
      pivot.add(moon);
      // comet trail: fading glow puffs along the path behind the moon
      const trail = [...Array(18)].map((_, k) => {
        const f = 1 - k / 18;
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity: .55 * f * f, depthWrite: false, blending: THREE.AdditiveBlending }));
        sp.scale.setScalar(size * (1.2 + 2.6 * f)); pivot.add(sp); return sp;
      });
      // a larger invisible sphere makes small moons easy to hover
      const hit = new THREE.Mesh(new THREE.SphereGeometry(Math.max(size * 2.4, .17), 12, 12), new THREE.MeshBasicMaterial());
      hit.visible = false; moon.add(hit);
      sats.push({ data: c, pivot, moon, hit, lineMat, trail, r, sp: (.42 - i * .045) * (i % 2 ? 1 : 1.15), ang: i * 1.7, grow: 1 });
    });
  }

  // which moon is under the pointer? (-1 if none, or if the orb is in front of it)
  function pick() {
    if (!sats.length) return -1;
    const w = stage.clientWidth, h = stage.clientHeight;
    ray.setFromCamera({ x: ptr.x / w * 2 - 1, y: -(ptr.y / h) * 2 + 1 }, cam);
    const hit = ray.intersectObjects([sphere, ...sats.map(s => s.hit)], false)[0];
    return hit ? sats.findIndex(s => s.hit === hit.object) : -1;
  }

  function showTip() {
    const tip = $('moonTip'), s = sats[hover];
    stage.classList.toggle('on-moon', hover >= 0 && !drag);
    if (!s || !s.data) { tip.classList.remove('show'); return; }
    const v = new THREE.Vector3(); s.moon.getWorldPosition(v); v.project(cam);
    const x = (v.x + 1) / 2 * stage.clientWidth, y = (1 - v.y) / 2 * stage.clientHeight;
    if (tip.dataset.k !== s.data.name) {
      tip.dataset.k = s.data.name; tip.style.setProperty('--c', s.data.color);
      $('mtName').textContent = s.data.name;
      $('mtAmt').textContent = `${money(s.data.amt)} · ${Math.round(s.data.share * 100)}%`;
    }
    const tw = tip.offsetWidth, left = Math.max(8, Math.min(x - tw / 2, stage.clientWidth - tw - 8));
    tip.style.transform = `translate(${left}px, ${Math.max(4, y - 58)}px)`;
    tip.classList.add('show');
  }

  function loop(now) {
    requestAnimationFrame(loop);
    if (!visible || document.hidden) return;
    const t = (now - t0) / 1000, dt = Math.min(t - lastT, .05); lastT = t;
    // spring level
    vel += (target - level) * .045; vel *= .86; level += vel;
    slosh *= .975;
    col.lerp(colTarget, .05);
    const shown = Math.max(0, Math.min(level, 1)) * .96;
    uni.uTime.value = t; uni.uLevel.value = shown; uni.uSlosh.value = Math.min(slosh + Math.abs(vel) * 6, 1.2);
    // follow cursor, liquid counter-tilts
    const tx = mouse.y * .28, ty = mouse.x * .45;
    const dX = tx - rot.x, dY = ty - rot.y;
    rot.x += dX * .05; rot.y += dY * .05;
    group.rotation.x = rot.x; group.rotation.y = rot.y;
    // user spin with momentum, applied about the viewer's axes
    if (drag) { yawV = pend.x * .009; pitchV = pend.y * .009; pend.x = pend.y = 0; }
    else { yawV *= .94; pitchV *= .94; }
    qa.a.setFromAxisAngle(AX.y, yawV + (RM ? 0 : .0025)); qa.b.setFromAxisAngle(AX.x, pitchV);
    spinner.quaternion.premultiply(qa.a).premultiply(qa.b);
    qa.a.setFromAxisAngle(AX.y, yawV * .35); qa.b.setFromAxisAngle(AX.x, pitchV * .35);
    orbits.quaternion.premultiply(qa.a).premultiply(qa.b);
    slosh = Math.min(1, slosh + (Math.abs(yawV) + Math.abs(pitchV)) * .9);
    uni.uTilt.value.set(THREE.MathUtils.clamp(-dY * 1.4 - yawV * 5, -.4, .4), THREE.MathUtils.clamp(dX * 1.4 + pitchV * 5, -.4, .4));
    const bootP = RM ? 1 : Math.min(t / 1.8, 1);
    const sc = bootP < 1 ? .55 + .45 * (1 - Math.pow(1 - bootP, 3)) + Math.sin(bootP * Math.PI) * .06 : 1 + Math.sin(t * 1.3) * .012;
    sphere.scale.setScalar(sc); glow.scale.setScalar(sc);
    if (bootP < 1 || !pts.userData.done) {
      const a = pts.geometry.attributes.position.array;
      let done = true;
      for (let i = 0; i < ptsDelay.length; i++) {
        const p = Math.max(0, Math.min((t - ptsDelay[i]) / 1.4, 1)), e = 1 - Math.pow(2, -10 * p);
        if (p < 1) done = false;
        for (let k = 0; k < 3; k++) a[i * 3 + k] = ptsStart[i * 3 + k] + (ptsEnd[i * 3 + k] - ptsStart[i * 3 + k]) * e;
      }
      pts.geometry.attributes.position.needsUpdate = true; pts.userData.done = done;
    }
    pts.rotation.y = t * .05 + rot.y * .3; pts.rotation.x = rot.x * .5;
    rings.forEach((r, i) => { r.rotation.z += i ? -.0012 : .0018; });
    orbitTilt.rotation.x = .22 + rot.x * 1.1; orbitTilt.rotation.y = rot.y * .9;
    plight.color.copy(col);
    if (performance.now() > pinUntil) hover = ptr.inside && !drag ? pick() : -1;
    sats.forEach((s, i) => {
      const on = i === hover;
      s.ang += dt * s.sp * (on ? .12 : 1);            // a hovered moon slows almost to a stop
      s.grow += ((on ? 1.45 : 1) - s.grow) * .18; s.moon.scale.setScalar(s.grow);
      s.lineMat.uniforms.uBoost.value += ((on ? 1 : 0) - s.lineMat.uniforms.uBoost.value) * .15;
      const a = s.ang;
      s.moon.position.set(Math.cos(a) * s.r, 0, Math.sin(a) * s.r);
      s.moon.rotation.y = t * .8;
      s.trail.forEach((sp, k) => { const b = a - (k + 1) * .045; sp.position.set(Math.cos(b) * s.r, 0, Math.sin(b) * s.r); });
      s.lineMat.uniforms.uHead.value = (a / (Math.PI * 2)) % 1;
      s.lineMat.uniforms.uCamZ.value = cam.position.z;
    });
    R.render(scene, cam);
    showTip();
  }

  function set(pct, list) {
    target = pct;
    colTarget = new THREE.Color(pct > 1 ? '#FF7A59' : '#D7FF3D');
    if (ok) setSats(list);
    $('orbLiq').style.setProperty('--lvl', Math.min(pct, 1) * 100 + '%');
  }
  function splash() { slosh = 1; vel += .02; }
  return { init, set: (p, l) => { if (window.THREE) set(p, l); else $('orbLiq').style.setProperty('--lvl', Math.min(p, 1) * 100 + '%'); }, splash };
})();
