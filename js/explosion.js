const FX = (() => {
  let map, canvas, ctx, dpr = 1, raf = 0, shakeAnim = null;
  const live = [];
  const MAX_LIVE = 6;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TAU = Math.PI * 2;
  const R = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const RAMP = [
    [1.00, [255, 251, 238]],
    [0.82, [255, 222, 130]],
    [0.62, [255, 150, 45]],
    [0.42, [214, 78, 22]],
    [0.24, [118, 62, 40]],
    [0.00, [128, 120, 114]],
  ];
  function ramp(t) {
    t = clamp(t, 0, 1);
    for (let i = 1; i < RAMP.length; i++) {
      if (t >= RAMP[i][0]) {
        const [t0, c0] = RAMP[i - 1], [t1, c1] = RAMP[i];
        const k = (t - t1) / (t0 - t1);
        return c1.map((v, j) => v + (c0[j] - v) * k);
      }
    }
    return RAMP[RAMP.length - 1][1];
  }
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  const SPRITE = 64, LEVELS = 40;
  const sprites = new Array(LEVELS);
  function sprite(temp) {
    const i = Math.round(clamp(temp, 0, 1) * (LEVELS - 1));
    if (sprites[i]) return sprites[i];
    const c = ramp(i / (LEVELS - 1));
    const hi = c.map(v => Math.min(255, v + 40));
    const lo = c.map(v => v * 0.62);
    const cv = document.createElement("canvas");
    cv.width = cv.height = SPRITE;
    const g = cv.getContext("2d");
    const r = SPRITE / 2;
    const grad = g.createRadialGradient(r - r * 0.3, r - r * 0.35, r * 0.05, r, r, r);
    grad.addColorStop(0, rgba(hi, 1));
    grad.addColorStop(0.5, rgba(c, 0.9));
    grad.addColorStop(0.8, rgba(lo, 0.45));
    grad.addColorStop(1, rgba(lo, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, SPRITE, SPRITE);
    return (sprites[i] = cv);
  }
  const SPARK = Array.from({ length: 16 }, (_, i) => rgba(ramp(0.55 + (i / 15) * 0.45), 1));

  function init(m) {
    map = m;
    canvas = document.createElement("canvas");
    canvas.className = "fx-layer";
    map.getContainer().appendChild(canvas);
    ctx = canvas.getContext("2d");
    resize();
    map.on("resize", resize);
    map.on("zoomanim", () => { canvas.style.visibility = "hidden"; });
    map.on("zoomend", () => { canvas.style.visibility = ""; });
  }

  function resize() {
    const s = map.getSize();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = s.x * dpr;
    canvas.height = s.y * dpr;
    canvas.style.width = s.x + "px";
    canvas.style.height = s.y + "px";
  }

  function spawn(latlng, { nuclear, sizeKm }) {
    if (reduced) return;
    const e = {
      latlng, sizeKm, t0: performance.now(),
      dur: nuclear ? 7 : 5.5, fadeStart: nuclear ? 2.6 : 1.6, spread: nuclear ? 1.25 : 1,
      puffs: [], sparks: [],
    };
    const nBurst = nuclear ? 48 : 36, nSkirt = nuclear ? 30 : 22, nSparks = nuclear ? 40 : 28;
    for (let i = 0; i < nBurst; i++) e.puffs.push({ kind: "burst", a: R(0, TAU), d: R(0.15, 1), rise: R(0.2, 1), s: R(0.3, 0.55), heat: R(0.6, 1.2) });
    for (let i = 0; i < nSkirt; i++) e.puffs.push({ kind: "skirt", a: R(0, TAU), v: R(0.8, 1.3), s: R(0.2, 0.34) });
    for (let i = 0; i < nSparks; i++) e.sparks.push({ a: R(0, TAU), v: R(0.5, 1.7), up: R(0.2, 1.3), life: R(0.5, 1.5) });
    e.puffs.sort((p, q) => (Math.sin(p.a) - (p.kind === "skirt")) - (Math.sin(q.a) - (q.kind === "skirt")));
    live.push(e);
    if (live.length > MAX_LIVE) live.shift();
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    const s = map.getSize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, s.x, s.y);
    for (let i = live.length - 1; i >= 0; i--) {
      if ((now - live[i].t0) / 1000 > live[i].dur) live.splice(i, 1);
    }
    const pxPerKm = 256 * Math.pow(2, map.getZoom()) / 40075.016686;
    for (const e of live) draw(e, (now - e.t0) / 1000, pxPerKm, s);
    ctx.globalAlpha = 1;
    raf = live.length ? requestAnimationFrame(frame) : 0;
  }

  function draw(e, t, pxPerKm, size) {
    const p = map.latLngToContainerPoint(e.latlng);
    const S = clamp(e.sizeKm * pxPerKm / Math.cos(e.latlng.lat * Math.PI / 180) * 0.85 * e.spread, 3, 260);
    if (S < 4) return;
    const reach = S * 3;
    if (p.x < -reach || p.y < -reach || p.x > size.x + reach || p.y > size.y + reach) return;

    const fade = t < e.fadeStart ? 1 : Math.max(0, 1 - (t - e.fadeStart) / (e.dur - e.fadeStart));
    const wind = Math.pow(t, 1.4) * S * 0.025;
    const grow = 1 - Math.exp(-t / 0.18), lift = 1 - Math.exp(-t / 1.2), swell = 1 - Math.exp(-t / 0.6);
    const ring = 1 - Math.exp(-t / 0.5), skirtA = Math.max(0, 1 - t / 3) * 0.8, skirtT = Math.exp(-t / 0.15) * 0.6;

    for (const q of e.puffs) {
      const depth = Math.sin(q.a), cos = Math.cos(q.a);
      let x, y, r, temp, a;
      if (q.kind === "burst") {
        const d = S * q.d * grow;
        x = p.x + cos * d + wind;
        y = p.y + depth * d * 0.45 - S * q.rise * 0.9 * lift - t * S * 0.08;
        r = S * q.s * (0.45 + 0.9 * swell + t * 0.12);
        temp = Math.exp(-t / (0.3 * q.heat));
        a = 1;
      } else {
        const d = S * 1.4 * q.v * ring;
        x = p.x + cos * d;
        y = p.y + depth * d * 0.4;
        r = S * q.s * (0.7 + t * 0.2);
        temp = skirtT;
        a = skirtA;
      }
      const alpha = a * fade * 0.9;
      if (alpha <= 0.01 || r < 0.5) continue;
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite(temp), x - r, y - r, r * 2, r * 2);
    }

    ctx.globalCompositeOperation = "lighter";
    for (const sp of e.sparks) {
      if (t > sp.life) continue;
      const k = 1 - t / sp.life;
      const d = S * 1.6 * sp.v * t;
      const x = p.x + Math.cos(sp.a) * d;
      const y = p.y + Math.sin(sp.a) * d * 0.4 - S * sp.up * 2.2 * t + S * 1.8 * t * t;
      const w = Math.max(1.4, S * 0.05 * k + 1);
      ctx.globalAlpha = k;
      ctx.fillStyle = SPARK[(k * 15) | 0];
      ctx.fillRect(x - w / 2, y - w / 2, w, w);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function shake(el, kt) {
    if (reduced || !el.animate) return;
    if (shakeAnim) shakeAnim.cancel();
    const amp = clamp(2 + Math.log10(kt * 1000 + 1) * 1.6, 2, 11);
    const frames = [];
    for (let i = 0; i <= 10; i++) {
      const k = (1 - i / 10) * amp;
      frames.push({ transform: i === 10 ? "none" : `translate(${R(-k, k)}px, ${R(-k, k)}px)` });
    }
    shakeAnim = el.animate(frames, { duration: 550, easing: "ease-out" });
  }

  function clear() {
    live.length = 0;
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  return { init, spawn, shake, clear, reduced };
})();
