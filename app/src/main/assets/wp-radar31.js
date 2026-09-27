/* WeatherPower Radar 3.1 tools for the Android app, ported from the Radar 3.1 web blocks:
 * single-site Level III products at every served tilt, per-product color tables (GR / WxTools palettes),
 * and MRMS hail / rotation / rainfall layers, all drawn on the existing radar MapLibre map.
 * Also hosts the "Radar 3.1" bottom sheet that the studio (models, soundings) and travel (gas, shelters,
 * route) modules add their tabs to. Newest scan only; a radar that isn't sending a product is reported. */
(function () {
  "use strict";
  const X = window.WPX;
  if (!X) return;
  const { API, esc, escA, say, getJson, getText } = X;

  const P = X.prefs.radar31 = Object.assign({ tab: "radar" }, X.prefs.radar31 || {});
  P.l3 = Object.assign({ fam: "", tilt: "0", site: "auto", opacity: 0.8 }, P.l3 || {});
  P.mrms = Object.assign({ product: "", window: "", opacity: 0.85 }, P.mrms || {});
  if (P.l3.family !== undefined) { // settings written by the first build of this sheet
    P.l3.fam = P.l3.on ? P.l3.family : "";
    P.l3.tilt = String(P.l3.tilt || 0);
    delete P.l3.family; delete P.l3.on; delete P.l3.code; delete P.l3.pal;
  }
  if (/^[KPT][A-Z]{3}$/.test(P.l3.site)) P.l3.site = P.l3.site.slice(1);
  const save = () => X.savePrefs();

  /* ================================================================ sheet framework */
  const R = X.r31 = { tabs: [], layers: [], clicks: [], moves: [] };
  R.addTab = tab => { R.tabs.push(tab); R.tabs.sort((a, b) => a.order - b.order); };
  R.addLayer = fn => R.layers.push(fn);
  R.addClick = (fn, priority) => { R.clicks.push({ fn, priority }); R.clicks.sort((a, b) => a.priority - b.priority); };
  R.onMove = fn => R.moves.push(fn);
  R.map = () => (typeof radarMap !== "undefined" ? radarMap : null);
  R.prefs = P;
  R.save = save;

  R.chip = (action, label, active, extra = "") => `<button class="wpx-chip${active ? " active" : ""}" data-wpx="${action}" ${extra}>${esc(label)}</button>`;

  R.popup = (map, lngLat, html) => {
    try {
      if (window.__wpxPopup) window.__wpxPopup.remove();
      window.__wpxPopup = new maplibregl.Popup({ closeButton: true, maxWidth: "290px", className: "wpx-popup" }).setLngLat(lngLat).setHTML(html).addTo(map);
    } catch (error) { console.warn(error); }
  };

  R.mapCenter = () => {
    try { const map = R.map(); if (map) { const c = map.getCenter(); return { latitude: c.lat, longitude: c.lng }; } } catch (_) {}
    return { latitude: state.location.latitude, longitude: state.location.longitude };
  };

  // Level III / MRMS / model rasters sit just under the main app's overlays (sites, lightning, warnings).
  R.beforeId = () => (typeof rasterLayerBeforeId === "function" ? rasterLayerBeforeId("wp-nexrad-layer") : undefined);

  R.isOpen = () => !!document.getElementById("wpxRadarSheet");

  R.openSheet = tab => {
    if (tab) P.tab = tab;
    save();
    if (!R.isOpen()) {
      const el = document.createElement("div");
      el.id = "wpxRadarSheet";
      el.className = "wpx-sheet";
      document.body.appendChild(el);
      el.addEventListener("change", e => currentTab()?.onChange?.(e));
      el.addEventListener("input", e => currentTab()?.onInput?.(e));
    }
    currentTab()?.onOpen?.();
    R.renderSheet();
  };

  R.closeSheet = () => {
    document.getElementById("wpxRadarSheet")?.remove();
    R.tabs.forEach(t => t.onClose && t.onClose());
  };

  function currentTab() { return R.tabs.find(t => t.id === P.tab) || R.tabs[0]; }

  R.renderSheet = () => {
    const el = document.getElementById("wpxRadarSheet");
    if (!el) return;
    const tab = currentTab();
    const body = el.querySelector(".wpx-sheet-body");
    const scroll = body ? body.scrollTop : 0;
    const focusId = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : "";
    el.innerHTML = `<div class="wpx-sheet-head"><strong>Radar 3.1</strong><div class="wpx-tabs">${R.tabs.map(t => R.chip("sheetTab", t.label, t === tab, `data-tab="${t.id}"`)).join("")}</div><button class="wpx-icon-btn" data-wpx="closeSheet" aria-label="Close">×</button></div><div class="wpx-sheet-body">${tab ? tab.body() : ""}</div>`;
    el.querySelector(".wpx-sheet-body").scrollTop = scroll;
    if (focusId) document.getElementById(focusId)?.focus?.({ preventScroll: true });
  };

  // Re-render only when the sheet is showing that tab (async loads call this).
  R.refreshTab = id => { if (R.isOpen() && P.tab === id) R.renderSheet(); };

  X.backHandlers.push(() => {
    if (X.topOverlay()) return false;
    if (R.isOpen()) { R.closeSheet(); return true; }
    return false;
  });

  /* ================================================================ layer sync + map events */
  R.apply = force => {
    const map = R.map();
    if (!X.mapReady(map)) return;
    bindMap(map);
    const before = R.beforeId();
    R.layers.forEach(fn => { try { fn(map, before, !!force); } catch (error) { console.warn("Radar 3.1 layer failed", error); } });
  };

  function bindMap(map) {
    if (map.__wpxBound) return;
    map.__wpxBound = true;
    map.on("click", async event => {
      for (const { fn } of R.clicks) {
        try { if (await fn(map, event)) return; } catch (error) { console.warn("Radar 3.1 tap failed", error); }
      }
    });
    map.on("moveend", () => R.moves.forEach(fn => { try { fn(map); } catch (error) { console.warn(error); } }));
    // A style reload drops add-on sources; put them back once the new style is in.
    map.on("styledata", () => {
      if (!X.mapReady(map) || map.__wpxRestoring) return;
      map.__wpxRestoring = true;
      setTimeout(() => { map.__wpxRestoring = false; R.apply(); }, 0);
    });
  }

  /* ================================================================ Level III site products */
  const FAMILIES = [
    { fam: "B", label: "High-res reflectivity", short: "REF" },
    { fam: "G", label: "Velocity", short: "VEL" },
    { fam: "S", label: "Storm-relative velocity", short: "SRV" },
    { fam: "C", label: "Correlation coefficient (CC)", short: "CC" },
    { fam: "X", label: "Differential reflectivity (ZDR)", short: "ZDR" },
    { fam: "K", label: "Specific differential phase (KDP)", short: "KDP" },
    { fam: "H", label: "Hydrometeor classification", short: "HCA" },
    { fam: "EET", label: "Echo tops", short: "EET" },
    { fam: "DVL", label: "Vertically integrated liquid (VIL)", short: "VIL" }
  ];
  const TILTS = [["0", "Lowest tilt"], ["1", "Tilt 2"], ["2", "Tilt 3"], ["3", "Tilt 4"]];
  const catalog = {};
  let sites = [];
  let metaTimer = 0;
  const L3 = { info: null, error: "", loading: false, timer: 0, want: "" };

  const code = (fam = P.l3.fam, tilt = P.l3.tilt) => (fam.length === 3 ? fam : `N${tilt}${fam}`);
  const tiltable = fam => !!fam && fam.length === 1;
  const displayId = id => (/^[A-Z]{3}$/.test(id) ? ({ GUA: "PGUA", HKI: "PHKI", HKM: "PHKM", HMO: "PHMO", HWA: "PHWA", JUA: "TJUA" }[id] || `K${id}`) : id);
  const kmBetween = (a, b) => { const dl = (a.lat - b.lat) * 111, dn = (a.lon - b.lon) * 111 * Math.cos(a.lat * Math.PI / 180); return Math.sqrt(dl * dl + dn * dn); };

  function loadMeta() {
    const tasks = [];
    if (!Object.keys(catalog).length) {
      tasks.push(getJson(API.radarProducts(), { label: "Radar products" }).then(j => { (j.products || []).forEach(p => { catalog[p.code] = p; }); }).catch(() => {}));
    }
    if (!sites.length) {
      tasks.push(getJson(API.radarSites(), { label: "Radar sites" }).then(j => { sites = (j.sites || []).filter(s => s && s.id && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon))); }).catch(() => {}));
    }
    return Promise.all(tasks).then(() => {
      clearTimeout(metaTimer);
      if (!sites.length || !Object.keys(catalog).length) metaTimer = setTimeout(loadMeta, 15000);
      R.refreshTab("radar");
      if (P.l3.fam && !L3.info && !L3.loading) loadL3(true);
    });
  }

  function siteList() {
    if (sites.length) return sites;
    // The render service's list is authoritative; fall back to the app's NEXRAD table until it loads.
    return typeof RADAR_FALLBACK_SITES !== "undefined" ? RADAR_FALLBACK_SITES.map(([id, lat, lon]) => ({ id, name: "", lat, lon })) : [];
  }

  function sitesByDistance(center = R.mapCenter()) {
    const here = { lat: center.latitude, lon: center.longitude };
    return siteList().map(s => Object.assign({ km: kmBetween(here, { lat: Number(s.lat), lon: Number(s.lon) }) }, s)).sort((a, b) => a.km - b.km);
  }

  const siteId = () => (P.l3.site && P.l3.site !== "auto" ? P.l3.site : (sitesByDistance()[0] || {}).id || "");

  const productPalettes = () => (X.prefs.productPalettes = X.prefs.productPalettes || {});
  const palSpec = fam => (fam && fam !== "H" && productPalettes()[fam] ? productPalettes()[fam].spec : "");

  async function latest(site, productCode) {
    const info = await getJson(API.radarLatest(site, productCode), { label: "Latest radar scan" });
    if (!info || !info.key) throw new Error("No scan is available");
    return info;
  }

  function l3Status() {
    if (!P.l3.fam) return "";
    const sid = siteId();
    if (!sid) return "Loading radar sites…";
    if (L3.error) return `<b>${esc(displayId(sid))}</b>: ${esc(L3.error)} Try another site.`;
    const info = L3.info;
    if (!info) return `Loading <b>${esc(displayId(sid))}</b>…`;
    const tilt = info.elevation ? ` ${Number(info.elevation).toFixed(1)}°` : "";
    const when = new Date(info.valid);
    const hhmm = Number.isNaN(when.getTime()) ? "" : when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const age = Number(info.age_min);
    return `<b>${esc(displayId(info.site || sid))}</b> · ${esc(info.label || code())}${esc(tilt)}${hhmm ? ` · ${esc(hhmm)}` : ""}${Number.isFinite(age) ? ` (${Math.round(age)} min ago)` : ""}${age > 20 ? " · <b>radar may be down</b>" : ""}`;
  }

  function loadL3(force) {
    clearTimeout(L3.timer);
    if (!P.l3.fam) return;
    L3.timer = setTimeout(() => loadL3(true), 60000);
    const sid = siteId();
    const want = `${sid}/${code()}`;
    if (!sid || (!force && L3.want === want && (L3.info || L3.loading))) return;
    if (L3.want !== want) { L3.info = null; L3.error = ""; }
    L3.want = want;
    L3.loading = true;
    syncStatus();
    latest(sid, code()).then(info => {
      if (L3.want !== want) return;
      info.__want = want;
      L3.info = info;
      L3.error = "";
    }).catch(error => {
      if (L3.want !== want) return;
      L3.info = null;
      L3.error = String(error.message || error).replace(/\.?$/, ".");
    }).finally(() => {
      if (L3.want !== want) return;
      L3.loading = false;
      syncStatus();
      R.apply();
    });
  }

  function syncStatus() {
    const el = document.getElementById("wpxL3Status");
    if (el) el.innerHTML = l3Status();
    const mr = document.getElementById("wpxMrmsStatus");
    if (mr) mr.innerHTML = mrmsStatus();
  }

  R.addLayer((map, before) => {
    const nexrad = map.getLayer("wp-nexrad-layer");
    if (!P.l3.fam) {
      X.removeLayerAndSource(map, "wpx-l3");
      if (nexrad) try { map.setLayoutProperty("wp-nexrad-layer", "visibility", "visible"); } catch (_) {}
      return;
    }
    // A single-site product replaces the national mosaic while it is selected (as on the website).
    if (nexrad) try { map.setLayoutProperty("wp-nexrad-layer", "visibility", "none"); } catch (_) {}
    const info = L3.info;
    if (!info || info.__want !== `${siteId()}/${code()}`) { X.removeLayerAndSource(map, "wpx-l3"); return; }
    X.setRaster(map, "wpx-l3", [API.radarTile(info.key, palSpec(P.l3.fam))], { opacity: P.l3.opacity, beforeId: before, maxzoom: 16, attribution: "NEXRAD Level III: NOAA/NWS · WeatherPower render" });
  });

  // Auto site follows the map center, like the website's "Nearest to map center".
  R.onMove(() => {
    if (!P.l3.fam || P.l3.site !== "auto") return;
    if (`${siteId()}/${code()}` !== L3.want) loadL3(true);
    R.refreshTab("radar");
  });

  function legendHtml(stops, classes, title, units) {
    if (classes && classes.length) {
      return `<div class="wpx-legend"><div class="wpx-legend-t">${esc(title)}</div><div class="wpx-classes">${classes.map(c => `<span><i style="background:${escA(c[2])}"></i>${esc(c[1])}</span>`).join("")}</div></div>`;
    }
    if (!stops || stops.length < 2) return "";
    const lo = stops[0][0], hi = stops[stops.length - 1][0], span = (hi - lo) || 1;
    const grad = stops.map(s => `${s[1]} ${(((s[0] - lo) / span) * 100).toFixed(1)}%`).join(",");
    const mid = stops[Math.floor(stops.length / 2)][0];
    const fmt = v => String(Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 100) / 100);
    return `<div class="wpx-legend"><div class="wpx-legend-t">${esc(title)}${units ? ` <small>${esc(units)}</small>` : ""}</div><div class="wpx-palbar" style="background:linear-gradient(90deg,${escA(grad)})"></div><div class="wpx-palscale"><span>${esc(fmt(lo))}</span><span>${esc(fmt(mid))}</span><span>${esc(fmt(hi))}</span></div></div>`;
  }

  function l3Legend() {
    let p = catalog[code()];
    if (!P.l3.fam || !p) return "";
    const imported = P.l3.fam !== "H" && productPalettes()[P.l3.fam];
    if (imported) p = { label: `${p.label} · ${imported.name}`, units: p.units, stops: imported.stops.map(x => [x.value, x.color]) };
    return legendHtml(p.stops, p.classes, p.label, p.units);
  }

  /* ================================================================ color tables (GR / WxTools palettes) */
  const PAL_TARGETS = [["B", "Reflectivity"], ["G", "Velocity"], ["S", "Storm-relative velocity"], ["C", "Correlation coefficient (CC)"],
    ["X", "Differential reflectivity (ZDR)"], ["K", "Specific differential phase (KDP)"], ["EET", "Echo tops"], ["DVL", "VIL"]];
  const PAL_NAME = Object.fromEntries(PAL_TARGETS);
  const pal = { pending: null, raw: "", target: "B", status: "", busy: false };

  const clampByte = n => { n = Number(n); return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : 0; };
  const hex2 = n => clampByte(n).toString(16).padStart(2, "0");
  const rgbHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  function normalizeHex(v) {
    v = String(v || "").trim();
    if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v.slice(1).split("").map(c => c + c).join("")}`.toLowerCase();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
    return null;
  }
  const safeName = v => String(v || "Imported Color Table").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 96) || "Imported Color Table";
  const parseNumber = v => { const n = Number(String(v).replace(/[^0-9+\-.eE]/g, "")); return Number.isFinite(n) ? n : null; };

  function addStop(stops, value, color, alpha, endColor, endAlpha) {
    const v = parseNumber(value), c = normalizeHex(color);
    if (v === null || !c) return;
    const stop = { value: v, color: c, alpha: alpha == null ? 1 : Math.max(0, Math.min(1, Number(alpha) || 0)) };
    const ec = normalizeHex(endColor);
    if (ec) {
      stop.endColor = ec;
      stop.endAlpha = endAlpha == null ? stop.alpha : Math.max(0, Math.min(1, Number(endAlpha) || 0));
    }
    stops.push(stop);
  }

  function parseJsonPalette(text, sourceName) {
    const obj = JSON.parse(text);
    const stops = [];
    const arr = Array.isArray(obj) ? obj : obj && Array.isArray(obj.stops) ? obj.stops : obj && Array.isArray(obj.colors) ? obj.colors : obj && Array.isArray(obj.palette) ? obj.palette : [];
    arr.forEach((x, i) => {
      if (Array.isArray(x)) {
        if (x.length >= 7) addStop(stops, x[0], rgbHex(x[1], x[2], x[3]), 1, rgbHex(x[4], x[5], x[6]), 1);
        else if (x.length >= 4) addStop(stops, x[0], rgbHex(x[1], x[2], x[3]));
        else if (x.length >= 2) addStop(stops, x[0], x[1]);
      } else if (x && typeof x === "object") {
        const value = x.value != null ? x.value : x.dbz != null ? x.dbz : x.level != null ? x.level : i;
        const color = x.color || x.hex || (x.r != null ? rgbHex(x.r, x.g, x.b) : null);
        const endColor = x.endColor || x.color2 || x.endHex || (x.r2 != null ? rgbHex(x.r2, x.g2, x.b2) : null);
        addStop(stops, value, color, x.alpha, endColor, x.endAlpha != null ? x.endAlpha : x.alpha2);
      }
    });
    if (stops.length < 2) throw new Error("No usable color stops were found in the JSON file.");
    return { name: safeName((obj && (obj.name || obj.title || obj.paletteName)) || sourceName), units: String((obj && obj.units) || "dBZ"), product: String((obj && obj.product) || "reflectivity"), stops };
  }

  function parseTextPalette(text, sourceName) {
    const stops = [];
    let name = sourceName || "Imported Color Table", units = "dBZ", product = "reflectivity";
    String(text || "").replace(/^﻿/, "").split(/\r?\n/).forEach(raw => {
      const line = String(raw || "").replace(/;.*$/, "").trim(); // GRLevelX comments start with ';'
      if (!line || /^(#|\/\/)/.test(line)) return;
      let m;
      if ((m = line.match(/^(?:name|title)\s*[:=]\s*(.+)$/i))) { name = safeName(m[1]); return; }
      if ((m = line.match(/^units?\s*[:=]\s*(.+)$/i))) { units = safeName(m[1]); return; }
      if ((m = line.match(/^product\s*[:=]\s*(.+)$/i))) { product = safeName(m[1]); return; }
      // GRLevelX v2: Color: v R G B [R2 G2 B2] · Color4: v R G B A [R2 G2 B2 A2] · SolidColor(4): single color band.
      // The optional second color is the end of the gradient band that runs to the next value.
      m = line.match(/^(color4|solidcolor4|color|solidcolor)\s*:\s*(.+)$/i);
      if (m) {
        const kind = m[1].toLowerCase();
        const nums = (m[2].match(/[-+]?\d+(?:\.\d+)?/g) || []).map(Number);
        if (nums.length < 4) return;
        const value = nums[0];
        if (kind === "color" || kind === "solidcolor") {
          const c1 = rgbHex(nums[1], nums[2], nums[3]);
          if (kind === "solidcolor") addStop(stops, value, c1, 1, c1, 1);
          else if (nums.length >= 7) addStop(stops, value, c1, 1, rgbHex(nums[4], nums[5], nums[6]), 1);
          else addStop(stops, value, c1, 1);
          return;
        }
        if (nums.length < 5) return;
        const a1 = Math.max(0, Math.min(255, Number(nums[4]) || 0)) / 255;
        const c4 = rgbHex(nums[1], nums[2], nums[3]);
        if (kind === "solidcolor4") addStop(stops, value, c4, a1, c4, a1);
        else if (nums.length >= 9) addStop(stops, value, c4, a1, rgbHex(nums[5], nums[6], nums[7]), Math.max(0, Math.min(255, Number(nums[8]) || 0)) / 255);
        else addStop(stops, value, c4, a1);
        return;
      }
      if ((m = line.match(/^([-+]?\d+(?:\.\d+)?)\s*[,;\s]\s*(#[0-9a-f]{3,6})\b/i))) { addStop(stops, m[1], m[2]); return; }
      if ((m = line.match(/^([-+]?\d+(?:\.\d+)?)\s*[,;\s]+\s*([0-9]{1,3})\s*[,;\s]+\s*([0-9]{1,3})\s*[,;\s]+\s*([0-9]{1,3})/))) { addStop(stops, m[1], rgbHex(m[2], m[3], m[4])); return; }
      if ((m = line.match(/^([-+]?\d+(?:\.\d+)?)\s*[:=]\s*rgb\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*\)/i))) addStop(stops, m[1], rgbHex(m[2], m[3], m[4]));
    });
    if (stops.length < 2) throw new Error("Not enough color stops were found. Use a GR2Analyst / GRLevel3, WxTools or RadarScope palette.");
    return { name: safeName(name), units, product, stops };
  }

  function parsePalette(text, sourceName) {
    const trimmed = String(text || "").trim();
    if (!trimmed) throw new Error("The palette file was empty.");
    const p = /^[[{]/.test(trimmed) ? parseJsonPalette(trimmed, sourceName) : parseTextPalette(trimmed, sourceName);
    p.stops = p.stops.filter(s => Number.isFinite(s.value) && normalizeHex(s.color)).sort((a, b) => a.value - b.value);
    const dedup = [];
    p.stops.forEach(s => { if (dedup.length && dedup[dedup.length - 1].value === s.value) dedup[dedup.length - 1] = s; else dedup.push(s); });
    p.stops = dedup;
    return p;
  }

  function detectTarget(p, raw) {
    const t = `${(p && p.product) || ""} ${(p && p.name) || ""} ${(String(raw || "").match(/^\s*product\s*[:=].*$/im) || [""])[0]}`.toLowerCase();
    if (/\bsrv\b|storm.?rel/.test(t)) return "S";
    if (/\b(bv|vel|velocity|n0u|n0g|n0v)\b/.test(t) || /\b(kts?|knots|mph|m\/s)\b/i.test((p && p.units) || "")) return "G";
    if (/\b(cc|rho|rhohv|correl)/.test(t)) return "C";
    if (/\bzdr\b|diff\w*\s*refl/.test(t)) return "X";
    if (/\bkdp\b|specific/.test(t)) return "K";
    if (/\b(et|eet|echo\s*tops?)\b/.test(t)) return "EET";
    if (/\bvil\b/.test(t)) return "DVL";
    return "B";
  }

  // Server products use kt for velocity, a 0–1 fraction for CC and kft for echo tops.
  function convertPalette(p, target) {
    const u = String(p.units || "").toLowerCase();
    let f = 1, note = "";
    if (target === "G" || target === "S") {
      if (/mph/.test(u)) { f = 0.868976; note = "mph → kt"; } else if (/m\/?s|mps|meters/.test(u)) { f = 1.943844; note = "m/s → kt"; }
    } else if (target === "C") {
      if (p.stops[p.stops.length - 1].value > 2) { f = 0.01; note = "percent → fraction"; }
    } else if (target === "EET" && /\bkm\b/.test(u)) { f = 3.28084; note = "km → kft"; }
    return { stops: p.stops.map(s => Object.assign({}, s, { value: Math.round(s.value * f * 10000) / 10000 })), note };
  }

  const hexA = (c, a) => { const h = String(c || "#000000").replace("#", "").slice(0, 6); return a != null && a < 1 ? h + (`0${Math.round(a * 255).toString(16)}`).slice(-2) : h; };
  // The render service's ?pal= format: value_rrggbb[aa][_rrggbb[aa]] stops joined with "~".
  const palSpecOf = stops => stops.slice(0, 96).map(s => `${String(Number(s.value.toFixed(4)))}_${hexA(s.color, s.alpha)}${s.endColor ? `_${hexA(s.endColor, s.endAlpha)}` : ""}`).join("~");

  function gradientCss(stops) {
    const lo = stops[0].value, hi = stops[stops.length - 1].value, span = Math.max(1e-6, hi - lo);
    return `linear-gradient(90deg,${stops.map(s => `${s.color} ${(((s.value - lo) / span) * 100).toFixed(1)}%`).join(",")})`;
  }

  // Google Drive / Dropbox / GitHub share links point at web pages; turn them into the raw file.
  function directLink(u) {
    try {
      const x = new URL(u);
      let m;
      if (/^drive\.google\.com$/i.test(x.hostname) && (m = x.pathname.match(/\/file\/d\/([^/]+)/))) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
      if (/^drive\.google\.com$/i.test(x.hostname) && x.pathname === "/open" && x.searchParams.get("id")) return `https://drive.google.com/uc?export=download&id=${x.searchParams.get("id")}`;
      if (/^(www\.)?dropbox\.com$/i.test(x.hostname)) { x.searchParams.set("dl", "1"); return x.href; }
      if (/^github\.com$/i.test(x.hostname) && (m = x.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/))) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
    } catch (_) {}
    return u;
  }

  function previewPalette(text, sourceName) {
    try {
      const p = parsePalette(text, sourceName);
      pal.pending = p;
      pal.raw = text;
      pal.target = detectTarget(p, text);
      pal.status = "";
    } catch (error) {
      pal.pending = null;
      pal.status = error.message || "That palette could not be read.";
    }
    R.refreshTab("radar");
  }

  function importPaletteFile(file) {
    if (!file) return;
    if (file.size > 1048576) { pal.status = "Palette file is larger than 1 MB."; R.refreshTab("radar"); return; }
    const reader = new FileReader();
    reader.onload = () => previewPalette(String(reader.result || ""), (file.name || "Imported").replace(/\.[^.]+$/, ""));
    reader.onerror = () => { pal.status = "That file could not be opened."; R.refreshTab("radar"); };
    reader.readAsText(file);
  }

  async function importPaletteLink(url) {
    url = String(url || "").trim();
    if (!url) { pal.status = "Paste a palette link first."; R.refreshTab("radar"); return; }
    let parsed;
    try { parsed = new URL(url); } catch (_) { pal.status = "That link isn't a valid web address."; R.refreshTab("radar"); return; }
    if (parsed.protocol !== "https:") { pal.status = "Only HTTPS palette links are accepted."; R.refreshTab("radar"); return; }
    pal.busy = true;
    pal.status = "Downloading the color table…";
    R.refreshTab("radar");
    try {
      const text = await getText(API.paletteFetch(directLink(parsed.href)), { timeoutMs: 30000 });
      if (text.length > 1048576) throw new Error("Palette file is larger than 1 MB.");
      if (!text.trim()) throw new Error("The downloaded file was empty.");
      const nameFromUrl = decodeURIComponent(parsed.pathname.split("/").pop() || "Imported").replace(/\.[^.]+$/, "");
      pal.busy = false;
      previewPalette(text, nameFromUrl);
    } catch (error) {
      pal.busy = false;
      pal.status = error.message || "Could not import this color table.";
      R.refreshTab("radar");
    }
  }

  function applyPendingPalette() {
    const p = pal.pending;
    if (!p) return;
    const c = convertPalette(p, pal.target);
    productPalettes()[pal.target] = { name: p.name, stops: c.stops, spec: palSpecOf(c.stops), units: p.units || "", importedAt: new Date().toISOString() };
    save();
    say(`${PAL_NAME[pal.target]} color table imported: ${p.name}`);
    pal.pending = null;
    pal.status = "";
    if (P.l3.fam === pal.target) R.apply();
    R.refreshTab("radar");
  }

  function paletteSection() {
    const saved = productPalettes();
    const pending = pal.pending;
    const conv = pending ? convertPalette(pending, pal.target) : null;
    return `
      <div class="wpx-label">Color tables</div>
      <div class="wpx-inline">
        <label class="wpx-btn wpx-file">Import file<input type="file" id="wpxPalFile" accept=".pal,.txt,.json,text/plain,application/json,application/octet-stream"></label>
        <input type="search" id="wpxPalUrl" placeholder="…or paste a Drive / Dropbox / GitHub link" aria-label="Palette link">
        <button class="wpx-btn" data-wpx="palFetch"${pal.busy ? " disabled" : ""}>Fetch</button>
      </div>
      ${pal.status ? `<p class="wpx-note">${esc(pal.status)}</p>` : ""}
      ${pending ? `<div class="wpx-card">
        <strong>${esc(pending.name)}</strong><small class="wpx-sub"> · ${pending.stops.length} stops${pending.units ? ` · ${esc(pending.units)}` : ""}</small>
        <div class="wpx-palbar" style="background:${escA(gradientCss(pending.stops))}"></div>
        <div class="wpx-inline" style="margin-top:8px"><span class="wpx-sub">Apply to</span><select id="wpxPalTarget" aria-label="Apply palette to">${PAL_TARGETS.map(([k, n]) => `<option value="${k}"${k === pal.target ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></div>
        ${conv && conv.note ? `<p class="wpx-note">Units converted: ${esc(conv.note)}.</p>` : ""}
        <div class="wpx-btnrow"><button class="wpx-btn primary" data-wpx="palApply">Apply</button><button class="wpx-btn subtle" data-wpx="palCancel">Cancel</button></div>
      </div>` : ""}
      ${Object.keys(saved).length ? `<div class="wpx-pallist">${Object.entries(saved).map(([k, s]) => `<div class="wpx-palitem"><i style="background:${escA(gradientCss(s.stops))}"></i><span>${esc(PAL_NAME[k] || k)} <small>· ${esc(s.name)}</small></span><button data-wpx="palRemove" data-k="${escA(k)}" aria-label="Reset ${escA(PAL_NAME[k] || k)} to WeatherPower colors">×</button></div>`).join("")}</div>` : `<p class="wpx-note">Imported tables recolor the matching site product (a velocity table recolors Velocity, and so on).</p>`}`;
  }

  /* ================================================================ Radar tab */
  function radarBody() {
    const fam = P.l3.fam;
    const near = sitesByDistance().slice(0, 15);
    const chosen = P.l3.site !== "auto" && !near.some(s => s.id === P.l3.site) ? siteList().find(s => s.id === P.l3.site) : null;
    const opt = s => `<option value="${escA(s.id)}"${P.l3.site === s.id ? " selected" : ""}>${esc(displayId(s.id))}${s.name ? ` · ${esc(s.name)}` : ""}${Number.isFinite(s.km) ? ` (${Math.round(s.km * 0.621)} mi)` : ""}</option>`;
    return `
      <div class="wpx-label">Radar product</div>
      <div class="wpx-chips">${R.chip("l3Fam", "Composite", !fam, 'data-fam="" title="National mosaic"')}${FAMILIES.map(f => R.chip("l3Fam", f.short, fam === f.fam, `data-fam="${f.fam}" title="${escA(f.label)}"`)).join("")}</div>
      <p class="wpx-note">${fam ? esc((FAMILIES.find(f => f.fam === fam) || {}).label || fam) : "Composite: the national radar mosaic from the main radar controls."}</p>
      ${tiltable(fam) ? `<div class="wpx-label">Product tilt</div><div class="wpx-chips">${TILTS.map(([t, label]) => R.chip("l3Tilt", label, P.l3.tilt === t, `data-tilt="${t}"`)).join("")}</div>` : ""}
      ${fam ? `<div class="wpx-label">Radar site</div>
      <select id="wpxSite" aria-label="Radar site"><option value="auto"${P.l3.site === "auto" ? " selected" : ""}>Nearest to map center</option>${chosen ? opt(chosen) : ""}${near.map(opt).join("")}</select>
      <p class="wpx-note" id="wpxL3Status">${l3Status()}</p>
      ${l3Legend()}
      <div class="wpx-label">Opacity <span id="wpxL3OpacityValue">${Math.round(P.l3.opacity * 100)}%</span></div>
      <input type="range" id="wpxL3Opacity" min="20" max="100" value="${Math.round(P.l3.opacity * 100)}" aria-label="Site product opacity">` : ""}
      ${paletteSection()}`;
  }

  R.addTab({
    id: "radar", label: "Radar", order: 10, body: radarBody,
    onOpen: () => { loadMeta(); },
    onInput: e => {
      if (e.target.id === "wpxL3Opacity") {
        P.l3.opacity = Number(e.target.value) / 100;
        const label = document.getElementById("wpxL3OpacityValue");
        if (label) label.textContent = `${e.target.value}%`;
        try { R.map()?.setPaintProperty("wpx-l3-layer", "raster-opacity", P.l3.opacity); } catch (_) {}
        save();
      }
    },
    onChange: e => {
      const t = e.target;
      if (t.id === "wpxSite") { P.l3.site = t.value; save(); loadL3(true); R.apply(); R.renderSheet(); }
      else if (t.id === "wpxPalFile") { importPaletteFile(t.files && t.files[0]); t.value = ""; }
      else if (t.id === "wpxPalTarget") { pal.target = t.value; R.renderSheet(); }
    }
  });

  /* ================================================================ MRMS */
  const WINDOW_LABEL = { 30: "30 min", 60: "1 hour", 120: "2 hours", 240: "4 hours", 360: "6 hours", 1440: "24 hours",
    "01": "1 hour", "03": "3 hours", "06": "6 hours", 12: "12 hours", 24: "24 hours", 48: "48 hours", 72: "72 hours" };
  const DEF_WINDOW = { hail: "1440", rotation: "1440", rotation_mid: "1440", rain: "24" };
  const MRMS_CHOICES = [["hail", "Hail swath (max hail size)"], ["rotation", "Rotation track (low-level)"], ["rotation_mid", "Rotation track (mid-level)"], ["rain", "Rainfall total"]];
  const mrmsCatalog = {};
  const MR = { info: null, error: "", timer: 0, want: "" };

  const windowLabel = w => WINDOW_LABEL[w] || String(w);
  const fmtMrms = (product, v) => (product.indexOf("rotation") === 0 ? `${v.toFixed(3)} s⁻¹` : `${v < 1 ? v.toFixed(2) : v.toFixed(v < 10 ? 2 : 1)} in`);

  function loadMrmsCatalog() {
    if (Object.keys(mrmsCatalog).length) return Promise.resolve(mrmsCatalog);
    return getJson(API.mrmsProducts(), { label: "MRMS products" }).then(j => { (j.products || []).forEach(p => { mrmsCatalog[p.code] = p; }); return mrmsCatalog; });
  }

  function mrmsWindows(product) {
    const p = mrmsCatalog[product];
    return p && Array.isArray(p.windows) && p.windows.length ? p.windows.map(String) : [DEF_WINDOW[product]];
  }

  function mrmsDefaults() {
    if (!P.mrms.product) return;
    const wins = mrmsWindows(P.mrms.product);
    if (!wins.includes(String(P.mrms.window))) P.mrms.window = wins.includes(DEF_WINDOW[P.mrms.product]) ? DEF_WINDOW[P.mrms.product] : wins[wins.length - 1];
  }

  function mrmsStatus() {
    if (!P.mrms.product) return "";
    if (MR.error) return `MRMS unavailable: ${esc(MR.error)}`;
    const j = MR.info;
    if (!j) return "Loading NOAA MRMS…";
    const t = new Date(j.valid);
    return `<b>${esc(j.label || P.mrms.product)}</b> · last ${esc(windowLabel(P.mrms.window))}${Number.isNaN(t.getTime()) ? "" : ` · through ${esc(t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}`}${Number.isFinite(Number(j.age_min)) ? ` (${Math.round(j.age_min)} min ago)` : ""} · tap the map for a value`;
  }

  function loadMrms(force) {
    clearTimeout(MR.timer);
    if (!P.mrms.product) return;
    MR.timer = setTimeout(() => loadMrms(true), 5 * 60000);
    const want = `${P.mrms.product}/${P.mrms.window}`;
    if (!force && MR.want === want && MR.info) return;
    if (MR.want !== want) MR.info = null;
    MR.want = want;
    MR.error = "";
    syncStatus();
    getJson(API.mrmsLatest(P.mrms.product, P.mrms.window), { label: "MRMS latest" }).then(j => {
      if (MR.want !== want || j.product !== P.mrms.product || String(j.window) !== String(P.mrms.window)) return;
      if (!j.key) throw new Error("No MRMS scan is available right now");
      MR.info = j;
    }).catch(error => {
      if (MR.want !== want) return;
      MR.info = null;
      MR.error = String(error.message || error);
    }).finally(() => {
      if (MR.want !== want) return;
      syncStatus();
      R.apply();
    });
  }

  R.addLayer((map, before) => {
    if (!P.mrms.product || !MR.info || MR.want !== `${P.mrms.product}/${P.mrms.window}`) { X.removeLayerAndSource(map, "wpx-mrms"); return; }
    X.setRaster(map, "wpx-mrms", [API.mrmsTile(MR.info.key)], { opacity: P.mrms.opacity, beforeId: before, maxzoom: 14, attribution: "MRMS: NOAA/NSSL" });
  });

  R.addClick(async (map, event) => {
    if (!P.mrms.product || !MR.info) return false;
    const { lng, lat } = event.lngLat;
    const j = await getJson(API.mrmsValue(MR.info.key, lat, lng), { label: "MRMS value" });
    const p = mrmsCatalog[P.mrms.product];
    const floor = p && p.stops && p.stops.length ? p.stops[0][0] : 0;
    const v = j.value;
    const what = P.mrms.product === "hail" ? "Max hail size" : P.mrms.product === "rain" ? "Rainfall" : "Peak rotation";
    R.popup(map, event.lngLat, `${esc(what)}<br><b>${v == null ? "Outside MRMS coverage" : Number(v) < floor ? "None recorded" : esc(fmtMrms(P.mrms.product, Number(v)))}</b><br><small>Last ${esc(windowLabel(P.mrms.window))} · NOAA MRMS estimate for this ~1 km cell</small>`);
    return true;
  }, 30);

  function mrmsLegend() {
    const p = mrmsCatalog[P.mrms.product];
    if (!p || !p.stops || !p.stops.length) return "";
    return `<div class="wpx-legend"><div class="wpx-legend-t">${esc(p.label)} <small>${esc(windowLabel(P.mrms.window))} · NOAA MRMS</small></div><div class="wpx-swatches">${p.stops.map(s => `<i style="background:${escA(s[1])}"></i>`).join("")}</div><div class="wpx-palscale"><span>${esc(fmtMrms(p.code, p.stops[0][0]))}</span><span>${esc(fmtMrms(p.code, p.stops[p.stops.length - 1][0]))}+</span></div></div>`;
  }

  function mrmsBody() {
    const product = P.mrms.product;
    return `
      <div class="wpx-label">Storm damage layers (MRMS)</div>
      <div class="wpx-chips">${R.chip("mrmsProduct", "Off", !product, 'data-id=""')}${MRMS_CHOICES.map(([id, label]) => R.chip("mrmsProduct", label, product === id, `data-id="${id}"`)).join("")}</div>
      ${product ? `<div class="wpx-label">Time window</div><div class="wpx-chips">${mrmsWindows(product).map(w => R.chip("mrmsWindow", windowLabel(w), String(P.mrms.window) === w, `data-w="${escA(w)}"`)).join("")}</div>
      <p class="wpx-note" id="wpxMrmsStatus">${mrmsStatus()}</p>
      ${mrmsLegend()}
      <div class="wpx-label">Opacity</div><input type="range" id="wpxMrmsOpacity" min="20" max="100" value="${Math.round(P.mrms.opacity * 100)}" aria-label="MRMS opacity">` : ""}
      <p class="wpx-note">Values are NOAA Multi-Radar/Multi-Sensor estimates; an empty map means none were recorded.</p>`;
  }

  R.addTab({
    id: "mrms", label: "MRMS", order: 20, body: mrmsBody,
    onOpen: () => { loadMrmsCatalog().then(() => { mrmsDefaults(); R.refreshTab("mrms"); }).catch(() => {}); },
    onInput: e => {
      if (e.target.id === "wpxMrmsOpacity") {
        P.mrms.opacity = Number(e.target.value) / 100;
        try { R.map()?.setPaintProperty("wpx-mrms-layer", "raster-opacity", P.mrms.opacity); } catch (_) {}
        save();
      }
    }
  });

  /* ================================================================ actions */
  Object.assign(X.actions, {
    openRadar31: () => { if (R.isOpen()) R.closeSheet(); else R.openSheet(); },
    r31Open: el => {
      const tab = el.dataset.tab || "radar";
      try { closePage(); } catch (_) {}
      if (state.tab !== "radar") setTab("radar");
      setTimeout(() => { R.openSheet(tab); if (el.dataset.then && X.actions[el.dataset.then]) X.actions[el.dataset.then](el); }, 150);
    },
    closeSheet: () => R.closeSheet(),
    sheetTab: el => { P.tab = el.dataset.tab; save(); currentTab()?.onOpen?.(); R.renderSheet(); },
    l3Fam: el => {
      P.l3.fam = el.dataset.fam || "";
      if (!tiltable(P.l3.fam)) P.l3.tilt = "0";
      save();
      loadMeta();
      if (P.l3.fam) loadL3(true); else clearTimeout(L3.timer);
      R.apply();
      R.renderSheet();
    },
    l3Tilt: el => { P.l3.tilt = el.dataset.tilt || "0"; save(); loadL3(true); R.apply(); R.renderSheet(); },
    palFetch: () => importPaletteLink(document.getElementById("wpxPalUrl")?.value),
    palApply: () => applyPendingPalette(),
    palCancel: () => { pal.pending = null; pal.status = ""; R.renderSheet(); },
    palRemove: el => {
      const k = el.dataset.k;
      delete productPalettes()[k];
      save();
      say(`${PAL_NAME[k] || k} reset to WeatherPower colors.`);
      if (P.l3.fam === k) R.apply();
      R.renderSheet();
    },
    mrmsProduct: el => {
      P.mrms.product = el.dataset.id || "";
      const go = () => { mrmsDefaults(); save(); loadMrms(true); R.apply(); R.refreshTab("mrms"); };
      if (P.mrms.product) { loadMrmsCatalog().then(go, go); R.renderSheet(); } else { clearTimeout(MR.timer); MR.info = null; MR.want = ""; save(); R.apply(); R.renderSheet(); }
    },
    mrmsWindow: el => { P.mrms.window = el.dataset.w; save(); loadMrms(true); R.apply(); R.renderSheet(); }
  });

  /* ================================================================ hooks into the main radar */
  if (typeof runRadarMapLayerUpdate === "function") {
    const original = runRadarMapLayerUpdate;
    // eslint-disable-next-line no-global-assign
    runRadarMapLayerUpdate = function () {
      const out = original.apply(this, arguments);
      try { R.apply(); } catch (error) { console.warn("Radar 3.1 layer sync failed", error); }
      return out;
    };
  }
  if (typeof installRadarMapLayers === "function") {
    const originalInstall = installRadarMapLayers;
    // eslint-disable-next-line no-global-assign
    installRadarMapLayers = function () {
      const out = originalInstall.apply(this, arguments);
      try { R.apply(); } catch (error) { console.warn("Radar 3.1 layer install failed", error); }
      return out;
    };
  }

  function injectButton() {
    const bar = document.querySelector("#radarContent .radar-side-actions");
    if (!bar || bar.querySelector("[data-wpx='openRadar31']")) return;
    const btn = document.createElement("button");
    btn.className = "radar-round wpx-r31-btn";
    btn.dataset.wpx = "openRadar31";
    btn.setAttribute("aria-label", "Radar 3.1 tools");
    btn.title = "Radar 3.1 tools";
    btn.textContent = "3.1";
    bar.prepend(btn);
  }
  if (typeof renderRadar === "function") {
    const originalRender = renderRadar;
    // eslint-disable-next-line no-global-assign
    renderRadar = function () {
      const out = originalRender.apply(this, arguments);
      try { injectButton(); } catch (error) { console.warn(error); }
      return out;
    };
  }
  if (typeof setTab === "function") {
    const originalSetTab = setTab;
    // eslint-disable-next-line no-global-assign
    setTab = function (tab) {
      if (tab !== "radar") R.closeSheet();
      const out = originalSetTab.apply(this, arguments);
      try { injectButton(); } catch (_) {}
      return out;
    };
  }
  injectButton();
  if (P.l3.fam) loadMeta();
  if (P.mrms.product) loadMrmsCatalog().then(() => { mrmsDefaults(); loadMrms(true); }).catch(() => loadMrms(true));

  /* ================================================================ API for the TV shell */
  X.radar = {
    FAMILIES, DEF_WINDOW, displayId, loadMeta, sitesByDistance, latest,
    l3Tiles: (info, fam) => API.radarTile(info.key, palSpec(fam)),
    mrmsLatest: (product, windowKey = DEF_WINDOW[product]) => getJson(API.mrmsLatest(product, windowKey), { label: "MRMS latest" })
      .then(j => { if (!j.key) throw new Error("No MRMS scan is available right now"); return { info: j, tiles: API.mrmsTile(j.key) }; })
  };
})();
