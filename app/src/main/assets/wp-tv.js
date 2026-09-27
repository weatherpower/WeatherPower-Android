/* WeatherPower for Android TV: 10-foot UI with D-pad focus navigation.
 * Screens: Live Radar, Tropical, Alerts, Forecast, Models, Ambient.
 * Live Radar keys: arrows pan · OK zoom in · Back zoom out (at the start zoom, Back/Menu moves to the layer bar). */
(function () {
  "use strict";
  const X = window.WPX;
  if (!X) return;
  const { esc, escA, say, getJson, timeLabel, fc } = X;

  const SCREENS = [
    ["radar", "Live Radar", "📡"],
    ["tropical", "Tropical", "🌀"],
    ["alerts", "Alerts", "⚠️"],
    ["forecast", "Forecast", "🌤"],
    ["models", "Models", "🧭"],
    ["ambient", "Ambient", "🖼"]
  ];
  const IDLE_TO_AMBIENT_MS = 10 * 60 * 1000;

  const TV = {
    active: false,
    screen: "radar",
    root: null,
    main: null,
    sub: null, // screen-local sub view (e.g. alert detail)
    idleTimer: 0,
    ambient: null,
    radar: { map: null, baseZoom: 6, mapMode: false, layers: { refl: true, warnings: true, vel: false, hail: false, rot: false, tropical: false }, loop: true, frame: 0, timer: 0, frames: [], velSite: "", velTime: "" },
    models: { map: null, playing: false, timer: 0 }
  };
  const saved = X.prefs.tv = Object.assign({ screen: "radar", layers: null }, X.prefs.tv || {});
  if (saved.layers) Object.assign(TV.radar.layers, saved.layers);

  /* ---------- Focus engine ---------- */
  const FOCUSABLE = "button:not([disabled]), [tabindex]:not([tabindex='-1']), select:not([disabled]), input:not([disabled]), a[href]";

  function visible(el) {
    if (!el || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function focusables(scope) {
    const root = X.topOverlay() && !X.topOverlay().el.contains(TV.root) ? X.topOverlay().el : (scope || TV.root);
    // Map canvases and their attribution buttons are not D-pad targets; "Move map" drives the radar map.
    return root ? [...root.querySelectorAll(FOCUSABLE)].filter(el => visible(el) && !el.closest(".maplibregl-map")) : [];
  }

  function focusEl(el) {
    if (!el) return false;
    try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
    try { el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" }); } catch (_) {}
    return document.activeElement === el;
  }

  function focusFirst(scope) {
    const list = focusables(scope);
    const preferred = list.find(el => el.classList.contains("active") && !el.closest(".wpx-tv-rail")) || list[0];
    return focusEl(preferred);
  }

  function railButton(screen = TV.screen) {
    return TV.root?.querySelector(`.wpx-tv-rail [data-screen="${screen}"]`);
  }

  function refocus() {
    if (!TV.active) return;
    if (X.topOverlay()) { focusFirst(X.topOverlay().el); return; }
    if (!TV.root.contains(document.activeElement) || document.activeElement === document.body) {
      if (!focusFirst(TV.main)) focusEl(railButton());
    }
  }

  function moveFocus(dir) {
    const current = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    const list = focusables();
    if (!current || !list.includes(current)) return focusFirst();
    const r = current.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let best = null, bestScore = Infinity;
    list.forEach(el => {
      if (el === current) return;
      const b = el.getBoundingClientRect();
      const ex = b.left + b.width / 2, ey = b.top + b.height / 2;
      const dx = ex - cx, dy = ey - cy;
      let primary, secondary;
      if (dir === "left") { if (b.right > r.left + 4 && dx >= -4) return; primary = r.left - b.right; secondary = Math.abs(dy); }
      else if (dir === "right") { if (b.left < r.right - 4 && dx <= 4) return; primary = b.left - r.right; secondary = Math.abs(dy); }
      else if (dir === "up") { if (b.bottom > r.top + 4 && dy >= -4) return; primary = r.top - b.bottom; secondary = Math.abs(dx); }
      else { if (b.top < r.bottom - 4 && dy <= 4) return; primary = b.top - r.bottom; secondary = Math.abs(dx); }
      const score = Math.max(0, primary) + secondary * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    });
    if (best) return focusEl(best);
    // Leaving the content area to the left always lands on the navigation rail.
    if (dir === "left" && !current.closest(".wpx-tv-rail")) return focusEl(railButton());
    return false;
  }

  /* ---------- Shell ---------- */
  function build() {
    document.documentElement.classList.add("wpx-tv-active");
    // TVs report ~960x540 CSS px at xhdpi; lay the 10-foot UI out on a 1920-wide canvas and let WebView scale it.
    const viewport = document.querySelector('meta[name="viewport"]');
    if (viewport) viewport.setAttribute("content", "width=1920, user-scalable=no");
    const root = document.createElement("div");
    root.id = "wpxTv";
    root.className = "wpx-tv";
    root.innerHTML = `
      <nav class="wpx-tv-rail" aria-label="WeatherPower TV">
        <div class="wpx-tv-brand"><img src="icon-192.png" alt=""><span>WeatherPower</span></div>
        ${SCREENS.map(([id, label, glyph]) => `<button class="wpx-tv-nav" data-screen="${id}" data-wpx="tvScreen"><span class="wpx-tv-glyph" aria-hidden="true">${glyph}</span><span>${esc(label)}</span></button>`).join("")}
        <div class="wpx-tv-rail-foot"><div class="wpx-tv-clock" id="wpxTvClock"></div><div class="wpx-tv-loc" id="wpxTvLoc"></div></div>
      </nav>
      <main class="wpx-tv-main" id="wpxTvMain"></main>`;
    document.body.appendChild(root);
    TV.root = root;
    TV.main = root.querySelector("#wpxTvMain");
    tickClock();
    setInterval(tickClock, 15000);
  }

  function tickClock() {
    const clock = document.getElementById("wpxTvClock");
    if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const loc = document.getElementById("wpxTvLoc");
    if (loc) loc.textContent = state.location?.name || "";
    const amb = document.getElementById("wpxAmbClock");
    if (amb) amb.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function leaveScreen() {
    stopRadarLoop();
    try { TV.radar.map && TV.radar.map.remove(); } catch (_) {}
    TV.radar.map = null;
    TV.radar.mapMode = false;
    try { TV.models.map && TV.models.map.remove(); } catch (_) {}
    TV.models.map = null;
    clearInterval(TV.models.timer);
    TV.models.playing = false;
    if (X.tropical) X.tropical.unmount();
    TV.sub = null;
  }

  function show(screen, options = {}) {
    if (screen === "ambient") { enterAmbient(); return; }
    leaveScreen();
    TV.screen = screen;
    saved.screen = screen;
    X.savePrefs();
    TV.root.querySelectorAll(".wpx-tv-nav").forEach(b => b.classList.toggle("active", b.dataset.screen === screen));
    TV.main.className = `wpx-tv-main screen-${screen}`;
    if (screen === "radar") renderRadarScreen();
    else if (screen === "tropical") X.tropical.mount(TV.main, { tv: true });
    else if (screen === "alerts") renderAlerts();
    else if (screen === "forecast") renderForecast();
    else if (screen === "models") renderModels();
    if (options.focusContent) setTimeout(() => focusFirst(TV.main), 60);
  }

  /* ---------- Live Radar ---------- */
  const LOOP_MINUTES = [40, 35, 30, 25, 20, 15, 10, 5, 0];

  function frameTemplates() {
    const anchor = Math.floor((Date.now() - 2 * 60000) / 300000) * 300000;
    const base = typeof NOAA_REFLECTIVITY_EXPORT !== "undefined" ? NOAA_REFLECTIVITY_EXPORT : "https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity/MapServer/export";
    return LOOP_MINUTES.map(mins => {
      const time = anchor - mins * 60000;
      return { mins, time, url: `${base}?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&layers=show:3&f=image&time=${time}` };
    });
  }

  function radarBar() {
    const L = TV.radar.layers;
    const btn = (key, label) => `<button class="wpx-tv-chip${L[key] ? " active" : ""}" data-wpx="tvLayer" data-key="${key}" aria-pressed="${!!L[key]}">${esc(label)}</button>`;
    return `${btn("refl", "Reflectivity")}${btn("vel", "Velocity")}${btn("hail", "MRMS Hail")}${btn("rot", "Rotation")}${btn("warnings", "Warnings")}${btn("tropical", "Tropical")}
      <button class="wpx-tv-chip" data-wpx="tvLoop">${TV.radar.loop ? "⏸ Loop" : "▶ Loop"}</button>
      <button class="wpx-tv-chip" data-wpx="tvRecenter">⌖ Home</button>
      <button class="wpx-tv-chip primary" data-wpx="tvMapMode">✥ Move map</button>`;
  }

  function renderRadarScreen() {
    TV.main.innerHTML = `
      <div class="wpx-tv-radar">
        <div class="wpx-tv-map" id="wpxTvMap" tabindex="-1" aria-label="Radar map. Arrows pan, OK zooms in, Back zooms out."></div>
        <div class="wpx-tv-radar-info"><strong id="wpxTvRadarTitle">Live Radar</strong><span id="wpxTvRadarTime">Loading…</span></div>
        <div class="wpx-tv-radar-hint" id="wpxTvHint">Arrows pan · OK zoom in · Back zoom out</div>
        <div class="wpx-tv-layerbar" id="wpxTvLayerBar">${radarBar()}</div>
      </div>`;
    const mapEl = TV.main.querySelector("#wpxTvMap");
    mapEl.addEventListener("focus", () => setMapMode(true));
    mapEl.addEventListener("blur", () => setMapMode(false));
    if (!window.maplibregl) { mapEl.innerHTML = `<p class="wpx-note">Map unavailable.</p>`; return; }
    const loc = state.location;
    const map = X.quietErrors(new maplibregl.Map({ container: mapEl, style: X.basemapStyle(), center: [loc.longitude, loc.latitude], zoom: TV.radar.baseZoom, attributionControl: false, interactive: false, fadeDuration: 0 }));
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    TV.radar.map = map;
    map.on("load", () => {
      map.addSource("wpx-tv-home", { type: "geojson", data: fc([{ type: "Feature", geometry: { type: "Point", coordinates: [loc.longitude, loc.latitude] }, properties: {} }]) });
      map.addLayer({ id: "wpx-tv-home", type: "circle", source: "wpx-tv-home", paint: { "circle-radius": 8, "circle-color": "#52e0fa", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
      syncRadarLayers();
      if (typeof fetchRadarAlerts === "function") Promise.resolve(fetchRadarAlerts()).then(syncWarnings).catch(() => {});
    });
    setTimeout(() => focusEl(TV.main.querySelector("[data-wpx='tvMapMode']")), 80);
  }

  function setMapMode(on) {
    TV.radar.mapMode = on;
    TV.main.querySelector(".wpx-tv-radar")?.classList.toggle("map-mode", on);
    const hint = document.getElementById("wpxTvHint");
    if (hint) hint.textContent = on ? "Arrows pan · OK zoom in · Back zoom out · Menu for layers" : "Select “Move map” to pan and zoom";
  }

  function syncRadarLayers() {
    const map = TV.radar.map;
    if (!X.mapReady(map)) return;
    const L = TV.radar.layers;
    const before = map.getLayer("wpx-tv-warn-fill") ? "wpx-tv-warn-fill" : map.getLayer("wpx-tv-home") ? "wpx-tv-home" : undefined;

    // Reflectivity loop: one raster source per frame, crossfaded by opacity.
    const frames = L.refl ? frameTemplates() : [];
    TV.radar.frames.forEach((f, i) => X.removeLayerAndSource(map, `wpx-tv-f${i}`));
    TV.radar.frames = frames;
    frames.forEach((f, i) => X.setRaster(map, `wpx-tv-f${i}`, [f.url], { opacity: 0, beforeId: before, attribution: "NOAA/NWS NEXRAD" }));
    TV.radar.frame = frames.length - 1;
    showFrame();
    if (L.refl && TV.radar.loop) startRadarLoop(); else stopRadarLoop();

    const title = document.getElementById("wpxTvRadarTitle");
    if (L.vel) {
      const site = X.radar.sitesByDistance({ latitude: state.location.latitude, longitude: state.location.longitude })[0];
      const loadVel = s => X.radar.l3Template(s.id, "N0G").then(t => {
        TV.radar.velSite = s.id;
        TV.radar.velTime = t.time;
        X.setRaster(map, "wpx-tv-vel", [t.tiles], { opacity: 0.85, beforeId: before, maxzoom: 14 });
        if (title) title.textContent = `Velocity · ${s.id}`;
        updateTimeLabel();
      });
      if (site) loadVel(site);
      else X.radar.loadSites().then(() => { const s = X.radar.sitesByDistance({ latitude: state.location.latitude, longitude: state.location.longitude })[0]; if (s) loadVel(s); });
    } else {
      X.removeLayerAndSource(map, "wpx-tv-vel");
      if (title) title.textContent = "Live Radar";
    }
    [["hail", "hail"], ["rot", "rotation"]].forEach(([key, product]) => {
      if (L[key]) {
        X.radar.mrmsTemplate(product, 60).then(t => { if (t.tiles && TV.radar.map === map) X.setRaster(map, `wpx-tv-${key}`, [t.tiles], { opacity: 0.85, beforeId: before, maxzoom: 12 }); })
          .catch(error => say(`MRMS ${product} unavailable: ${error.message || error}`));
      } else X.removeLayerAndSource(map, `wpx-tv-${key}`);
    });
    if (L.tropical) X.setRaster(map, "wpx-tv-trop", [`${X.API.nhcMapServer}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&format=png32&transparent=true&f=image`], { opacity: 0.9, resampling: "linear", attribution: "NOAA/NHC", beforeId: before });
    else X.removeLayerAndSource(map, "wpx-tv-trop");
    syncWarnings();
    updateTimeLabel();
  }

  function syncWarnings() {
    const map = TV.radar.map;
    if (!X.mapReady(map)) return;
    let data = fc([]);
    if (TV.radar.layers.warnings && typeof alertFeatureCollection === "function") { try { data = alertFeatureCollection(); } catch (_) {} }
    X.setGeoJson(map, "wpx-tv-warn", data);
    X.addLayerOnce(map, { id: "wpx-tv-warn-fill", type: "fill", source: "wpx-tv-warn", paint: { "fill-color": ["coalesce", ["get", "color"], "#ff9f2c"], "fill-opacity": 0.14 } }, "wpx-tv-home");
    X.addLayerOnce(map, { id: "wpx-tv-warn-line", type: "line", source: "wpx-tv-warn", paint: { "line-color": ["coalesce", ["get", "color"], "#ff9f2c"], "line-width": 3 } }, "wpx-tv-home");
  }

  function showFrame() {
    const map = TV.radar.map;
    TV.radar.frames.forEach((f, i) => { try { if (map.getLayer(`wpx-tv-f${i}-layer`)) map.setPaintProperty(`wpx-tv-f${i}-layer`, "raster-opacity", i === TV.radar.frame ? 0.78 : 0); } catch (_) {} });
    updateTimeLabel();
  }

  function updateTimeLabel() {
    const el = document.getElementById("wpxTvRadarTime");
    if (!el) return;
    const f = TV.radar.frames[TV.radar.frame];
    const parts = [];
    if (f) parts.push(f.mins === 0 ? `Latest · ${new Date(f.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : `${new Date(f.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
    if (TV.radar.layers.vel && TV.radar.velTime) parts.push(`${TV.radar.velSite} scan ${timeLabel(TV.radar.velTime)}`);
    el.textContent = parts.join(" · ") || "Radar";
  }

  function startRadarLoop() {
    stopRadarLoop();
    if (!TV.radar.frames.length) return;
    TV.radar.timer = setInterval(() => {
      TV.radar.frame = (TV.radar.frame + 1) % TV.radar.frames.length;
      showFrame();
    }, TV.radar.frame === TV.radar.frames.length - 1 ? 900 : 650);
  }
  function stopRadarLoop() { clearInterval(TV.radar.timer); TV.radar.timer = 0; }

  function panRadar(dx, dy) {
    const map = TV.radar.map;
    if (!map) return;
    const w = map.getContainer().clientWidth, h = map.getContainer().clientHeight;
    map.panBy([dx * w * 0.22, dy * h * 0.22], { duration: 260 });
  }
  function zoomRadar(delta) {
    const map = TV.radar.map;
    if (!map) return;
    map.easeTo({ zoom: Math.max(3, Math.min(12, map.getZoom() + delta)), duration: 320 });
  }

  /* ---------- Alerts ---------- */
  function alertsList() {
    const local = state.alerts || [];
    const national = (state.radarAlerts || []).filter(a => /warning/i.test(a.event || "")).sort((a, b) => (b.rank || 0) - (a.rank || 0)).slice(0, 18);
    return { local, national };
  }

  function alertCard(a, scope) {
    const color = typeof warningColor === "function" ? warningColor(a) : "#ff9f2c";
    const name = typeof displayAlertName === "function" ? displayAlertName(a) : a.event;
    return `<button class="wpx-tv-card alert" style="--c:${escA(color)}" data-wpx="tvAlert" data-id="${escA(a.id)}" data-scope="${scope}"><strong>${esc(name)}</strong><span>${esc((a.area || "").slice(0, 140))}</span><small>${a.expires ? `Until ${esc(timeLabel(a.expires))}` : ""}</small></button>`;
  }

  function renderAlerts() {
    const { local, national } = alertsList();
    TV.main.innerHTML = `<div class="wpx-tv-page">
      <h1>Alerts <small>${esc(state.location.name)}</small></h1>
      <div class="wpx-tv-row wrap">${local.length ? local.map(a => alertCard(a, "local")).join("") : `<div class="wpx-tv-card calm" tabindex="0"><strong>No active alerts</strong><span>No NWS watches, warnings or advisories for ${esc(state.location.name)}.</span></div>`}</div>
      <h2>Active warnings nationwide</h2>
      <div class="wpx-tv-row wrap">${national.length ? national.map(a => alertCard(a, "national")).join("") : `<div class="wpx-tv-card calm" tabindex="0"><span>${TV.nationalLoaded ? "The NWS warning feed returned no active warnings." : "Loading…"}</span></div>`}</div>
      <p class="wpx-note">Source: National Weather Service.</p></div>`;
    if (!TV.nationalLoaded && typeof fetchRadarAlerts === "function") Promise.resolve(fetchRadarAlerts()).catch(() => {}).finally(() => { TV.nationalLoaded = true; if (TV.screen === "alerts" && !TV.sub) { renderAlerts(); refocus(); } });
    if (!state.alerts?.length && typeof fetchAlerts === "function" && !state.alertsLoading) Promise.resolve(fetchAlerts()).then(() => { if (TV.screen === "alerts" && !TV.sub) { renderAlerts(); refocus(); } }).catch(() => {});
  }

  function renderAlertDetail(id) {
    const a = (state.alerts || []).concat(state.radarAlerts || []).find(x => x.id === id);
    if (!a) return;
    TV.sub = { kind: "alert", id };
    const name = typeof displayAlertName === "function" ? displayAlertName(a) : a.event;
    TV.main.innerHTML = `<div class="wpx-tv-page wpx-tv-detail" style="--c:${escA(typeof warningColor === "function" ? warningColor(a) : "#ff9f2c")}">
      <button class="wpx-tv-chip" data-wpx="tvBack">‹ Back to alerts</button>
      <h1>${esc(name)}</h1>
      <div class="wpx-tv-kv"><div><small>Area</small><strong>${esc(a.area)}</strong></div><div><small>Expires</small><strong>${esc(a.expires ? timeLabel(a.expires) : "--")}</strong></div><div><small>Severity</small><strong>${esc(a.severity)}</strong></div><div><small>Issued by</small><strong>${esc(a.sourceOffice || "NWS")}</strong></div></div>
      ${a.headline ? `<p class="lead">${esc(a.headline)}</p>` : ""}
      <div class="wpx-tv-text" tabindex="0">${esc(a.details || "").replaceAll("\n", "<br>")}${a.instruction ? `<h3>What to do</h3>${esc(a.instruction).replaceAll("\n", "<br>")}` : ""}</div>
    </div>`;
    setTimeout(() => focusFirst(TV.main), 40);
  }

  /* ---------- Forecast ---------- */
  function fmtHour(iso) { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric" }); }
  function fmtDay(date) { const d = new Date(`${date}T12:00:00`); return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString([], { weekday: "short" }); }
  const t = v => (v === null || v === undefined || Number.isNaN(Number(v)) ? "--" : `${Math.round(v)}°`);

  function renderForecast() {
    const f = state.forecast;
    if (!f) {
      TV.main.innerHTML = `<div class="wpx-tv-page"><h1>Forecast</h1><p class="lead">${state.loading ? "Loading forecast…" : "Forecast unavailable."}</p>${locationControls()}</div>`;
      if (!state.loading && typeof fetchForecast === "function") fetchForecast();
      return;
    }
    const c = f.current || {};
    TV.main.innerHTML = `<div class="wpx-tv-page">
      <h1>${esc(state.location.name)} <small>${esc(state.location.subtitle || "")}</small></h1>
      <div class="wpx-tv-now" tabindex="0"><div class="big">${t(c.temperature)}</div><div><strong>${esc(c.summary || c.condition || "")}</strong><span>Feels like ${t(c.feelsLike)} · Humidity ${c.humidity ?? "--"}% · Wind ${c.wind != null ? Math.round(c.wind) : "--"} mph${c.gust ? ` gusting ${Math.round(c.gust)}` : ""}</span></div></div>
      <h2>Next 12 hours</h2>
      <div class="wpx-tv-row scroll">${(f.hourly || []).slice(0, 12).map(h => `<div class="wpx-tv-card hour" tabindex="0"><small>${esc(fmtHour(h.time))}</small><strong>${t(h.temperature)}</strong><span>${esc(h.summary || "")}</span><small>${h.pop != null ? `${Math.round(h.pop)}% rain` : ""}</small></div>`).join("")}</div>
      <h2>7 days</h2>
      <div class="wpx-tv-row scroll">${(f.daily || []).slice(0, 7).map(d => `<div class="wpx-tv-card day" tabindex="0"><small>${esc(fmtDay(d.date))}</small><strong>${t(d.high)} <em>${t(d.low)}</em></strong><span>${esc(d.summary || "")}</span><small>${d.pop != null ? `${Math.round(d.pop)}% rain` : ""}</small></div>`).join("")}</div>
      ${locationControls()}
      <p class="wpx-note">Forecast: ${esc(f.source || "WeatherPower")} · updated ${esc(timeLabel(f.fetchedAt))}</p>
    </div>`;
  }

  function locationControls() {
    return `<h2>Location</h2><div class="wpx-tv-row"><input type="search" id="wpxTvLocSearch" class="wpx-tv-input" placeholder="Search city or ZIP" aria-label="Search location"><button class="wpx-tv-chip" data-wpx="tvLocSearch">Search</button></div><div class="wpx-tv-row wrap" id="wpxTvLocResults"></div>`;
  }

  let locResults = [];
  async function searchLocation() {
    const input = document.getElementById("wpxTvLocSearch");
    const box = document.getElementById("wpxTvLocResults");
    if (!input || !box || !input.value.trim()) return;
    box.innerHTML = `<span class="wpx-note">Searching…</span>`;
    try { locResults = await searchLocationsRaw(input.value, 6); } catch (_) { locResults = []; }
    box.innerHTML = locResults.length ? locResults.map((r, i) => `<button class="wpx-tv-chip" data-wpx="tvLocPick" data-i="${i}">${esc(r.name)}${r.subtitle ? `, ${esc(r.subtitle)}` : ""}</button>`).join("") : `<span class="wpx-note">No places found.</span>`;
    focusFirst(box);
  }

  /* ---------- Models ---------- */
  async function renderModels() {
    const S = X.radar.studio;
    TV.main.innerHTML = `<div class="wpx-tv-models"><div class="wpx-tv-map" id="wpxTvModelMap"></div><div class="wpx-tv-model-panel" id="wpxTvModelPanel"><p class="lead">Loading model runs…</p></div></div>`;
    const loc = state.location;
    if (window.maplibregl) {
      TV.models.map = X.quietErrors(new maplibregl.Map({ container: TV.main.querySelector("#wpxTvModelMap"), style: X.basemapStyle(), center: [loc.longitude, loc.latitude], zoom: 4.2, attributionControl: false, interactive: false }));
      TV.models.map.on("load", () => drawModelFrame());
    }
    S.prefs.on = true;
    await S.loadRuns();
    await S.loadHours();
    drawModelPanel();
    drawModelFrame();
    setTimeout(() => focusFirst(TV.main.querySelector("#wpxTvModelPanel")), 60);
  }

  function drawModelPanel() {
    const S = X.radar.studio, P = S.prefs, st = S.state;
    const panel = document.getElementById("wpxTvModelPanel");
    if (!panel) return;
    const runs = (st.runs[P.model] || []).slice(0, 4);
    const fields = st.fields[P.model] || S.FALLBACK_FIELDS;
    const hours = st.hours[`${P.model}/${P.run}`] || [];
    const focusKey = panel.contains(document.activeElement) ? `${document.activeElement.dataset.wpx}|${document.activeElement.dataset.id || document.activeElement.dataset.d || ""}` : "";
    panel.innerHTML = `
      <h1>Model Studio</h1>
      <div class="wpx-tv-row wrap">${S.MODELS.map(m => `<button class="wpx-tv-chip${P.model === m.id ? " active" : ""}" data-wpx="tvModel" data-id="${m.id}">${esc(m.label)}</button>`).join("")}</div>
      ${st.error ? `<p class="wpx-note">${esc(st.error)}</p>` : ""}
      <h2>Run</h2><div class="wpx-tv-row wrap">${runs.map(r => `<button class="wpx-tv-chip${P.run === r.id ? " active" : ""}" data-wpx="tvRun" data-id="${escA(r.id)}">${esc(timeLabel(r.id) || r.id)}</button>`).join("") || `<span class="wpx-note">No runs available</span>`}</div>
      <h2>Field</h2><div class="wpx-tv-row wrap">${fields.map(f => `<button class="wpx-tv-chip${P.field === f.id ? " active" : ""}" data-wpx="tvField" data-id="${escA(f.id)}">${esc(f.label)}</button>`).join("")}</div>
      <h2 id="wpxTvModelHour">F${String(P.fhr).padStart(2, "0")}${st.frame?.valid ? ` · valid ${esc(timeLabel(st.frame.valid))}` : ""} <small>${hours.length ? `of ${hours.length} hours` : ""}</small></h2>
      <div class="wpx-tv-row"><button class="wpx-tv-chip" data-wpx="tvModelStep" data-d="-1">‹ Hour</button><button class="wpx-tv-chip primary" data-wpx="tvModelPlay">${TV.models.playing ? "⏸ Pause" : "▶ Play"}</button><button class="wpx-tv-chip" data-wpx="tvModelStep" data-d="1">Hour ›</button></div>
      <p class="wpx-note">Model output from the WeatherPower model service (NOAA/NCEP, ECMWF open data).</p>`;
    if (focusKey) {
      const again = [...panel.querySelectorAll("[data-wpx]")].find(el => `${el.dataset.wpx}|${el.dataset.id || el.dataset.d || ""}` === focusKey);
      if (again) focusEl(again); else focusFirst(panel);
    }
  }

  async function drawModelFrame() {
    const S = X.radar.studio, P = S.prefs;
    const map = TV.models.map;
    if (!P.run || !P.field) return;
    const want = `${P.model}/${P.run}/${P.field}/${P.fhr}`;
    TV.models.want = want;
    const frame = await S.fetchFrameSpec(P.model, P.run, P.field, P.fhr);
    if (TV.models.want !== want) return;
    S.state.frame = frame;
    if (X.mapReady(map)) S.drawFrame(map, frame, 0.75);
    const h = document.getElementById("wpxTvModelHour");
    if (h) h.firstChild.textContent = `F${String(P.fhr).padStart(2, "0")}${frame.valid ? ` · valid ${timeLabel(frame.valid)}` : ""} `;
  }

  function stepModel(delta) {
    const S = X.radar.studio, P = S.prefs;
    const hours = S.state.hours[`${P.model}/${P.run}`] || [];
    if (!hours.length) return;
    let i = hours.indexOf(Number(P.fhr));
    P.fhr = hours[(i + delta + hours.length) % hours.length];
    X.savePrefs();
    drawModelFrame();
  }

  function setModelPlaying(on) {
    TV.models.playing = on;
    clearInterval(TV.models.timer);
    if (on) TV.models.timer = setInterval(() => stepModel(1), 1400);
    drawModelPanel();
  }

  /* ---------- Ambient ---------- */
  function enterAmbient() {
    if (TV.ambient) return;
    const el = document.createElement("div");
    el.className = "wpx-tv-ambient";
    el.innerHTML = `<div class="wpx-tv-map" id="wpxAmbMap"></div><div class="wpx-amb-card"><div class="wpx-amb-clock" id="wpxAmbClock"></div><div id="wpxAmbWx"></div></div><div class="wpx-amb-ticker" id="wpxAmbTicker"></div>`;
    document.body.appendChild(el);
    TV.ambient = { el, map: null, frames: [], frame: 0, timer: 0, refresh: 0 };
    tickClock();
    ambientText();
    if (window.maplibregl) {
      const loc = state.location;
      const map = X.quietErrors(new maplibregl.Map({ container: el.querySelector("#wpxAmbMap"), style: X.basemapStyle(), center: [loc.longitude, loc.latitude], zoom: 5.6, attributionControl: false, interactive: false, fadeDuration: 0 }));
      TV.ambient.map = map;
      map.on("load", () => {
        const frames = frameTemplates();
        TV.ambient.frames = frames;
        frames.forEach((f, i) => X.setRaster(map, `wpx-amb-f${i}`, [f.url], { opacity: 0 }));
        let data = fc([]);
        try { if (typeof alertFeatureCollection === "function") data = alertFeatureCollection(); } catch (_) {}
        X.setGeoJson(map, "wpx-amb-warn", data);
        X.addLayerOnce(map, { id: "wpx-amb-warn", type: "line", source: "wpx-amb-warn", paint: { "line-color": ["coalesce", ["get", "color"], "#ff9f2c"], "line-width": 2.5 } });
        TV.ambient.frame = frames.length - 1;
        TV.ambient.timer = setInterval(() => {
          const a = TV.ambient;
          if (!a) return;
          a.frame = (a.frame + 1) % a.frames.length;
          a.frames.forEach((f, i) => { try { map.setPaintProperty(`wpx-amb-f${i}-layer`, "raster-opacity", i === a.frame ? 0.75 : 0); } catch (_) {} });
        }, 800);
      });
    }
    // Slowly drift and refresh so a TV left on ambient stays current and avoids burn-in.
    TV.ambient.refresh = setInterval(() => {
      ambientText();
      const card = el.querySelector(".wpx-amb-card");
      if (card) card.style.transform = `translate(${Math.round(Math.random() * 40 - 20)}px, ${Math.round(Math.random() * 30 - 15)}px)`;
    }, 60000);
    setTimeout(() => {
      if (!TV.ambient) return;
      const map = TV.ambient.map;
      clearInterval(TV.ambient.timer);
      try { map && map.remove(); } catch (_) {}
      const current = TV.ambient;
      TV.ambient = null;
      current.el.remove();
      if (TV.active) enterAmbient();
    }, 30 * 60000);
  }

  function ambientText() {
    const wx = document.getElementById("wpxAmbWx");
    if (wx) {
      const c = state.forecast?.current || {};
      const today = state.forecast?.daily?.[0];
      wx.innerHTML = `<div class="wpx-amb-temp">${t(c.temperature)}</div><div class="wpx-amb-sum">${esc(c.summary || "")}</div><div class="wpx-amb-loc">${esc(state.location.name)}${today ? ` · H ${t(today.high)} L ${t(today.low)}` : ""}</div>`;
    }
    const ticker = document.getElementById("wpxAmbTicker");
    if (ticker) {
      const alerts = (state.alerts || []).map(a => (typeof displayAlertName === "function" ? displayAlertName(a) : a.event));
      const storms = X.tropical?.state?.storms || [];
      const items = alerts.map(a => `⚠ ${a}`).concat(storms.map(s => `🌀 ${s.name}`));
      ticker.textContent = items.length ? items.join("   ·   ") : "";
      ticker.hidden = !items.length;
    }
  }

  function exitAmbient() {
    const a = TV.ambient;
    if (!a) return false;
    clearInterval(a.timer);
    clearInterval(a.refresh);
    try { a.map && a.map.remove(); } catch (_) {}
    a.el.remove();
    TV.ambient = null;
    refocus();
    return true;
  }

  function resetIdle() {
    clearTimeout(TV.idleTimer);
    TV.idleTimer = setTimeout(() => { if (TV.active && !TV.ambient) enterAmbient(); }, IDLE_TO_AMBIENT_MS);
  }

  /* ---------- Keys ---------- */
  function onKeyDown(event) {
    if (!TV.active) return;
    resetIdle();
    if (TV.ambient) {
      event.preventDefault();
      event.stopPropagation();
      exitAmbient();
      return;
    }
    const key = event.key;
    const active = document.activeElement;
    const dirs = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

    if (TV.screen === "radar" && TV.radar.mapMode && !X.topOverlay()) {
      const pan = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
      if (pan) { event.preventDefault(); panRadar(pan[0], pan[1]); return; }
      if (key === "Enter" || key === " ") { event.preventDefault(); zoomRadar(1); return; }
    }

    if (dirs[key]) {
      if (active && active.tagName === "INPUT" && active.type === "range" && (key === "ArrowLeft" || key === "ArrowRight")) return;
      if (active && active.tagName === "INPUT" && active.type !== "range" && (key === "ArrowLeft" || key === "ArrowRight") && active.value) return;
      event.preventDefault();
      moveFocus(dirs[key]);
      return;
    }
    if ((key === "Enter" || key === " ") && active && active.matches("[tabindex]:not(button):not(input):not(select)")) {
      event.preventDefault();
      active.click();
    }
    if (key === "Enter" && active && active.id === "wpxTvLocSearch") { event.preventDefault(); searchLocation(); }
    if (key === "MediaPlayPause") { event.preventDefault(); window.wpTvKey("playpause"); }
  }

  window.wpTvKey = function (key) {
    if (!TV.active) return;
    resetIdle();
    if (TV.ambient) { exitAmbient(); return; }
    if (key === "playpause") {
      if (TV.screen === "radar") { TV.radar.loop = !TV.radar.loop; if (TV.radar.loop) startRadarLoop(); else stopRadarLoop(); refreshLayerBar(); }
      else if (TV.screen === "models") setModelPlaying(!TV.models.playing);
    } else if (key === "menu") {
      if (TV.screen === "radar" && TV.radar.mapMode) focusEl(TV.main.querySelector("[data-wpx='tvMapMode']"));
      else focusEl(railButton());
    } else if (key === "zoomin" && TV.screen === "radar") zoomRadar(1);
    else if (key === "zoomout" && TV.screen === "radar") zoomRadar(-1);
    else if ((key === "next" || key === "prev") && TV.screen === "models") stepModel(key === "next" ? 1 : -1);
  };

  function tvBack() {
    if (!TV.active) return false;
    resetIdle();
    if (TV.ambient) return exitAmbient();
    if (X.topOverlay()) return false; // core closes the overlay
    if (TV.screen === "radar" && TV.radar.mapMode) {
      const map = TV.radar.map;
      if (map && map.getZoom() > TV.radar.baseZoom + 0.05) { zoomRadar(-1); return true; }
      focusEl(TV.main.querySelector("[data-wpx='tvMapMode']"));
      return true;
    }
    if (TV.sub && TV.sub.kind === "alert") { TV.sub = null; renderAlerts(); setTimeout(() => focusFirst(TV.main), 40); return true; }
    if (document.activeElement && TV.main.contains(document.activeElement)) { focusEl(railButton()); return true; }
    if (TV.screen !== "radar") { show("radar"); focusEl(railButton("radar")); return true; }
    return false; // on the rail at Live Radar: let Android leave the app
  }

  function refreshLayerBar() {
    const bar = document.getElementById("wpxTvLayerBar");
    if (!bar) return;
    const key = document.activeElement && bar.contains(document.activeElement) ? `${document.activeElement.dataset.wpx}|${document.activeElement.dataset.key || ""}` : "";
    bar.innerHTML = radarBar();
    if (key) {
      const again = [...bar.querySelectorAll("[data-wpx]")].find(el => `${el.dataset.wpx}|${el.dataset.key || ""}` === key);
      if (again) focusEl(again);
    }
  }

  Object.assign(X.actions, {
    tvScreen: el => show(el.dataset.screen),
    tvLayer: el => {
      const k = el.dataset.key;
      TV.radar.layers[k] = !TV.radar.layers[k];
      if (k === "hail" && TV.radar.layers.hail) TV.radar.layers.rot = false;
      if (k === "rot" && TV.radar.layers.rot) TV.radar.layers.hail = false;
      saved.layers = TV.radar.layers;
      X.savePrefs();
      refreshLayerBar();
      syncRadarLayers();
    },
    tvLoop: () => window.wpTvKey("playpause"),
    tvRecenter: () => { const l = state.location; TV.radar.map?.easeTo({ center: [l.longitude, l.latitude], zoom: TV.radar.baseZoom, duration: 500 }); },
    tvMapMode: () => focusEl(document.getElementById("wpxTvMap")),
    tvAlert: el => renderAlertDetail(el.dataset.id),
    tvBack: () => tvBack(),
    tvLocSearch: () => searchLocation(),
    tvLocPick: el => {
      const r = locResults[Number(el.dataset.i)];
      if (!r) return;
      state.location = r;
      try { state.radarSite = nearestRadarSite(r).id; resetRadarCenter(false); } catch (_) {}
      saveState();
      say(`Location set to ${r.name}`);
      tickClock();
      Promise.resolve(typeof fetchForecast === "function" ? fetchForecast() : null).finally(() => { if (TV.screen === "forecast") { renderForecast(); refocus(); } });
      if (typeof fetchAlerts === "function") fetchAlerts();
    },
    tvModel: el => { const S = X.radar.studio; S.prefs.model = el.dataset.id; S.state.frame = null; X.savePrefs(); S.loadRuns().then(S.loadHours).then(() => { drawModelPanel(); drawModelFrame(); }); },
    tvRun: el => { const S = X.radar.studio; S.prefs.run = el.dataset.id; X.savePrefs(); S.loadHours().then(() => { drawModelPanel(); drawModelFrame(); }); },
    tvField: el => { const S = X.radar.studio; S.prefs.field = el.dataset.id; X.savePrefs(); drawModelPanel(); drawModelFrame(); },
    tvModelStep: el => { setModelPlaying(false); stepModel(Number(el.dataset.d)); },
    tvModelPlay: () => setModelPlaying(!TV.models.playing)
  });

  /* ---------- Activation ---------- */
  function activate() {
    if (TV.active) return;
    TV.active = true;
    // Setup and What's New sheets are phone flows; the TV shell covers them, so retire them quietly.
    try {
      state.onboardingComplete = true;
      if (typeof RELEASE_VERSION !== "undefined") state.releaseSeen = RELEASE_VERSION;
      saveState();
      renderOnboarding();
      closePage();
    } catch (_) {}
    build();
    document.addEventListener("keydown", onKeyDown, true);
    X.backHandlers.unshift(tvBack);
    try { window.WeatherPowerAndroid?.setKeepScreenOn?.(true); } catch (_) {}
    resetIdle();
    show(saved.screen && saved.screen !== "ambient" ? saved.screen : "radar");
    setTimeout(() => focusEl(railButton()), 120);
    if (X.tropical) X.tropical.loadStorms();
    // Forecast/alerts land asynchronously; refresh whichever screen shows them.
    const originalRenderAll = typeof renderAll === "function" ? renderAll : null;
    if (originalRenderAll) {
      // eslint-disable-next-line no-global-assign
      renderAll = function () {
        const out = originalRenderAll.apply(this, arguments);
        if (TV.screen === "forecast" && !TV.main.contains(document.activeElement)) renderForecast();
        tickClock();
        return out;
      };
    }
  }

  X.tv = { get active() { return TV.active; }, activate, refocus, focusFirst, show, state: TV };
  if (X.isTvLaunch) activate();
})();
