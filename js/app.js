if (typeof L === "undefined") {
  document.getElementById("loadError").hidden = false;
  throw new Error("Bombadier!: the map library (Leaflet) failed to load.");
}

const MIN_KT = 1e-8;
const MAX_KT = 1e6;
const MAX_DETONATIONS = 300;

const ID_RE = /^[a-z0-9-]+$/;
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
function checkWeapons(list) {
  const seen = new Set(), ok = [];
  list.forEach((b, i) => {
    const where = `weapon #${i + 1}${b && typeof b.id === "string" ? ` ("${b.id}")` : ""}`;
    const problems = [];
    if (!b || typeof b !== "object") {
      problems.push("it isn't a W(...) entry");
    } else {
      if (typeof b.id !== "string" || !ID_RE.test(b.id)) problems.push("the id must be lowercase letters, numbers or dashes");
      else if (seen.has(b.id)) problems.push("another weapon already uses this id");
      if (!has(COUNTRIES, b.c)) problems.push(`the country "${b.c}" isn't listed in COUNTRIES`);
      if (!has(CATEGORIES, b.cat)) problems.push(`the category "${b.cat}" isn't one of: ${Object.keys(CATEGORIES).join(", ")}`);
      if (typeof b.name !== "string" || !b.name.trim()) problems.push("the name is missing");
      if (typeof b.kt !== "number" || !(b.kt >= MIN_KT && b.kt <= MAX_KT)) problems.push(`the yield must be a number from ${MIN_KT} to ${MAX_KT} kilotons`);
      if (typeof b.desc !== "string") problems.push("the description must be text in quotes");
    }
    if (problems.length) {
      console.warn(`Bombadier!: skipped ${where} in weapons.js because ${problems.join("; ")}.`);
      return;
    }
    seen.add(b.id);
    b.type = CATEGORIES[b.cat].nuclear ? "nuclear" : "conventional";
    b.popular = POPULAR.has(b.id);
    ok.push(b);
  });
  for (const id of POPULAR) {
    if (!seen.has(id)) console.warn(`Bombadier!: POPULAR in weapons.js lists "${id}", but no weapon has that id.`);
  }
  return ok;
}
const WEAPONS = checkWeapons(BOMBS);

const EFFECTS = [
  { key: "fireball", label: "Fireball",                  color: "#ffd84a", dead: 1.00, inj: 0.00,
    r: (Y, s) => (s ? 0.10 : 0.075) * Math.pow(Y, 0.4),
    info: "Everything inside is vaporised." },
  { key: "psi20",   label: "Heavy blast (20 psi)",       color: "#ff3b30", dead: 0.98, inj: 0.02,
    r: (Y, s) => (s ? 0.19 : 0.24) * Math.cbrt(Y),
    info: "Concrete buildings destroyed; near-total fatalities." },
  { key: "rad",     label: "Radiation (500 rem)",        color: "#5ef05e", dead: 0.75, inj: 0.20,
    r: (Y) => 0.68 * Math.pow(Y, 0.21), nuclearOnly: true,
    info: "Lethal dose for 50–90% without treatment." },
  { key: "psi5",    label: "Moderate blast (5 psi)",     color: "#ff8c1a", dead: 0.60, inj: 0.35,
    r: (Y, s) => (s ? 0.42 : 0.55) * Math.cbrt(Y),
    info: "Most homes collapse; widespread fires." },
  { key: "thermal", label: "Thermal (3rd-degree burns)", color: "#ffb347", dead: 0.35, inj: 0.50,
    r: (Y, s) => (s ? 0.55 : 0.67) * Math.pow(Y, 0.41), nuclearOnly: true,
    info: "Third-degree burns to exposed skin." },
  { key: "psi1",    label: "Light blast (1 psi)",        color: "#8fb4ff", dead: 0.05, inj: 0.30,
    r: (Y, s) => (s ? 1.1 : 1.4) * Math.cbrt(Y),
    info: "Windows shatter; injuries from flying glass." },
];

function effectsFor(bomb, surface) {
  return EFFECTS
    .filter(e => !(e.nuclearOnly && bomb.type !== "nuclear"))
    .map(e => ({ ...e, radius: e.r(bomb.kt, surface) }));
}

const KM_PER_DEG = 111.32;
const cityModel = CITIES.map(([name, lat, lon, m]) => {
  const pop = m * 1e6;
  const sigma = 2.5 + 2.2 * Math.sqrt(m);
  return { name, lat, lon, pop, sigma, norm: pop / (2 * Math.PI * sigma * sigma) };
});

function densityAt(lat, lon) {
  let d = 0;
  const cosLat = Math.cos(lat * Math.PI / 180);
  for (const c of cityModel) {
    const dy = (lat - c.lat) * KM_PER_DEG;
    if (Math.abs(dy) > c.sigma * 5) continue;
    const dx = (lon - c.lon) * KM_PER_DEG * cosLat;
    const r2 = dx * dx + dy * dy;
    if (r2 > 25 * c.sigma * c.sigma) continue;
    d += c.norm * Math.exp(-r2 / (2 * c.sigma * c.sigma));
  }
  return d;
}

