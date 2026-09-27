/* WeatherPower Model Studio + Point Soundings (Radar 3.1).
 * Model Studio: real HRRR / NAM 3km / GFS / ECMWF open-data fields rendered by the WeatherPower render service
 * (/api/models). Frames are Web-Mercator images placed at each model's extent; hours render on demand
 * (prefetch + status polling). Missing hours/fields are shown as unavailable; nothing is interpolated.
 * Soundings: HRRR profiles + nearest NWS balloon launch from the sounding API, drawn as Skew-T + hodograph,
 * or the SounderPy image rendered server-side. */
(function () {
  "use strict";
  const X = window.WPX;
  if (!X || !X.r31) return;
  const R = X.r31;
  const { API, esc, escA, getJson } = X;

  /* ================================================================ Model Studio engine */
  const saved = X.prefs.studio = Object.assign({ model: "hrrr", field: "refc", opacity: 0.8, mslp: false, h500: false }, X.prefs.studio || {});
  const S = { cat: null, model: saved.model, run: null, runs: [], field: saved.field, hours: [], i: 0, done: [], failed: {},
    playing: false, timer: 0, poll: 0, open: false, status: "", error: false, map: null, before: undefined, shownUrl: null, listeners: [], ctr: {} };
  const save = () => { saved.model = S.model; saved.field = S.field; X.savePrefs(); };

  const field = k => (S.cat ? S.cat.fields.find(f => f.key === k) : null);
  const model = k => (S.cat ? S.cat.models.find(m => m.key === k) : null);
  const runDate = r => new Date(Date.UTC(+r.slice(0, 4), +r.slice(4, 6) - 1, +r.slice(6, 8), +r.slice(8, 10)));
  const runKey = iso => new Date(iso).toISOString().slice(0, 13).replace(/[-T]/g, "");
  const fhr = () => S.hours[S.i];
  const frameUrl = (h, f) => API.modelFrame(S.model, S.run, f || S.field, h);
  const fmtValid = d => d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).replace(":00", "");

  function notify(kind) { S.listeners.forEach(fn => { try { fn(kind || "full"); } catch (error) { console.warn(error); } }); }
  function setStatus(msg, err) { S.status = msg || ""; S.error = !!err; notify("status"); }

  function ensureCatalog() {
    if (S.cat) return Promise.resolve(S.cat);
    setStatus("Connecting to the model service…");
    return getJson(API.modelCatalog(), { label: "Model catalog" }).then(c => {
      S.cat = c;
      if (!model(S.model)) S.model = "hrrr";
      return c;
    }).catch(error => { setStatus(`Model service unreachable — ${error.message || error}`, true); throw error; });
  }

  function setModel(k) {
    stop();
    S.model = k;
    save();
    S.run = null; S.hours = []; S.runs = [];
    setStatus(`Finding the latest ${(model(k) || {}).name || k.toUpperCase()} run…`);
    notify("full");
    return getJson(API.modelRuns(k), { label: "Model runs" }).then(runs => {
      if (!Array.isArray(runs) || !runs.length) throw new Error(`No ${(model(k) || {}).name || k} runs are published right now`);
      S.runs = runs.map(r => ({ key: runKey(r.run), label: r.label || runKey(r.run) }));
      return setRun(S.runs[0].key);
    }).catch(error => setStatus(error.message || String(error), true));
  }

  function setRun(run) {
    stop();
    S.run = run;
    notify("full");
    return getJson(API.modelHours(S.model, run), { label: "Model hours" }).then(hours => {
      if (!Array.isArray(hours) || !hours.length) throw new Error("This run hasn't published any hours yet");
      S.hours = hours.map(Number);
      const f = field(S.field);
      if (!f || f.models.indexOf(S.model) < 0) S.field = (S.cat.fields.find(x => x.kind !== "contour" && x.models.indexOf(S.model) >= 0) || {}).key || S.field;
      // start at the hour nearest to now
      const now = Date.now(), base = runDate(run).getTime();
      let best = 0;
      S.hours.forEach((h, k) => { if (Math.abs(base + h * 3600e3 - now) < Math.abs(base + S.hours[best] * 3600e3 - now)) best = k; });
      S.i = best;
      return setField(S.field);
    }).catch(error => setStatus(error.message || String(error), true));
  }

  function setField(k) {
    S.field = k;
    save();
    S.done = []; S.failed = {};
    const f = field(k);
    while (f && S.i < S.hours.length - 1 && fhr() < f.min_fhr) S.i++;
    prefetch(k);
    ["mslp", "h500"].forEach(c => { if (saved[c]) prefetch(c); });
    notify("full");
    show();
    poll();
  }

  function prefetch(k) {
    const f = field(k);
    if (!f || f.models.indexOf(S.model) < 0 || !S.run) return;
    getJson(API.modelPrefetch(S.model, S.run, k, fhr() || 0), { label: "Model prefetch" }).catch(error => setStatus(error.message || String(error), true));
  }

  function poll() {
    clearTimeout(S.poll);
    if (!S.open || !S.run) return;
    getJson(API.modelStatus(S.model, S.run, S.field), { label: "Model status" }).then(st => {
      const done = Array.isArray(st.done) ? st.done.map(Number) : [];
      done.forEach(h => { if (S.done.indexOf(h) < 0) { const im = new Image(); im.crossOrigin = "anonymous"; im.src = frameUrl(h); } });
      S.done = done;
      S.failed = st.failed || {};
      const f = field(S.field) || { min_fhr: 0 };
      const total = S.hours.filter(h => h >= f.min_fhr).length;
      const bad = Object.keys(S.failed).length;
      setStatus(S.done.length >= total - bad ? (bad ? `${bad} hours not available in this run` : `All ${total} hours loaded`)
        : `Loading ${S.done.length} / ${total} hours from ${(model(S.model) || {}).name || S.model}…`);
      if (S.done.indexOf(fhr()) >= 0 && S.shownUrl !== frameUrl(fhr()) && !S.playing) show();
      if (S.done.length + bad < total) S.poll = setTimeout(poll, 700);
    }).catch(() => { S.poll = setTimeout(poll, 4000); });
  }

  // Frames are Web-Mercator images covering the model extent [west, east, south, north].
  const clampLat = v => Math.max(-85.0511, Math.min(85.0511, v));
  const quad = (w, e, s, n) => [[w, clampLat(n)], [e, clampLat(n)], [e, clampLat(s)], [w, clampLat(s)]];
  function extent() {
    const m = model(S.model);
    return m && Array.isArray(m.extent) && m.extent.length === 4 ? m.extent.map(Number) : null;
  }

  const IMG_LAYERS = [["wpx-model-img", "wpx-model-img-layer"], ["wpx-model-img2", "wpx-model-img2-layer"]];
  function putImage(map, index, url, coords) {
    const [id, layer] = IMG_LAYERS[index];
    const src = map.getSource(id);
    if (src && src.updateImage) { src.updateImage({ url, coordinates: coords }); return; }
    map.addSource(id, { type: "image", url, coordinates: coords });
    map.addLayer({ id: layer, type: "raster", source: id, paint: { "raster-opacity": saved.opacity, "raster-fade-duration": 0, "raster-resampling": "linear" } }, S.before && map.getLayer(S.before) ? S.before : undefined);
  }

  // Global grids run 0–360°. MapLibre places an image on one world copy only, so cut the frame at the
  // antimeridian and place each half on its own side (east half: 0–180°E, west half: 180°W–0°).
  const blobUrls = [];
  function splitFrame(img, w, e, s, n) {
    const cut = Math.round(img.naturalWidth * (180 - w) / (e - w));
    const parts = [[0, cut, w, 180], [cut, img.naturalWidth - cut, -180, e - 360]];
    return Promise.all(parts.map(([sx, sw]) => new Promise((resolve, reject) => {
      const c = document.createElement("canvas");
      c.width = Math.max(1, sw); c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, sx, 0, sw, img.naturalHeight, 0, 0, sw, img.naturalHeight);
      c.toBlob(b => (b ? resolve(URL.createObjectURL(b)) : reject(new Error("Frame could not be split"))), "image/png");
    }))).then(urls => {
      while (blobUrls.length) URL.revokeObjectURL(blobUrls.shift());
      blobUrls.push(...urls);
      return urls.map((u, i) => ({ url: u, coords: quad(parts[i][2], parts[i][3], s, n) }));
    });
  }

  function show() {
    const h = fhr();
    notify("hour");
    const map = S.map;
    if (h == null || !map || !X.mapReady(map)) return;
    const f = field(S.field);
    if (!f || h < f.min_fhr) { hideFrame(); return; }
    const url = frameUrl(h);
    contours();
    if (S.shownUrl === url && map.getSource("wpx-model-img")) return;
    S.shownUrl = url;
    const ext = extent();
    if (!ext) return;
    const [w, e, south, north] = ext;
    // Preload, then swap: MapLibre re-reads the image from the HTTP cache, so frames change without a blank.
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (S.shownUrl !== url || S.map !== map) return;
      try {
        if (e > 180 && w < 180) {
          splitFrame(img, w, e, south, north).then(parts => {
            if (S.shownUrl !== url || S.map !== map) return;
            parts.forEach((part, i) => putImage(map, i, part.url, part.coords));
          }).catch(error => setStatus(error.message, true));
        } else {
          const shift = w >= 180 ? -360 : 0; // grids entirely east of 180° (e.g. 190–300)
          putImage(map, 0, url, quad(w + shift, e + shift, south, north));
          X.removeLayerAndSource(map, IMG_LAYERS[1][0], [IMG_LAYERS[1][1]]);
        }
      } catch (error) { console.warn("Model frame failed", error); }
    };
    img.onerror = () => { if (S.shownUrl === url) setStatus(`F${h} isn't available for this field yet`, true); };
    img.src = url;
  }

  function hideFrame() {
    if (S.map) IMG_LAYERS.forEach(([id, layer]) => X.removeLayerAndSource(S.map, id, [layer]));
    S.shownUrl = null;
    contours();
  }

  function contours() {
    const map = S.map;
    ["mslp", "h500"].forEach(c => {
      const id = `wpx-ctr-${c}`;
      const f = field(c);
      if (!map || !S.open || !saved[c] || !f || f.models.indexOf(S.model) < 0 || fhr() == null) {
        if (map) X.removeLayerAndSource(map, id, [`${id}-line`, `${id}-lbl`, `${id}-hl`]);
        S.ctr[c] = null;
        return;
      }
      const key = `${S.model}${S.run}${c}${fhr()}`;
      if (S.ctr[c] === key) return;
      S.ctr[c] = key;
      getJson(API.modelContour(S.model, S.run, c, fhr()), { label: "Model contours" }).then(gj => {
        if (S.ctr[c] !== key || !X.mapReady(map)) return;
        const color = c === "mslp" ? "#ffffff" : "#ffe08a", major = c === "mslp" ? 8 : 12;
        const had = !!map.getSource(id);
        X.setGeoJson(map, id, gj);
        if (!had) {
          X.addLayerOnce(map, { id: `${id}-line`, type: "line", source: id, filter: ["==", ["geometry-type"], "LineString"], paint: {
            "line-color": color, "line-opacity": 0.85,
            "line-width": ["case", ["==", ["%", ["to-number", ["get", "v"], 1], major], 0], 2, 1.2] } });
          X.addLayerOnce(map, { id: `${id}-lbl`, type: "symbol", source: id, filter: ["==", ["geometry-type"], "LineString"], layout: {
            "symbol-placement": "line", "text-field": ["to-string", ["get", "v"]], "text-size": 11 }, paint: { "text-color": color, "text-halo-color": "#000", "text-halo-width": 1.2 } });
          X.addLayerOnce(map, { id: `${id}-hl`, type: "symbol", source: id, filter: ["==", ["geometry-type"], "Point"], layout: {
            "text-field": ["concat", ["get", "center"], "\n", ["to-string", ["get", "v"]]], "text-size": 15, "text-allow-overlap": true }, paint: {
            "text-color": ["case", ["==", ["get", "center"], "H"], "#58ccff", "#ff5a5a"], "text-halo-color": "#000", "text-halo-width": 1.5 } });
        }
      }).catch(() => {
        // the hour may still be building on the server; try again shortly (same hour only)
        setTimeout(() => { if (S.ctr[c] === key) { S.ctr[c] = null; contours(); } }, 3000);
      });
    });
  }

  function step(k) { if (!S.hours.length) return; S.i = (S.i + k + S.hours.length) % S.hours.length; show(); }
  function play() {
    S.playing = true;
    notify("play");
    (function tick() {
      let n = 0;
      do { S.i = (S.i + 1) % S.hours.length; n++; } while (S.done.indexOf(fhr()) < 0 && n < S.hours.length);
      show();
      S.timer = setTimeout(tick, S.i === S.hours.length - 1 ? 1300 : 260);
    })();
  }
  function stop() { const was = S.playing; S.playing = false; clearTimeout(S.timer); if (was) notify("play"); }

  // Studio draws on one map at a time: the phone radar map or the TV Models map.
  function attach(map, before) {
    if (S.map && S.map !== map) IMG_LAYERS.forEach(([id, layer]) => X.removeLayerAndSource(S.map, id, [layer]));
    S.map = map;
    S.before = before;
    S.shownUrl = null;
    S.ctr = {};
    show();
  }

  function open(map, before) {
    S.open = true;
    if (map) attach(map, before);
    if (!S.cat) return ensureCatalog().then(() => setModel(S.model)).catch(() => {});
    if (!S.run) return setModel(S.model);
    show(); poll();
    return Promise.resolve();
  }

  function close() {
    S.open = false;
    stop();
    clearTimeout(S.poll);
    hideFrame();
    notify("full");
  }

  function setOpacity(v) {
    saved.opacity = v;
    X.savePrefs();
    IMG_LAYERS.forEach(([, layer]) => { try { if (S.map && S.map.getLayer(layer)) S.map.setPaintProperty(layer, "raster-opacity", v); } catch (_) {} });
  }

  function setContour(c, on) { saved[c] = !!on; X.savePrefs(); if (on && S.run) prefetch(c); S.ctr[c] = null; contours(); }

  function valueAt(map, lngLat) {
    const h = fhr(), f = field(S.field);
    if (!S.run || h == null || !f) return Promise.resolve(false);
    return getJson(API.modelValue(S.model, S.run, S.field, h, lngLat.lat, lngLat.lng), { label: "Model value" }).then(v => {
      const val = v.value == null ? "No data" : `${["°F", "mph", "J/kg"].indexOf(f.units) >= 0 ? Math.round(v.value) : v.value} ${f.units}`;
      R.popup(map, lngLat, `<b>${esc(val)}</b>${v.ptype ? ` · ${esc(v.ptype)}` : ""}<br><small>${esc(`${(model(S.model) || {}).name || S.model} ${f.name}`)} · F${String(h).padStart(3, "0")}</small>`);
      return true;
    });
  }

  function validLabel() {
    const h = fhr();
    if (h == null || !S.run) return "";
    return `Valid ${fmtValid(new Date(runDate(S.run).getTime() + h * 3600e3))}`;
  }
  function runLabel() {
    const h = fhr(), m = model(S.model);
    if (!S.run || h == null || !m) return "";
    return `${m.name} ${S.run.slice(8)}Z · F${String(h).padStart(3, "0")}`;
  }

  const grad = lg => `linear-gradient(90deg,${lg.map((s, i) => `${s.c} ${(i / (lg.length - 1)) * 100}%`).join(",")})`;
  function legendHtml() {
    const f = field(S.field);
    if (!f) return "";
    const L = S.cat.ptype_legend || {};
    if (f.kind === "ptype" && L.refc) {
      const bar = lg => (lg && lg.length > 1 ? `<div class="wpx-palbar" style="background:${escA(grad(lg))}"></div>` : "");
      return `<div class="wpx-legend"><div class="wpx-legend-t">Precip type · intensity (dBZ)</div><div class="wpx-ptype"><span>Rain</span>${bar(L.refc)}<span>Snow</span>${bar(L.snow_ptype)}<span>Ice</span>${bar(L.ice_ptype)}<span>Sleet</span>${bar(L.mix_ptype)}</div></div>`;
    }
    const lg = f.legend || [];
    if (lg.length < 2) return "";
    const n = lg.length, stepN = n > 8 ? Math.ceil(n / 6) : 1;
    return `<div class="wpx-legend"><div class="wpx-legend-t">${esc(f.name)} <small>${esc(f.units)}</small></div><div class="wpx-palbar" style="background:${escA(grad(lg))}"></div><div class="wpx-ticks">${lg.map((s, i) => (i % stepN === 0 || i === n - 1 ? `<span style="left:${(i / (n - 1)) * 100}%">${esc(s.v)}</span>` : "")).join("")}</div></div>`;
  }

  function credit() {
    const f = field(S.field), m = model(S.model);
    if (!m) return "";
    return `Data: ${m.source || m.name}${f && f.notes && f.notes[S.model] ? ` · ${f.notes[S.model]}` : ""}`;
  }

  X.studio = {
    state: S, prefs: saved, field, model, ensureCatalog, setModel, setRun, setField, step, play, stop, open, close, attach,
    setOpacity, setContour, valueAt, validLabel, runLabel, legendHtml, credit, fhr,
    onChange: fn => S.listeners.push(fn),
    offChange: fn => { const i = S.listeners.indexOf(fn); if (i >= 0) S.listeners.splice(i, 1); }
  };

  /* ---------------------------------------------------------------- phone sheet tab */
  R.addLayer((map, before) => {
    if (!S.open || (X.tv && X.tv.active)) return;
    if (S.map !== map) attach(map, before);
    else if (!map.getSource("wpx-model-img") && S.shownUrl) { S.shownUrl = null; show(); }
  });

  R.addClick((map, event) => (S.open && S.map === map ? valueAt(map, event.lngLat) : false), 40);

  function modelsBody() {
    if (!S.open) {
      return `<p class="wpx-note">Model Studio draws real HRRR, NAM, GFS and ECMWF forecast maps on the radar, with hour-by-hour playback, MSLP / 500 mb contours and tap-for-value.</p><div class="wpx-btnrow"><button class="wpx-btn primary" data-wpx="studioOpen">Open Model Studio</button></div>`;
    }
    if (!S.cat) return `<p class="wpx-note${S.error ? " err" : ""}" id="wpxMsStatus">${esc(S.status || "Connecting to the model service…")}</p>`;
    const groups = {};
    S.cat.fields.filter(f => f.kind !== "contour").forEach(f => { (groups[f.group] = groups[f.group] || []).push(f); });
    const ctrOk = c => { const f = field(c); return !!f && f.models.indexOf(S.model) >= 0; };
    return `
      <div class="wpx-chips">${S.cat.models.map(m => R.chip("studioModel", m.name.replace(" 3km", ""), m.key === S.model, `data-id="${escA(m.key)}"`)).join("")}</div>
      <div class="wpx-inline">
        <select id="wpxMsRun" aria-label="Model run">${S.runs.map(r => `<option value="${escA(r.key)}"${r.key === S.run ? " selected" : ""}>${esc(r.label)}</option>`).join("") || "<option>Loading runs…</option>"}</select>
      </div>
      <select id="wpxMsField" aria-label="Model field" style="margin-top:8px">${Object.keys(groups).map(g => `<optgroup label="${escA(g)}">${groups[g].map(f => {
        const ok = f.models.indexOf(S.model) >= 0;
        return `<option value="${escA(f.key)}"${ok ? "" : " disabled"}${f.key === S.field ? " selected" : ""}>${esc(f.name)}${ok ? "" : " (n/a)"}</option>`;
      }).join("")}</optgroup>`).join("")}</select>
      <div class="wpx-row"><strong id="wpxMsRunLbl">${esc(runLabel())}</strong><span class="wpx-sub" id="wpxMsValid">${esc(validLabel())}</span></div>
      <input type="range" id="wpxMsHour" min="0" max="${Math.max(0, S.hours.length - 1)}" value="${S.i}" aria-label="Forecast hour"${S.hours.length ? "" : " disabled"}>
      <div class="wpx-btnrow"><button class="wpx-btn" data-wpx="studioStep" data-d="-1" aria-label="Previous hour">‹</button><button class="wpx-btn primary" data-wpx="studioPlay" id="wpxMsPlay">${S.playing ? "Pause" : "Play"}</button><button class="wpx-btn" data-wpx="studioStep" data-d="1" aria-label="Next hour">›</button><button class="wpx-btn subtle" data-wpx="studioClose">Hide</button></div>
      <div class="wpx-checks"><label><input type="checkbox" id="wpxMsMslp"${saved.mslp ? " checked" : ""}${ctrOk("mslp") ? "" : " disabled"}> MSLP isobars</label><label><input type="checkbox" id="wpxMsH500"${saved.h500 ? " checked" : ""}${ctrOk("h500") ? "" : " disabled"}> 500 mb heights</label></div>
      ${legendHtml()}
      <div class="wpx-label">Opacity</div><input type="range" id="wpxMsOpacity" min="20" max="100" value="${Math.round(saved.opacity * 100)}" aria-label="Model opacity">
      <p class="wpx-note${S.error ? " err" : ""}" id="wpxMsStatus">${esc(S.status)}</p>
      <p class="wpx-note" id="wpxMsCredit">${esc(credit())}</p>
      <p class="wpx-note">Tap the map for the value at a point.</p>`;
  }

  S.listeners.push(kind => {
    if (!R.isOpen() || R.prefs.tab !== "models") return;
    if (kind === "status") {
      const el = document.getElementById("wpxMsStatus");
      if (el) { el.textContent = S.status; el.classList.toggle("err", S.error); return; }
    }
    if (kind === "hour" || kind === "play") {
      const run = document.getElementById("wpxMsRunLbl"), valid = document.getElementById("wpxMsValid"), slider = document.getElementById("wpxMsHour"), playBtn = document.getElementById("wpxMsPlay");
      if (run && valid && slider) {
        run.textContent = runLabel(); valid.textContent = validLabel(); slider.value = String(S.i);
        if (playBtn) playBtn.textContent = S.playing ? "Pause" : "Play";
        return;
      }
    }
    R.renderSheet();
  });

  R.addTab({
    id: "models", label: "Models", order: 50, body: modelsBody,
    onInput: e => {
      if (e.target.id === "wpxMsHour") { stop(); S.i = Number(e.target.value) || 0; show(); }
      else if (e.target.id === "wpxMsOpacity") setOpacity(Number(e.target.value) / 100);
    },
    onChange: e => {
      const t = e.target;
      if (t.id === "wpxMsRun") setRun(t.value);
      else if (t.id === "wpxMsField") { stop(); setField(t.value); }
      else if (t.id === "wpxMsMslp") setContour("mslp", t.checked);
      else if (t.id === "wpxMsH500") setContour("h500", t.checked);
    }
  });

  Object.assign(X.actions, {
    studioOpen: () => { const map = R.map(); open(X.mapReady(map) ? map : null, R.beforeId()); R.refreshTab("models"); },
    studioClose: () => { close(); R.refreshTab("models"); },
    studioModel: el => setModel(el.dataset.id),
    studioStep: el => { stop(); step(Number(el.dataset.d) || 1); },
    studioPlay: () => (S.playing ? stop() : play())
  });

  /* ================================================================ Point soundings */
  let soundingArmed = false;
  R.addClick((map, event) => {
    if (!soundingArmed) return false;
    soundingArmed = false;
    R.refreshTab("sounding");
    openSounding(event.lngLat.lat, event.lngLat.lng);
    return true;
  }, 5);

  const RD = 287.04, CP = 1005.7, LV = 2.501e6, EPS = 0.622, NS = "http://www.w3.org/2000/svg";
  const esat = tc => 6.112 * Math.exp(17.67 * tc / (tc + 243.5));
  const mixr = (tc, p) => { const e = esat(tc); return EPS * e / (p - e); };
  function moistStep(T, p, dp) { // T in K; integrate the pseudo-adiabat by dp (negative = upward)
    const rs = mixr(T - 273.15, p);
    const dTdp = ((RD * T + LV * rs) / p) / (CP + (LV * LV * rs * EPS) / (RD * T * T));
    return T + dTdp * dp;
  }
  function parcelPath(levels) { // surface-based parcel: [{p, t}] in °C
    const s = levels[0];
    if (!s || s.td == null) return [];
    const T0 = s.t + 273.15, Td0 = s.td + 273.15, p0 = s.p;
    const Tl = 1 / (1 / (Td0 - 56) + Math.log(T0 / Td0) / 800) + 56;
    const pl = p0 * Math.pow(Tl / T0, CP / RD);
    const out = [];
    let p;
    for (p = p0; p > pl; p -= 5) out.push({ p, t: T0 * Math.pow(p / p0, RD / CP) - 273.15 });
    out.push({ p: pl, t: Tl - 273.15, lcl: true });
    let T = Tl;
    for (p = pl; p > 100; p -= 5) { T = moistStep(T, p, -Math.min(5, p - 100)); out.push({ p: Math.max(100, p - 5), t: T - 273.15 }); }
    return out;
  }

  const SK = { w: 640, h: 600, pTop: 100, pBot: 1050, tMin: -40, tMax: 50, left: 44, right: 44, top: 10, bottom: 26 };
  const yOf = p => SK.top + SK.h * Math.log(p / SK.pTop) / Math.log(SK.pBot / SK.pTop);
  const xOf = (t, p) => SK.left + (t - SK.tMin) / (SK.tMax - SK.tMin) * SK.w + (SK.top + SK.h - yOf(p)) * 0.9;
  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    Object.keys(attrs).forEach(k => n.setAttribute(k, attrs[k]));
    if (parent) parent.appendChild(n);
    return n;
  }
  const pathOf = points => points.map((pt, i) => `${i ? "L" : "M"}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join("");

  function barb(svg, x, y, wd, ws) {
    const g = el("g", { transform: `translate(${x} ${y}) rotate(${wd})` }, svg);
    const len = 26;
    let kt = Math.round(ws / 5) * 5;
    if (kt < 5) { el("circle", { r: 3.5, fill: "none", stroke: "#dbe6ff", "stroke-width": 1.2 }, g); return; }
    el("path", { d: `M0 0L0 ${-len}`, stroke: "#dbe6ff", "stroke-width": 1.3 }, g);
    let pos = -len;
    while (kt >= 50) { el("path", { d: `M0 ${pos}L10 ${pos + 3}L0 ${pos + 6}Z`, fill: "#dbe6ff" }, g); pos += 7; kt -= 50; }
    while (kt >= 10) { el("path", { d: `M0 ${pos}L11 ${pos - 4}`, stroke: "#dbe6ff", "stroke-width": 1.3 }, g); pos += 4; kt -= 10; }
    if (kt >= 5) { if (pos === -len) pos += 4; el("path", { d: `M0 ${pos}L6 ${pos - 2}`, stroke: "#dbe6ff", "stroke-width": 1.3 }, g); }
  }

  function drawSkewT(svg, levels) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const W = SK.left + SK.w + SK.right, H = SK.top + SK.h + SK.bottom;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const clipId = `wpxSkClip${Date.now()}`;
    const cp = el("clipPath", { id: clipId }, el("defs", {}, svg));
    el("rect", { x: SK.left, y: SK.top, width: SK.w, height: SK.h }, cp);
    el("rect", { x: SK.left, y: SK.top, width: SK.w, height: SK.h, fill: "#040815", stroke: "rgba(160,180,230,.25)" }, svg);
    const g = el("g", { "clip-path": `url(#${clipId})` }, svg);
    let p, t, pts;
    for (t = -120; t <= 50; t += 10) el("path", { d: pathOf([[xOf(t, SK.pBot), yOf(SK.pBot)], [xOf(t, SK.pTop), yOf(SK.pTop)]]), stroke: t === 0 ? "rgba(88,204,255,.55)" : "rgba(150,170,220,.16)", "stroke-width": t === 0 ? 1.3 : 1, fill: "none" }, g);
    for (let th = 240; th <= 460; th += 10) { // dry adiabats
      pts = [];
      for (p = SK.pBot; p >= SK.pTop; p -= 25) pts.push([xOf(th * Math.pow(p / 1000, RD / CP) - 273.15, p), yOf(p)]);
      el("path", { d: pathOf(pts), stroke: "rgba(255,170,90,.16)", fill: "none" }, g);
    }
    for (t = -10; t <= 36; t += 4) { // moist adiabats
      let T = t + 273.15;
      pts = [[xOf(t, 1000), yOf(1000)]];
      for (p = 1000; p > 200; p -= 10) { T = moistStep(T, p, -10); pts.push([xOf(T - 273.15, p - 10), yOf(p - 10)]); }
      el("path", { d: pathOf(pts), stroke: "rgba(80,210,140,.17)", "stroke-dasharray": "5 4", fill: "none" }, g);
    }
    [1, 2, 4, 8, 12, 16, 20].forEach(w => { // mixing ratio lines (g/kg)
      pts = [];
      for (p = 1050; p >= 600; p -= 25) {
        const e = (w / 1000) * p / (EPS + w / 1000), a = Math.log(e / 6.112);
        pts.push([xOf(243.5 * a / (17.67 - a), p), yOf(p)]);
      }
      el("path", { d: pathOf(pts), stroke: "rgba(190,150,255,.2)", "stroke-dasharray": "2 4", fill: "none" }, g);
    });
    [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100].forEach(pp => {
      el("path", { d: pathOf([[SK.left, yOf(pp)], [SK.left + SK.w, yOf(pp)]]), stroke: "rgba(160,180,230,.2)" }, svg);
      el("text", { x: SK.left - 5, y: yOf(pp) + 3, "text-anchor": "end", class: "wpx-sk-axis" }, svg).textContent = pp;
    });
    for (t = -40; t <= 50; t += 10) el("text", { x: xOf(t, SK.pBot), y: SK.top + SK.h + 14, "text-anchor": "middle", class: "wpx-sk-axis" }, svg).textContent = `${t}°`;
    const good = levels.filter(l => l.p >= SK.pTop && l.t != null);
    const parcel = parcelPath(good);
    if (parcel.length) {
      el("path", { d: pathOf(parcel.filter(q => q.p >= SK.pTop).map(q => [xOf(q.t, q.p), yOf(q.p)])), stroke: "rgba(255,255,255,.75)", "stroke-width": 1.4, "stroke-dasharray": "6 4", fill: "none" }, g);
      const lcl = parcel.find(q => q.lcl);
      if (lcl) el("text", { x: xOf(lcl.t, lcl.p) + 8, y: yOf(lcl.p) + 3, class: "wpx-sk-tag" }, g).textContent = "LCL";
    }
    el("path", { d: pathOf(good.filter(l => l.td != null).map(l => [xOf(l.td, l.p), yOf(l.p)])), stroke: "#34d399", "stroke-width": 2.4, fill: "none", "stroke-linejoin": "round" }, g);
    el("path", { d: pathOf(good.map(l => [xOf(l.t, l.p), yOf(l.p)])), stroke: "#ff4d5e", "stroke-width": 2.6, fill: "none", "stroke-linejoin": "round" }, g);
    let last = 9999;
    const bx = SK.left + SK.w + 22;
    el("path", { d: pathOf([[bx, SK.top], [bx, SK.top + SK.h]]), stroke: "rgba(160,180,230,.18)" }, svg);
    good.forEach(l => {
      if (l.ws == null || l.wd == null || last - l.p < 45) return;
      last = l.p;
      barb(svg, bx, yOf(l.p), l.wd, l.ws);
    });
    const sfc = good[0];
    if (sfc) {
      el("text", { x: xOf(sfc.t, sfc.p) + 6, y: yOf(sfc.p) - 6, class: "wpx-sk-tag wpx-sk-t" }, svg).textContent = `${Math.round(sfc.t * 9 / 5 + 32)}°F`;
      if (sfc.td != null) el("text", { x: xOf(sfc.td, sfc.p) - 6, y: yOf(sfc.p) - 6, "text-anchor": "end", class: "wpx-sk-tag wpx-sk-td" }, svg).textContent = `${Math.round(sfc.td * 9 / 5 + 32)}°F`;
    }
  }

  function drawHodo(svg, levels) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute("viewBox", "0 0 240 240");
    const c = 120, sc = 1.6; // px per kt
    el("rect", { x: 0, y: 0, width: 240, height: 240, rx: 10, fill: "#040815", stroke: "rgba(160,180,230,.2)" }, svg);
    [20, 40, 60].forEach(r => {
      el("circle", { cx: c, cy: c, r: r * sc, fill: "none", stroke: "rgba(160,180,230,.18)" }, svg);
      el("text", { x: c + r * sc * 0.72 + 2, y: c - r * sc * 0.72 - 2, class: "wpx-sk-axis" }, svg).textContent = `${r}kt`;
    });
    el("path", { d: `M${c} 6L${c} 234M6 ${c}L234 ${c}`, stroke: "rgba(160,180,230,.14)" }, svg);
    const z0 = levels[0] ? levels[0].z : 0;
    const pts = levels.filter(l => l.ws != null && l.wd != null && l.z - z0 <= 10000).map(l => {
      const r = l.wd * Math.PI / 180;
      return { u: -l.ws * Math.sin(r), v: -l.ws * Math.cos(r), h: l.z - z0 };
    });
    const bands = [[0, 1000, "#ff4d5e"], [1000, 3000, "#34d399"], [3000, 6000, "#fbbf24"], [6000, 10001, "#58ccff"]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      let col = "#58ccff";
      bands.forEach(bd => { if (a.h >= bd[0] && a.h < bd[1]) col = bd[2]; });
      el("path", { d: `M${c + a.u * sc} ${c - a.v * sc}L${c + b.u * sc} ${c - b.v * sc}`, stroke: col, "stroke-width": 2.4, "stroke-linecap": "round" }, svg);
    }
    if (!pts.length) el("text", { x: c, y: c, "text-anchor": "middle", class: "wpx-sk-axis" }, svg).textContent = "No wind data";
  }

  function indicesHtml(prof) {
    const d = prof.derived || {}, m = prof.model || null;
    const row = (label, val, unit, hint) => `<div><small>${esc(label)}${hint ? ` · ${esc(hint)}` : ""}</small><strong>${val == null || val === "" ? "—" : `${esc(val)}${unit ? ` ${esc(unit)}` : ""}`}</strong></div>`;
    let h = "";
    if (m) h += `<h4>HRRR model</h4><div class="wpx-kv">${row("CAPE", m.cape != null ? Math.round(m.cape) : null, "J/kg")}${row("CIN", m.cin != null ? Math.round(m.cin) : null, "J/kg")}${row("Lifted index", m.liftedIndex, "")}</div>`;
    h += `<h4>From this profile</h4><div class="wpx-kv">${row("SB CAPE", d.sbCapeJkg, "J/kg", "approx.")}${row("SB CIN", d.sbCinJkg, "J/kg", "approx.")}${row("LCL", d.lclM, "m")}${row("Precip. water", d.pwatMm != null ? (d.pwatMm / 25.4).toFixed(2) : null, "in")}${row("700–500 lapse", d.lapseRate700to500CPerKm, "°C/km")}${row("0–6 km shear", d.bulkShear0to6kmKt, "kt")}${row("Freezing level", d.freezingLevelMAgl != null ? Math.round(d.freezingLevelMAgl * 3.281) : null, "ft AGL")}</div>`;
    return h;
  }

  const fmtUtc = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso || "") : `${d.toISOString().slice(5, 16).replace("T", " ")}Z`; };

  function openSounding(lat, lon) {
    soundingArmed = false;
    const body = X.openOverlay({ id: "sounding", title: `Point sounding · ${lat.toFixed(3)}°, ${lon.toFixed(3)}°`, className: "wpx-sounding" });
    const st = { src: "forecast", fhr: 0, data: null, error: "", loading: true };
    const draw = () => {
      const fc = st.data && st.data.forecast, ob = st.data && st.data.observed;
      let status = "", content = "";
      if (st.src === "image") {
        status = `NOAA HRRR F${String(st.fhr).padStart(3, "0")} · rendered server-side with SounderPy (a new hour can take ~30 s)`;
        content = `<div class="wpx-card wpx-snd-img"><img alt="SounderPy Skew-T" src="${escA(API.soundingImage(lat, lon, st.fhr))}"></div>`;
      } else if (st.loading) status = "Loading HRRR forecast + nearest balloon sounding…";
      else if (st.error) status = st.error;
      else {
        let prof = null, err = "";
        if (st.src === "observed") {
          if (ob && ob.available) prof = ob; else err = (ob && ob.reason) || "No observed sounding.";
        } else if (fc && fc.available && Array.isArray(fc.profiles) && fc.profiles.length) prof = fc.profiles[Math.min(st.fhr, fc.profiles.length - 1)];
        else err = (fc && fc.reason) || "No forecast sounding.";
        if (err) status = err;
        else {
          const levels = prof.levels || [];
          if (st.src === "observed") {
            const s = prof.station || {};
            status = `Balloon launch ${fmtUtc(prof.time)} · ${String(s.name || s.id || "").replace(/_/g, " ").replace(/\s+/g, " ")}${s.distanceKm != null ? ` · ${s.distanceKm} km away` : ""} · NWS via Iowa Environmental Mesonet · ${levels.length} levels${prof.note ? ` · ${prof.note}` : ""}`;
          } else {
            status = `HRRR +${st.fhr}h · valid ${fmtUtc(prof.time)}${fc.grid ? ` · grid ${Number(fc.grid.lat).toFixed(3)}°, ${Number(fc.grid.lon).toFixed(3)}°` : ""} · ${levels.length} levels`;
          }
          content = `<div class="wpx-card wpx-sk"><svg class="wpx-skewt" role="img" aria-label="Skew-T diagram"></svg></div>
            <div class="wpx-card wpx-sk-row"><svg class="wpx-hodo" role="img" aria-label="Hodograph"></svg><div class="wpx-sk-idx">${indicesHtml(prof)}</div></div>`;
          st.prof = prof;
        }
      }
      const hourUsable = st.src !== "observed";
      body.innerHTML = `
        <div class="wpx-card">
          <div class="wpx-chips">${R.chip("sndSrc", "HRRR forecast", st.src === "forecast", 'data-src="forecast"')}${R.chip("sndSrc", "Observed balloon", st.src === "observed", 'data-src="observed"')}${R.chip("sndSrc", "SounderPy image", st.src === "image", 'data-src="image"')}</div>
          ${hourUsable ? `<div class="wpx-row"><strong>Forecast hour</strong><span>F${String(st.fhr).padStart(3, "0")}</span></div>
          <input type="range" min="0" max="18" value="${st.fhr}" id="wpxSndHour" aria-label="Forecast hour">
          <div class="wpx-btnrow"><button class="wpx-btn" data-wpx="sndStep" data-d="-1">‹ Hour</button><button class="wpx-btn" data-wpx="sndStep" data-d="1">Hour ›</button><button class="wpx-btn subtle" data-wpx="sndReload">Refresh</button></div>` : `<div class="wpx-btnrow"><button class="wpx-btn subtle" data-wpx="sndReload">Refresh</button></div>`}
          <p class="wpx-note">${esc(status)}</p>
        </div>${content}`;
      const img = body.querySelector(".wpx-snd-img img");
      if (img) img.addEventListener("error", () => { img.replaceWith(Object.assign(document.createElement("p"), { className: "wpx-note", textContent: "The SounderPy image could not be rendered for this point/hour." })); });
      const sk = body.querySelector(".wpx-skewt"), ho = body.querySelector(".wpx-hodo");
      if (sk && st.prof) drawSkewT(sk, st.prof.levels || []);
      if (ho && st.prof) drawHodo(ho, st.prof.levels || []);
    };
    const load = () => {
      st.loading = true; st.error = ""; st.data = null; draw();
      getJson(API.soundingJson(lat, lon), { label: "Sounding", timeoutMs: 30000 }).then(json => {
        st.data = json;
        if (!(json.forecast && json.forecast.available) && json.observed && json.observed.available) st.src = "observed";
      }).catch(error => { st.error = `Sounding unavailable: ${error.message || error}`; })
        .finally(() => { st.loading = false; draw(); });
    };
    X.actions.sndSrc = e => { st.src = e.dataset.src; draw(); };
    X.actions.sndStep = e => { st.fhr = Math.max(0, Math.min(18, st.fhr + Number(e.dataset.d))); draw(); };
    X.actions.sndReload = () => load();
    body.addEventListener("change", e => { if (e.target.id === "wpxSndHour") { st.fhr = Number(e.target.value) || 0; draw(); } });
    load();
  }

  function soundingBody() {
    return `
      <p class="wpx-note">Skew-T and hodograph from the NOAA HRRR (0–18 h) and the nearest NWS weather balloon, or the SounderPy image rendered by the WeatherPower server.</p>
      <div class="wpx-btnrow"><button class="wpx-btn primary" data-wpx="armSounding">${soundingArmed ? "Tap the map now…" : "Pick a point on the map"}</button><button class="wpx-btn" data-wpx="soundingHere">At ${esc(state.location.name)}</button></div>`;
  }

  R.addTab({ id: "sounding", label: "Sounding", order: 60, body: soundingBody, onClose: () => { soundingArmed = false; } });

  Object.assign(X.actions, {
    armSounding: () => { soundingArmed = !soundingArmed; R.refreshTab("sounding"); if (soundingArmed) X.say("Tap anywhere on the radar map"); },
    soundingHere: () => openSounding(state.location.latitude, state.location.longitude)
  });

  X.sounding = { open: openSounding };
})();