const WORLDPOP_URL = "https://worldpop.arcgis.com/arcgis/rest/services/WorldPop_Population_Density_100m/ImageServer/getSamples";
const WORLDPOP_2020 = "1577836800000";
const POINTS_PER_ZONE = 110;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function offsetKm(lat, lon, dxKm, dyKm) {
  const la = Math.max(-85, Math.min(85, lat + dyKm / KM_PER_DEG));
  const lo = lon + dxKm / (KM_PER_DEG * Math.cos(lat * Math.PI / 180));
  return [la, ((lo + 540) % 360) - 180];
}
function distKm(lat1, lon1, lat2, lon2) {
  let dl = lon2 - lon1;
  if (dl > 180) dl -= 360;
  if (dl < -180) dl += 360;
  const dx = dl * KM_PER_DEG * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  return Math.hypot(dx, (lat2 - lat1) * KM_PER_DEG);
}

function samplePoints(det) {
  const radii = [...new Set(det.effects.map(e => e.radius))].sort((a, b) => a - b);
  const pts = [];
  let r0 = 0;
  for (const r1 of radii) {
    const w = Math.PI * (r1 * r1 - r0 * r0) / POINTS_PER_ZONE;
    for (let i = 0; i < POINTS_PER_ZONE; i++) {
      const r = Math.sqrt(r0 * r0 + (r1 * r1 - r0 * r0) * (i + 0.5) / POINTS_PER_ZONE);
      const a = i * GOLDEN_ANGLE;
      const [lat, lon] = offsetKm(det.lat, det.lon, r * Math.cos(a), r * Math.sin(a));
      pts.push({ lat, lon, w, dens: 0 });
    }
    r0 = r1;
  }
  return pts;
}

const WORLDPOP_PARALLEL = 4;
const WORLDPOP_TIMEOUT_MS = 15000;
const MAX_DENSITY = 500000;
let wpActive = 0;
const wpQueue = [];
const wpCache = new Map();

function withSlot(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      wpActive++;
      task().then(resolve, reject).finally(() => {
        wpActive--;
        const next = wpQueue.shift();
        if (next) next();
      });
    };
    if (wpActive < WORLDPOP_PARALLEL) run(); else wpQueue.push(run);
  });
}

async function fetchDensities(pts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WORLDPOP_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      geometry: JSON.stringify({ points: pts.map(p => [p.lon, p.lat]), spatialReference: { wkid: 4326 } }),
      geometryType: "esriGeometryMultipoint", returnFirstValueOnly: "true", time: WORLDPOP_2020, f: "json",
    });
    const res = await fetch(WORLDPOP_URL, {
      method: "POST", body, signal: ctrl.signal, credentials: "omit", referrerPolicy: "no-referrer",
    });
    if (!res.ok) throw new Error(`WorldPop answered ${res.status}`);
    const json = await res.json();
    if (!json || !Array.isArray(json.samples)) throw new Error(json && json.error ? String(json.error.message) : "no samples returned");
    const dens = new Float64Array(pts.length);
    for (const s of json.samples) {
      const id = s && s.locationId;
      if (!Number.isInteger(id) || id < 0 || id >= pts.length) continue;
      const v = parseFloat(s.value);
      dens[id] = Number.isFinite(v) && v > 0 ? Math.min(v, MAX_DENSITY) : 0;
    }
    return dens;
  } finally {
    clearTimeout(timer);
  }
}

async function loadPopulation(det) {
  const pts = samplePoints(det);
  const key = `${det.lat.toFixed(5)},${det.lon.toFixed(5)},${det.effects.map(e => e.radius.toPrecision(6)).join(",")}`;
  let dens = wpCache.get(key);
  if (!dens) {
    try {
      dens = await withSlot(() => detonations.includes(det) ? fetchDensities(pts) : Promise.resolve(null));
      if (!dens) return;
      wpCache.set(key, dens);
      if (wpCache.size > 200) wpCache.delete(wpCache.keys().next().value);
    } catch (err) {
      console.warn("Bombadier!: WorldPop unavailable, using the rough city model instead:", err);
      for (const p of pts) p.dens = densityAt(p.lat, p.lon);
      det.source = "model";
      det.points = pts;
      return;
    }
  }
  pts.forEach((p, i) => { p.dens = dens[i]; });
  det.source = "worldpop";
  det.points = pts;
}

function buildZones(effects) {
  const sorted = [...effects].sort((a, b) => a.radius - b.radius);
  const n = sorted.length;
  const z = { radius: new Float64Array(n), dead: new Float64Array(n), hurt: new Float64Array(n), severe: new Uint8Array(n) };
  let dead = 0, hurt = 0, severe = 0;
  for (let k = n - 1; k >= 0; k--) {
    const e = sorted[k];
    dead = Math.max(dead, e.dead);
    hurt = Math.max(hurt, e.dead + e.inj);
    if (e.key === "psi5" || e.key === "psi20" || e.key === "fireball") severe = 1;
    z.radius[k] = e.radius; z.dead[k] = dead; z.hurt[k] = hurt; z.severe[k] = severe;
  }
  return z;
}

function computeTotals(dets) {
  const ready = dets.filter(d => d.points);
  let dead = 0, inj = 0, exposed = 0, area = 0, cost = 0;
  for (let i = 0; i < ready.length; i++) {
    const det = ready[i];
    const near = [], earlier = [];
    for (let j = 0; j < ready.length; j++) {
      const o = ready[j];
      if (distKm(o.lat, o.lon, det.lat, det.lon) > o.outer + det.outer) continue;
      near.push(o);
      if (j < i) earlier.push(o);
    }
    for (const p of det.points) {
      let covered = false;
      for (const o of earlier) {
        if (distKm(o.lat, o.lon, p.lat, p.lon) <= o.outer) { covered = true; break; }
      }
      if (covered) continue;
      let wDead = 0, wHurt = 0, severe = false;
      for (const o of near) {
        const z = o.zones, d = distKm(o.lat, o.lon, p.lat, p.lon);
        let k = 0;
        while (k < z.radius.length && z.radius[k] < d) k++;
        if (k === z.radius.length) continue;
        if (z.dead[k] > wDead) wDead = z.dead[k];
        if (z.hurt[k] > wHurt) wHurt = z.hurt[k];
        if (z.severe[k]) severe = true;
      }
      const pop = p.dens * p.w;
      dead += pop * wDead;
      inj += pop * (wHurt - wDead);
      exposed += pop;
      if (severe) { area += p.w; cost += pop * 180000; }
      else if (wHurt > 0.05) cost += pop * 180000 * 0.15;
    }
  }
  return { dead, inj, area, cost, exposed };
}

function fmtNum(n) {
  n = Math.max(0, Math.round(n)) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(1) + "k";
  return n.toLocaleString();
}
function fmtMoney(n) {
  if (n >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  return "$" + Math.round(n).toLocaleString();
}
function fmtYield(kt) {
  const opts = d => ({ maximumFractionDigits: d });
  if (kt >= 1000) return (kt / 1000).toLocaleString(undefined, opts(1)) + " Mt";
  if (kt >= 1) return kt.toLocaleString(undefined, opts(1)) + " kt";
  if (kt >= 0.001) return (kt * 1000).toLocaleString(undefined, opts(1)) + " t";
  return (kt * 1e6).toLocaleString(undefined, opts(2)) + " kg";
}
function fmtKm(km) {
  if (km >= 1000) return Math.round(km).toLocaleString() + " km";
  return km >= 1 ? km.toFixed(2) + " km" : Math.max(1, Math.round(km * 1000)) + " m";
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const USSR_FLAG = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20"><rect width="30" height="20" fill="#cc0000"/>` +
  `<path d="M5.2 1.6l.45 1.4h1.45l-1.17.86.45 1.4-1.18-.86-1.18.86.45-1.4-1.17-.86h1.45z" fill="none" stroke="#ffd700" stroke-width=".35"/>` +
  `<path d="M3.4 9.6l3.4-3.4M3.1 7.9a2.5 2.5 0 0 0 4.1 1.5" fill="none" stroke="#ffd700" stroke-width=".8"/></svg>`);
function flagSrc(code) {
  return code === "su" ? USSR_FLAG : `https://flagcdn.com/w40/${encodeURIComponent(code)}.png`;
}
function flagImg(code) {
  const name = esc(has(COUNTRIES, code) ? COUNTRIES[code] : "");
  return `<img class="flag" src="${flagSrc(code)}" alt="${name}" title="${name}">`;
}
document.addEventListener("error", e => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.classList.contains("flag")) {
    img.removeAttribute("src");
    img.alt = "";
    img.classList.add("flag-missing");
  }
}, true);

const WORLD = L.latLngBounds([-85.05, -180], [85.05, 180]);
const MAX_ZOOM = 17;
const map = L.map("map", {
  zoomControl: false, worldCopyJump: false, maxBounds: WORLD, maxBoundsViscosity: 1,
  minZoom: 2, maxZoom: MAX_ZOOM,
}).setView([40.71, -74.01], 10);
const PANEL_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none"
  stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/>
  <path d="M9.5 4v16"/></svg>`;
let sideBtn;
const SidebarControl = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const bar = L.DomUtil.create("div", "leaflet-bar");
    sideBtn = L.DomUtil.create("a", "side-btn", bar);
    sideBtn.href = "#";
    sideBtn.setAttribute("role", "button");
    sideBtn.setAttribute("aria-controls", "sidebar");
    sideBtn.innerHTML = PANEL_ICON;
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.on(sideBtn, "click", e => {
      L.DomEvent.preventDefault(e);
      setSidebar(document.getElementById("app").classList.contains("side-closed"));
    });
    return bar;
  },
});
new SidebarControl().addTo(map);
L.control.zoom({ position: "topleft" }).addTo(map);

const ESRI = name => `https://server.arcgisonline.com/ArcGIS/rest/services/${name}/MapServer/tile/{z}/{y}/{x}`;
const ESRI_ATTR = "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS user community";
const BufferedTileLayer = L.TileLayer.extend({
  _getTiledPixelBounds(center) {
    const b = L.TileLayer.prototype._getTiledPixelBounds.call(this, center);
    const pad = this.getTileSize().multiplyBy(this.options.edgeBuffer || 0);
    return new L.Bounds(b.min.subtract(pad), b.max.add(pad));
  },
});
const tileOpts = extra => ({
  maxZoom: MAX_ZOOM, noWrap: true, bounds: WORLD, attribution: ESRI_ATTR,
  edgeBuffer: 2, keepBuffer: 8, updateWhenIdle: false, updateWhenZooming: false, ...extra,
});
const tiles = (name, extra) => new BufferedTileLayer(ESRI(name), tileOpts(extra));
const sat = tiles("World_Imagery").addTo(map);
const terrain = tiles("World_Topo_Map");
const street = tiles("World_Street_Map");
const dark = tiles("World_Street_Map", { className: "dark-tiles" });

const MOUSE_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none"
  stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="6" y="3" width="12" height="18" rx="6"/>
  <path d="M12 3v5.5"/><path d="M6.2 9.5h11.6"/></svg>`;
let modeBtn;
const ModeControl = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const bar = L.DomUtil.create("div", "leaflet-bar mode-bar");
    modeBtn = L.DomUtil.create("a", "mode-btn", bar);
    modeBtn.href = "#";
    modeBtn.setAttribute("role", "button");
    modeBtn.innerHTML = MOUSE_ICON;
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.on(modeBtn, "click", e => {
      L.DomEvent.preventDefault(e);
      setMode(mode === "pan" ? "bomb" : "pan");
    });
    return bar;
  },
});
new ModeControl().addTo(map);

L.control.layers({ "Satellite": sat, "Terrain": terrain, "Streets": street, "Dark": dark }, null, { position: "topleft" }).addTo(map);
L.control.scale({ imperial: true, position: "bottomright" }).addTo(map);

function updateMinZoom() {
  const s = map.getSize();
  const z = Math.ceil(Math.log2(Math.max(s.x, s.y) / 256));
  map.setMinZoom(Math.max(1, z));
}
map.on("resize", updateMinZoom);
updateMinZoom();
FX.init(map);

const Popover = (() => {
  let cur = null;
  function place() {
    if (!cur) return;
    const r = cur.anchor.getBoundingClientRect();
    const el = cur.el, vh = window.innerHeight, vw = window.innerWidth;
    const below = vh - r.bottom - 12, above = r.top - 12;
    const natural = Math.min(el.scrollHeight + 2, 300);
    const up = below < natural && above > below;
    el.style.maxHeight = Math.max(120, Math.min(300, up ? above : below)) + "px";
    const width = Math.max(r.width, 200);
    el.style.width = width + "px";
    el.style.left = Math.max(8, Math.min(r.left, vw - width - 8)) + "px";
    if (up) { el.style.top = "auto"; el.style.bottom = (vh - r.top + 4) + "px"; }
    else { el.style.bottom = "auto"; el.style.top = (r.bottom + 4) + "px"; }
  }
  function show(anchor, el, onHide) {
    hide();
    document.body.appendChild(el);
    cur = { anchor, el, onHide };
    place();
  }
  function hide() {
    if (!cur) return;
    const c = cur; cur = null;
    c.el.remove();
    c.onHide && c.onHide();
  }
  window.addEventListener("resize", place);
  document.addEventListener("scroll", e => { if (cur && !cur.el.contains(e.target)) place(); }, true);
  document.addEventListener("pointerdown", e => {
    if (cur && !cur.el.contains(e.target) && !cur.anchor.contains(e.target)) hide();
  });
  return { show, hide, place, owns: el => cur && cur.el === el };
})();

function dropdown({ anchor, keyTarget, getItems, renderItem, onPick }) {
  const el = document.createElement("div");
  el.className = "dd-list";
  el.setAttribute("role", "listbox");
  let items = [], active = -1;

  function render() {
    items = getItems();
    el.innerHTML = items.length ? "" : '<div class="dd-empty">No matches</div>';
    items.forEach((it, i) => {
      const o = document.createElement("div");
      o.className = "dd-opt" + (i === active ? " active" : "");
      o.setAttribute("role", "option");
      o.innerHTML = renderItem(it);
      o.addEventListener("pointerdown", e => { e.preventDefault(); pick(i); });
      el.appendChild(o);
    });
    el.scrollTop = 0;
    Popover.place();
  }
  const isOpen = () => Popover.owns(el);
  function open() {
    active = -1;
    keyTarget.setAttribute("aria-expanded", "true");
    Popover.show(anchor, el, () => keyTarget.setAttribute("aria-expanded", "false"));
    render();
  }
  function pick(i) {
    const it = items[i];
    Popover.hide();
    if (it) onPick(it);
  }
  function highlight() {
    [...el.children].forEach((c, i) => c.classList.toggle("active", i === active));
    const a = el.children[active];
    if (a) a.scrollIntoView({ block: "nearest" });
  }
  keyTarget.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen()) open();
      if (!items.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      highlight();
    } else if (e.key === "Enter" && isOpen()) {
      e.preventDefault();
      pick(active >= 0 ? active : 0);
    } else if (e.key === "Escape") {
      Popover.hide();
    }
  });
  return { open, render, isOpen, close: () => isOpen() && Popover.hide() };
}

const $ = id => document.getElementById(id);
let selected = null;
let mode = "pan";
let surface = false;

function setMode(m) {
  if (m === "bomb" && !selected) { nudgeToast(); m = "pan"; }
  mode = m;
  const pan = mode === "pan";
  modeBtn.classList.toggle("on", pan);
  modeBtn.setAttribute("aria-pressed", String(pan));
  modeBtn.title = pan ? "Pan mode is on. Click to arm the selected weapon." : "Pan mode: move the map without dropping bombs";
  $("map").classList.toggle("pan-mode", pan);
  if (pan) map.doubleClickZoom.enable(); else map.doubleClickZoom.disable();
  updateToast();
}

function updateToast() {
  $("toast").textContent = !selected ? "Pick a weapon from the list to begin."
    : mode === "pan" ? `Pan mode. ${selected.name} is disarmed; click the mouse button to re-arm.`
    : `${selected.name} armed. Click the map to detonate.`;
}

const isPhone = () => window.matchMedia("(max-width: 760px)").matches;

function setSidebar(open) {
  $("app").classList.toggle("side-closed", !open);
  $("sidebar").inert = !open;
  sideBtn.setAttribute("aria-expanded", String(open));
  sideBtn.title = open ? "Hide weapons panel" : "Show weapons panel";
}

function nudgeToast() {
  const t = $("toast");
  t.classList.remove("nudge");
  void t.offsetWidth;
  t.classList.add("nudge");
}
const filters = { country: "all", cat: "all", type: "all", q: "" };
const detonations = [];

const cityInput = $("citySearch");
const cityDD = dropdown({
  anchor: cityInput, keyTarget: cityInput,
  getItems() {
    const q = cityInput.value.trim().toLowerCase();
    const list = CITIES.filter(c => c[0].toLowerCase().includes(q));
    return list.sort((a, b) => {
      const sa = a[0].toLowerCase().startsWith(q), sb = b[0].toLowerCase().startsWith(q);
      return sa !== sb ? (sa ? -1 : 1) : b[3] - a[3];
    });
  },
  renderItem: c => `<span class="lbl">${esc(c[0])}</span><span class="dd-sub">${c[3]}M</span>`,
  onPick(c) {
    cityInput.value = c[0];
    cityInput.blur();
    map.flyTo([c[1], c[2]], 11, { duration: 1.2 });
  },
});
cityInput.addEventListener("focus", () => cityDD.open());
cityInput.addEventListener("input", () => cityDD.isOpen() ? cityDD.render() : cityDD.open());

const countryBtn = $("countryBtn");
function countryCounts() {
  const counts = {};
  for (const b of WEAPONS) counts[b.c] = (counts[b.c] || 0) + 1;
  return counts;
}
function renderCountryBtn() {
  const c = filters.country;
  countryBtn.innerHTML = c === "all"
    ? '<span class="globe" aria-hidden="true"></span><span class="lbl">All countries</span>'
    : `${flagImg(c)}<span class="lbl">${esc(COUNTRIES[c])}</span>`;
}
const countryDD = dropdown({
  anchor: countryBtn, keyTarget: countryBtn,
  getItems() {
    const counts = countryCounts();
    const list = Object.keys(counts).sort((a, b) => COUNTRIES[a].localeCompare(COUNTRIES[b]));
    return [{ code: "all", n: WEAPONS.length }, ...list.map(code => ({ code, n: counts[code] }))];
  },
  renderItem: it => (it.code === "all"
    ? '<span class="globe" aria-hidden="true"></span><span class="lbl">All countries</span>'
    : `${flagImg(it.code)}<span class="lbl">${esc(COUNTRIES[it.code])}</span>`) +
    `<span class="dd-sub">${it.n}</span>`,
  onPick(it) { filters.country = it.code; renderCountryBtn(); renderBombList(); },
});
countryBtn.addEventListener("click", () => countryDD.isOpen() ? countryDD.close() : countryDD.open());

const catBtn = $("catBtn");
const CAT_ICON = '<span class="cat-dot" aria-hidden="true"></span>';
function renderCatBtn() {
  const c = filters.cat;
  catBtn.innerHTML = `${CAT_ICON}<span class="lbl">${c === "all" ? "All types" : esc(CATEGORIES[c].label)}</span>`;
  catBtn.classList.toggle("nuclear", c !== "all" && CATEGORIES[c].nuclear);
}
const catDD = dropdown({
  anchor: catBtn, keyTarget: catBtn,
  getItems() {
    const counts = {};
    for (const b of WEAPONS) counts[b.cat] = (counts[b.cat] || 0) + 1;
    return [{ code: "all", n: WEAPONS.length },
      ...Object.keys(CATEGORIES).filter(c => counts[c]).map(code => ({ code, n: counts[code] }))];
  },
  renderItem: it => `<span class="cat-dot${it.code !== "all" && CATEGORIES[it.code].nuclear ? " nuclear" : ""}" aria-hidden="true"></span>` +
    `<span class="lbl">${it.code === "all" ? "All types" : esc(CATEGORIES[it.code].label)}</span>` +
    `<span class="dd-sub">${it.n}</span>`,
  onPick(it) { filters.cat = it.code; renderCatBtn(); renderBombList(); },
});
catBtn.addEventListener("click", () => catDD.isOpen() ? catDD.close() : catDD.open());

$("typeSeg").addEventListener("click", e => {
  const v = e.target.closest("button")?.dataset.v;
  if (!v) return;
  filters.type = v;
  for (const b of $("typeSeg").children) b.classList.toggle("on", b.dataset.v === v);
  renderBombList();
});
$("bombSearch").addEventListener("input", e => { filters.q = e.target.value.trim().toLowerCase(); renderBombList(); });

const BOMBS_SORTED = [...WEAPONS].sort((a, b) => (b.popular - a.popular) || a.kt - b.kt);
const BOMBS_BY_ID = new Map(WEAPONS.map(b => [b.id, b]));
for (const b of WEAPONS) b.search = [b.name, COUNTRIES[b.c], CATEGORIES[b.cat].label, CATEGORIES[b.cat].tag].join(" ").toLowerCase();
const bombRows = new Map();

function bombRow(b) {
  let btn = bombRows.get(b.id);
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bomb";
    btn.dataset.id = b.id;
    btn.innerHTML = `${flagImg(b.c)}<span class="name">${esc(b.name)}</span>
      <span class="yield">${b.est ? "~" : ""}${fmtYield(b.kt)}</span>
      <span class="meta"><span class="tag ${b.type}">${esc(CATEGORIES[b.cat].tag)}</span><span class="origin">${esc(COUNTRIES[b.c])} · ${esc(b.year)}</span></span>${
      b.popular ? '<span class="pop">Popular</span>' : ""}`;
    bombRows.set(b.id, btn);
  }
  btn.classList.toggle("active", !!selected && selected.id === b.id);
  return btn;
}

function renderBombList() {
  const { country, cat, type, q } = filters;
  const list = BOMBS_SORTED.filter(b =>
    (country === "all" || b.c === country) && (cat === "all" || b.cat === cat) &&
    (type === "all" || b.type === type) && (!q || b.search.includes(q)));
  $("bombCount").textContent = `${list.length} of ${WEAPONS.length}`;
  const frag = document.createDocumentFragment();
  for (const b of list) frag.appendChild(bombRow(b));
  if (!list.length) frag.appendChild(Object.assign(document.createElement("div"), {
    className: "empty", textContent: "No weapons match these filters." }));
  $("bombList").replaceChildren(frag);
}

$("bombList").addEventListener("click", e => {
  const btn = e.target.closest(".bomb");
  if (!btn) return;
  selected = BOMBS_BY_ID.get(btn.dataset.id);
  for (const x of $("bombList").querySelectorAll(".bomb.active")) x.classList.remove("active");
  btn.classList.add("active");
  renderDetails();
  setMode("bomb");
  if (isPhone()) setSidebar(false);
});

function renderDetails() {
  const b = selected;
  if (!b) {
    $("details").innerHTML = '<div class="empty">No weapon selected yet. Pick one from the list above.</div>';
    updateToast();
    return;
  }
  const eff = effectsFor(b, surface);
  const hiro = b.kt / 15;
  const compare = hiro >= 0.01
    ? `${hiro.toLocaleString(undefined, { maximumFractionDigits: hiro < 10 ? 2 : 0 })}× Hiroshima`
    : `${fmtYield(b.kt)} of TNT`;
  $("details").innerHTML = `
    <div class="d-head">${b.c ? flagImg(b.c) : ""}<b>${esc(b.name)}</b></div>
    <div class="d-stats">
      <div><span>Yield</span><b>${b.est ? "~" : ""}${fmtYield(b.kt)}</b></div>
      <div><span>Scale</span><b>${compare}</b></div>
      <div><span>1 psi ring</span><b>${fmtKm(eff.find(e => e.key === "psi1").radius)}</b></div>
    </div>
    <p>${esc(b.desc)}${b.est ? ' <span class="est">Yield is an estimate.</span>' : ""}</p>`;
  updateToast();
}

function useCustomYield() {
  const input = $("customYield"), err = $("customErr");
  const raw = input.value.trim();
  const kt = Number(raw);
  let problem = "";
  if (!raw) problem = "Enter a yield in kilotons, for example 15 for Hiroshima.";
  else if (!Number.isFinite(kt) || kt <= 0) problem = "The yield must be a number above zero.";
  else if (kt < MIN_KT) problem = `That's too small. The minimum is ${MIN_KT} kt (10 g of TNT).`;
  else if (kt > MAX_KT) problem = `That's too big. The maximum is ${MAX_KT.toLocaleString()} kt (1,000 megatons).`;
  err.textContent = problem;
  err.hidden = !problem;
  input.setAttribute("aria-invalid", String(!!problem));
  if (problem) { input.focus(); return; }
  selected = { id: "custom", name: "Custom device", kt, type: kt >= 0.1 ? "nuclear" : "conventional",
    c: null, year: "—", desc: "A hypothetical weapon with the yield you entered." };
  renderBombList(); renderDetails();
  setMode("bomb");
}
$("customBtn").addEventListener("click", useCustomYield);
$("customYield").addEventListener("keydown", e => { if (e.key === "Enter") useCustomYield(); });
$("customYield").addEventListener("input", () => { $("customErr").hidden = true; });

$("burstSeg").addEventListener("click", e => {
  const v = e.target.closest("button")?.dataset.v;
  if (!v) return;
  surface = v === "surface";
  for (const btn of $("burstSeg").children) btn.classList.toggle("on", btn.dataset.v === v);
  if (selected) renderDetails();
});

const EMPTY_LEGEND = '<div class="empty">Nothing dropped yet.</div>';
$("clearBtn").addEventListener("click", () => {
  map.closePopup();
  for (const d of detonations) d.layer.remove();
  detonations.length = 0;
  growing.length = 0;
  FX.clear();
  updateStats();
  $("legend").innerHTML = EMPTY_LEGEND;
});

function renderLegend(det) {
  const sorted = [...det.effects].sort((a, b) => a.radius - b.radius);
  $("legend").innerHTML = sorted.map(e => `
    <div class="lg"><span class="sw"></span>
    <span><span class="lg-l">${esc(e.label)}</span><span class="lg-i">${esc(e.info)}</span></span>
    <span class="r">${fmtKm(e.radius)}</span></div>`).join("");
  $("legend").querySelectorAll(".sw").forEach((sw, i) => {
    sw.style.borderColor = sorted[i].color;
    sw.style.background = sorted[i].color + "33";
  });
}

const shown = { dead: 0, inj: 0, area: 0, cost: 0, exposed: 0 };
let tweenId = 0;
function paintStats() {
  $("sDead").textContent = fmtNum(shown.dead);
  $("sInj").textContent = fmtNum(shown.inj);
  $("sArea").textContent = (shown.area >= 100 ? fmtNum(shown.area) : shown.area.toFixed(2)) + " km²";
  $("sCost").textContent = fmtMoney(shown.cost);
  $("sPop").textContent = fmtNum(shown.exposed);
}
let statsQueued = false;
function updateStats() {
  if (statsQueued) return;
  statsQueued = true;
  requestAnimationFrame(() => { statsQueued = false; refreshStats(); });
}

function refreshStats() {
  const target = computeTotals(detonations);
  $("sCount").textContent = detonations.length;
  $("stStatus").textContent = detonations.some(d => !d.points) ? "Counting…" : "";
  $("stSrc").textContent = detonations.some(d => d.source === "model")
    ? "Population: rough city model (WorldPop data couldn't be reached)"
    : "Population: WorldPop 2020, 100 m grid";
  const from = { ...shown }, start = performance.now(), id = ++tweenId;
  const dur = FX.reduced ? 0 : 900;
  (function step(now) {
    if (id !== tweenId) return;
    const k = dur ? Math.min(1, (now - start) / dur) : 1;
    const ease = 1 - Math.pow(1 - k, 3);
    for (const key in shown) shown[key] = from[key] + (target[key] - from[key]) * ease;
    paintStats();
    if (k < 1) requestAnimationFrame(step);
  })(start);
}
$("statsToggle").addEventListener("click", () => {
  const collapsed = $("stats").classList.toggle("collapsed");
  $("statsToggle").setAttribute("aria-expanded", String(!collapsed));
  $("statsToggle").setAttribute("aria-label", collapsed ? "Show details" : "Hide details");
});
if (window.matchMedia("(max-width: 760px)").matches) $("stats").classList.add("collapsed");

function flash(kt) {
  if (FX.reduced) return;
  const f = $("flash");
  f.style.transition = "none";
  f.style.opacity = Math.min(0.7, 0.12 + Math.log10(kt * 1000 + 1) * 0.08);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    f.style.transition = "opacity 0.9s ease-out"; f.style.opacity = 0;
  }));
}

let mapZooming = false;
map.on("zoomstart", () => { mapZooming = true; });
map.on("zoomend moveend", () => { mapZooming = false; });

const CenteredCircle = L.Circle.extend({
  _project() {
    const lat = this._latlng.lat;
    const metersPerPx = 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, this._map.getZoom()));
    this._point = this._map.latLngToLayerPoint(this._latlng);
    this._radius = this._radiusY = this._mRadius / metersPerPx;
    this._updateBounds();
  },
});

const growing = [];
let growRaf = 0;
function growRings(circles, radiiM) {
  growing.push({ circles, radiiM, t0: performance.now(), dur: FX.reduced ? 1 : 1400 });
  if (!growRaf) growRaf = requestAnimationFrame(growStep);
}
function growStep(now) {
  if (!mapZooming) {
    for (let i = growing.length - 1; i >= 0; i--) {
      const g = growing[i];
      const p = Math.min(1, (now - g.t0) / g.dur);
      const ease = 1 - Math.pow(1 - p, 3);
      g.circles.forEach((c, k) => c.setRadius(g.radiiM[k] * ease));
      if (p >= 1) growing.splice(i, 1);
    }
  }
  growRaf = growing.length ? requestAnimationFrame(growStep) : 0;
}

function detonate(latlng) {
  if (detonations.length >= MAX_DETONATIONS) {
    $("toast").textContent = `That's ${MAX_DETONATIONS} bombs, the most the map can hold. Use Clear all to start again.`;
    nudgeToast();
    return;
  }
  const bomb = selected;
  const effects = effectsFor(bomb, surface);
  const group = L.layerGroup().addTo(map);
  const sorted = [...effects].sort((a, b) => b.radius - a.radius);
  const circles = sorted.map(e => new CenteredCircle(latlng, {
    radius: 0, color: e.color, weight: 2, fillColor: e.color,
    fillOpacity: e.key === "fireball" ? 0.45 : 0.14, interactive: false,
  }).addTo(group));

  growRings(circles, sorted.map(e => e.radius * 1000));

  const det = { lat: latlng.lat, lon: latlng.lng, bomb, surface, effects, layer: group,
    outer: sorted[0].radius, zones: buildZones(effects), points: null, source: null };
  detonations.push(det);
  const psi5 = effects.find(e => e.key === "psi5").radius;
  FX.spawn(latlng, { nuclear: bomb.type === "nuclear", sizeKm: psi5 });
  FX.shake($("map"), bomb.kt);
  flash(bomb.kt);
  renderLegend(det);

  updateStats();
  loadPopulation(det).then(() => { if (detonations.includes(det)) updateStats(); });

  const marker = L.marker(latlng, {
    icon: L.divIcon({ className: "gz-wrap", html: '<div class="gz"></div>', iconSize: [14, 14] }),
    title: "Ground zero",
  }).addTo(group);
  marker.bindPopup(() => {
    let rows = '<div class="muted">Counting population…</div>';
    if (det.points) {
      const all = computeTotals(detonations);
      const without = computeTotals(detonations.filter(d => d !== det));
      rows = `<div class="pp"><span>Fatalities</span><b>${fmtNum(all.dead - without.dead)}</b></div>
        <div class="pp"><span>Injuries</span><b>${fmtNum(all.inj - without.inj)}</b></div>`;
    }
    return `<div class="det-popup">
      <div class="d-head">${bomb.c ? flagImg(bomb.c) : ""}<b>${esc(bomb.name)}</b></div>
      <div class="muted">${fmtYield(bomb.kt)} · ${det.surface ? "surface burst" : "airburst"}</div>
      ${rows}
      <button type="button" class="btn rm">Remove this detonation</button></div>`;
  });
  marker.on("popupopen", ev => {
    ev.popup.getElement().querySelector(".rm").onclick = () => {
      map.closePopup();
      group.remove();
      const i = detonations.indexOf(det);
      if (i < 0) return;
      detonations.splice(i, 1);
      updateStats();
      $("legend").innerHTML = detonations.length ? "" : EMPTY_LEGEND;
      if (detonations.length) renderLegend(detonations[detonations.length - 1]);
    };
  });

  const bounds = latlng.toBounds(sorted[0].radius * 2000);
  const pad = mapPadding();
  const free = map.getSize().subtract(pad.tl).subtract(pad.br);
  if (free.x < 40 || free.y < 40) return;
  const visible = L.latLngBounds(
    map.containerPointToLatLng(pad.tl),
    map.containerPointToLatLng(map.getSize().subtract(pad.br)));
  if (!visible.contains(bounds)) {
    map.flyToBounds(bounds, { duration: 0.8, paddingTopLeft: pad.tl, paddingBottomRight: pad.br });
  }
}

function mapPadding() {
  const open = !$("app").classList.contains("side-closed");
  if (isPhone()) {
    return { tl: L.point(16, 90), br: L.point(16, open ? $("sidebar").offsetHeight + 24 : 24) };
  }
  return { tl: L.point(open ? $("sidebar").offsetWidth + 70 : 70, 20), br: L.point(20, 20) };
}

map.on("click", e => {
  if (mode === "bomb" && selected) detonate(e.latlng);
  else if (!selected) nudgeToast();
});

renderCountryBtn();
renderCatBtn();
renderBombList();
$("wCount").textContent = `${Math.max(50, Math.floor(WEAPONS.length / 50) * 50)}+`;
renderDetails();
setMode("pan");
setSidebar(true);

function openWelcome() {
  Popover.hide();
  $("welcome").hidden = false;
  $("app").inert = true;
  $("wStart").focus();
}
function closeWelcome() {
  $("welcome").hidden = true;
  $("app").inert = false;
}
$("wStart").addEventListener("click", closeWelcome);
$("aboutBtn").addEventListener("click", openWelcome);
$("welcome").addEventListener("click", e => { if (e.target === $("welcome")) closeWelcome(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("welcome").hidden) closeWelcome(); });
openWelcome();
$("legend").innerHTML = EMPTY_LEGEND;
