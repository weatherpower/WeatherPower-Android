/* WeatherPower 1.8 add-ons: shared core for Radar 3.1, Tropical Storm Center and Android TV.
 * Loaded after the main index.html script, so its top-level bindings (state, radarMap, toast,
 * escapeHtml, fetchJsonWithNativeFallback, ...) are reachable here by name. */
(function () {
  "use strict";

  const RENDER = "https://weatherpower.app/wpcc-render";
  const API_SERVER = "https://weatherpower.app/wpcc-api";
  const MODELS = `${RENDER}/api/models`;
  const enc = encodeURIComponent;

  // Every WeatherPower server path used by the add-ons, matching the Radar 3.1 web blocks.
  // Level III site ids are the 3-letter NEXRAD ids ("TLX"), exactly as /api/radar/sites returns them.
  const API = {
    render: RENDER,
    radarProducts: () => `${RENDER}/api/radar/products`,
    radarSites: () => `${RENDER}/api/radar/sites`,
    radarLatest: (site, product) => `${RENDER}/api/radar/latest?site=${enc(site)}&product=${enc(product)}`,
    radarTile: (key, pal) => `${RENDER}/api/radar/tile/${enc(key)}/{z}/{x}/{y}.png${pal ? `?pal=${enc(pal)}` : ""}`,
    radarLive: (site, product) => `${RENDER}/api/radar/live/${enc(site)}/${enc(product)}/{z}/{x}/{y}.png?t=${Math.floor(Date.now() / 60000)}`,
    mrmsProducts: () => `${RENDER}/api/mrms/products`,
    mrmsLatest: (product, windowKey) => `${RENDER}/api/mrms/latest?product=${enc(product)}&window=${enc(windowKey)}`,
    mrmsTile: key => `${RENDER}/api/mrms/tile/${enc(key)}/{z}/{x}/{y}.png`,
    mrmsValue: (key, lat, lon) => `${RENDER}/api/mrms/value?key=${enc(key)}&lat=${Number(lat).toFixed(3)}&lon=${Number(lon).toFixed(3)}`,
    gasDots: () => `${RENDER}/gas/dots.js`,
    gasTile: key => `${RENDER}/gas/t/${key}.js`,
    shelters: () => `${RENDER}/data/tornado-shelters.json`,
    modelCatalog: () => `${MODELS}/catalog`,
    modelRuns: model => `${MODELS}/runs/${enc(model)}`,
    modelHours: (model, run) => `${MODELS}/hours/${enc(model)}/${enc(run)}`,
    modelPrefetch: (model, run, field, first) => `${MODELS}/prefetch?model=${enc(model)}&run=${enc(run)}&field=${enc(field)}&first=${enc(first || 0)}`,
    modelStatus: (model, run, field) => `${MODELS}/status/${enc(model)}/${enc(run)}/${enc(field)}`,
    modelFrame: (model, run, field, fhr) => `${MODELS}/frame/${enc(model)}/${enc(run)}/${enc(field)}/${enc(fhr)}.webp`,
    modelContour: (model, run, field, fhr) => `${MODELS}/contour/${enc(model)}/${enc(run)}/${enc(field)}/${enc(fhr)}.geojson`,
    modelValue: (model, run, field, fhr, lat, lon) => `${MODELS}/value?model=${enc(model)}&run=${enc(run)}&field=${enc(field)}&fhr=${enc(fhr)}&lat=${Number(lat).toFixed(4)}&lon=${Number(lon).toFixed(4)}`,
    soundingImage: (lat, lon, fhr) => `${RENDER}/api/sounding?lat=${Number(lat).toFixed(4)}&lon=${Number(lon).toFixed(4)}&fhr=${enc(fhr)}`,
    soundingJson: (lat, lon) => `${API_SERVER}/sounding?lat=${Number(lat).toFixed(4)}&lon=${Number(lon).toFixed(4)}&model=hrrr&hours=19`,
    paletteFetch: url => `https://weatherpower.app/api/palette-fetch/?url=${enc(url)}`,
    eiaGas: () => "https://api.eia.gov/v2/petroleum/pri/gnd/data/?frequency=weekly&data[0]=value&facets[process][]=PTE" +
      ["EPMR", "EPMM", "EPMP", "EPD2D"].map(p => `&facets[product][]=${p}`).join("") +
      "&sort[0][column]=period&sort[0][direction]=desc&length=500&api_key=DEMO_KEY",
    mapboxDirections: (a, b) => `https://api.mapbox.com/directions/v5/mapbox/driving/${Number(a.longitude)},${Number(a.latitude)};${Number(b.longitude)},${Number(b.latitude)}` +
      `?alternatives=false&geometries=geojson&overview=full&steps=false&language=en&continue_straight=true&access_token=${enc(typeof MAPBOX_TOKEN === "string" ? MAPBOX_TOKEN : "")}`,
    nhcCurrentStorms: () => "https://www.nhc.noaa.gov/CurrentStorms.json",
    nhcMapServer: "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer",
    nwsPoint: (lat, lon) => `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
    nwsAlertsPoint: (lat, lon) => `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`
  };

  const STORE_KEY = "weatherpower.wpx.v1";
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; } catch (_) { return {}; }
  }
  const prefs = loadPrefs();
  function savePrefs() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch (_) {}
  }

  const esc = value => (typeof escapeHtml === "function" ? escapeHtml(value) : String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c])));
  const escA = value => (typeof escapeAttr === "function" ? escapeAttr(value) : esc(value));
  const say = message => { try { toast(message); } catch (_) { console.log(message); } };

  const canNative = url => !!(window.WeatherPowerAndroid && typeof window.WeatherPowerAndroid.fetchUrlAsync === "function" && /^https:\/\//i.test(url) && typeof fetchNativeTextAsync === "function");

  // The native bridge reports failures as {"__wpError":"HTTP 404 {...server body...}"}; recover the server's message.
  function nativeError(raw) {
    const text = String(raw || "");
    const status = text.match(/^HTTP (\d{3})\s*/);
    if (status) {
      try { const body = JSON.parse(text.slice(status[0].length)); if (body && (body.error || body.message)) return body.error || body.message; } catch (_) {}
      return `HTTP ${status[1]}`;
    }
    return text || "Request failed";
  }

  async function nativeText(url, timeoutMs) {
    const text = await fetchNativeTextAsync(url, timeoutMs || 15000);
    if (/^\{"__wpError"/.test(text)) {
      let message = "Request failed";
      try { message = nativeError(JSON.parse(text).__wpError); } catch (_) {}
      throw new Error(message);
    }
    return text;
  }

  // JSON GET that keeps the server's own error text ({"error": "..."}), falling back to the native
  // bridge when the WebView blocks the request (CORS) or the network call fails.
  async function getJson(url, options = {}) {
    if (options.preferNative && canNative(url)) return JSON.parse(await nativeText(url, options.timeoutMs));
    let res;
    try {
      res = await fetch(url, { cache: "no-store", credentials: "omit", headers: Object.assign({ Accept: "application/json" }, options.headers || {}) });
    } catch (networkError) {
      if (canNative(url)) return JSON.parse(await nativeText(url, options.timeoutMs));
      throw networkError;
    }
    let body = null;
    try { body = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((body && (body.error || body.message)) || `HTTP ${res.status}`);
    if (body === null) throw new Error("The server returned no data");
    return body;
  }

  async function getText(url, options = {}) {
    let res;
    try {
      res = await fetch(url, { cache: "no-store", credentials: "omit", headers: options.headers || undefined });
    } catch (networkError) {
      if (canNative(url)) return nativeText(url, options.timeoutMs);
      throw networkError;
    }
    const text = await res.text();
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try { const body = JSON.parse(text); message = body.error || body.message || message; } catch (_) {}
      throw new Error(message);
    }
    return text;
  }

  // <script> loading needs no CORS; the WeatherPower gas feeds are JS files that call a global callback.
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const tag = document.createElement("script");
      tag.src = src;
      tag.async = true;
      tag.onload = () => { tag.remove(); resolve(); };
      tag.onerror = () => { tag.remove(); reject(new Error(`Could not load ${src.replace(/\?.*$/, "")}`)); };
      document.head.appendChild(tag);
    });
  }

  const NWS = { headers: { Accept: "application/geo+json" } };

  // Server responses are wrapped differently per endpoint; pull out the first list we can find.
  function listFrom(json, keys = []) {
    if (Array.isArray(json)) return json;
    if (!json || typeof json !== "object") return [];
    for (const key of keys.concat(["items", "data", "results", "list", "features"])) {
      if (Array.isArray(json[key])) return json[key];
    }
    const firstArray = Object.values(json).find(Array.isArray);
    return firstArray || [];
  }

  function pick(obj, keys, fallback = undefined) {
    if (!obj || typeof obj !== "object") return fallback;
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
    }
    return fallback;
  }

  // Property lookup that ignores field-name case (ArcGIS services differ between upper and lower case).
  function prop(props, name) {
    if (!props) return undefined;
    if (props[name] !== undefined) return props[name];
    const lower = name.toLowerCase();
    if (props[lower] !== undefined) return props[lower];
    const upper = name.toUpperCase();
    if (props[upper] !== undefined) return props[upper];
    const key = Object.keys(props).find(k => k.toLowerCase() === lower);
    return key ? props[key] : undefined;
  }

  function num(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function timeLabel(value) {
    if (value === null || value === undefined || value === "") return "";
    let date;
    if (typeof value === "number") date = new Date(value < 1e12 ? value * 1000 : value);
    else if (/^\d{12}$/.test(String(value))) {
      const v = String(value);
      date = new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(8, 10), +v.slice(10, 12)));
    } else if (/^\d{10}$/.test(String(value))) {
      const v = String(value);
      date = new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(8, 10)));
    } else date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function compass(deg) {
    const d = num(deg);
    if (d === null) return "--";
    return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
  }

  function haversineMiles(a, b) {
    const R = 3958.8, toRad = v => v * Math.PI / 180;
    const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /* ---------- Map helpers (operate on any MapLibre map) ---------- */
  // isStyleLoaded() also turns false while any source is still fetching, which would skip redraws;
  // only the style document itself needs to be in place before adding sources and layers.
  function mapReady(map) {
    try {
      if (!map || !map.style) return false;
      if (map.style._loaded) return true;
      return !!(map.isStyleLoaded && map.isStyleLoaded());
    } catch (_) { return false; }
  }

  function setRaster(map, id, tiles, options = {}) {
    if (!map) return;
    const layerId = `${id}-layer`;
    const key = JSON.stringify(tiles);
    try {
      if (map.getSource(id) && map[`__wpxTiles_${id}`] === key) {
        if (map.getLayer(layerId) && options.opacity !== undefined) map.setPaintProperty(layerId, "raster-opacity", options.opacity);
        return;
      }
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(id)) map.removeSource(id);
      map.addSource(id, { type: "raster", tiles, tileSize: options.tileSize || 256, minzoom: 0, maxzoom: options.maxzoom || 18, attribution: options.attribution || "" });
      map.addLayer({ id: layerId, type: "raster", source: id, paint: { "raster-opacity": options.opacity ?? 0.8, "raster-resampling": options.resampling || "nearest", "raster-fade-duration": 0 } }, options.beforeId && map.getLayer(options.beforeId) ? options.beforeId : undefined);
      map[`__wpxTiles_${id}`] = key;
    } catch (error) {
      console.warn("WPX raster layer failed", id, error);
    }
  }

  function removeLayerAndSource(map, id, layerIds) {
    if (!map) return;
    (layerIds || [`${id}-layer`]).forEach(layerId => { try { if (map.getLayer(layerId)) map.removeLayer(layerId); } catch (_) {} });
    try { if (map.getSource(id)) map.removeSource(id); } catch (_) {}
    try { delete map[`__wpxTiles_${id}`]; } catch (_) {}
  }

  // Optional changeKey skips re-sending unchanged data (large point sets re-tile on every setData).
  function setGeoJson(map, id, data, changeKey) {
    if (!map) return false;
    const source = map.getSource(id);
    map.__wpxDataKeys = map.__wpxDataKeys || {};
    if (source && changeKey !== undefined && map.__wpxDataKeys[id] === changeKey) return true;
    map.__wpxDataKeys[id] = changeKey;
    if (source && source.setData) { source.setData(data); return true; }
    try { map.addSource(id, { type: "geojson", data }); } catch (error) { console.warn("WPX geojson failed", id, error); return false; }
    return false;
  }

  function addLayerOnce(map, spec, beforeId) {
    try { if (!map.getLayer(spec.id)) map.addLayer(spec, beforeId && map.getLayer(beforeId) ? beforeId : undefined); } catch (error) { console.warn("WPX layer failed", spec.id, error); }
  }

  const fc = features => ({ type: "FeatureCollection", features: features || [] });

  // Missing tiles (offline, product not yet published) are routine; keep them out of the error log.
  function quietErrors(map) {
    map.on("error", event => console.warn("WeatherPower map resource unavailable", event?.sourceId || "", event?.error?.message || ""));
    return map;
  }

  /* ---------- Full-screen overlays + bottom sheets ---------- */
  const overlays = [];

  function openOverlay({ id, title, className = "", onClose }) {
    closeOverlay(id, true);
    const el = document.createElement("div");
    el.className = `wpx-overlay ${className}`;
    el.dataset.wpxOverlay = id;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.innerHTML = `<div class="wpx-overlay-head"><button class="wpx-icon-btn" data-wpx="closeOverlay" aria-label="Close">‹</button><strong>${esc(title)}</strong><span class="wpx-head-extra"></span></div><div class="wpx-overlay-body"></div>`;
    document.body.appendChild(el);
    overlays.push({ id, el, onClose });
    requestAnimationFrame(() => el.classList.add("open"));
    return el.querySelector(".wpx-overlay-body");
  }

  function closeOverlay(id, silent) {
    const index = id ? overlays.findIndex(item => item.id === id) : overlays.length - 1;
    if (index < 0) return false;
    const [item] = overlays.splice(index, 1);
    try { item.onClose && item.onClose(); } catch (error) { console.warn(error); }
    item.el.remove();
    if (!silent && window.WPX.tv && window.WPX.tv.active) window.WPX.tv.refocus();
    return true;
  }

  function topOverlay() { return overlays[overlays.length - 1] || null; }

  // Native Back (MainActivity) asks the page first; returning true means the page handled it.
  const backHandlers = [];
  window.wpHandleBack = function () {
    for (const handler of backHandlers) {
      try { if (handler()) return true; } catch (error) { console.warn("Back handler failed", error); }
    }
    if (closeOverlay()) return true;
    try {
      if (document.getElementById("pageModal")?.classList.contains("active")) { closePage(); return true; }
      if (document.getElementById("locationModal")?.classList.contains("active")) { closeLocation(); return true; }
      if (state.tab === "radar" && (state.showRadarLayers || state.showRadarProductMenu)) {
        state.showRadarLayers = false;
        state.showRadarProductMenu = false;
        renderRadar();
        return true;
      }
      if (state.tab !== "now" && !(window.WPX.tv && window.WPX.tv.active)) { setTab("now"); return true; }
    } catch (error) { console.warn(error); }
    return false;
  };

  // Delegated clicks for every add-on control: data-wpx="action" + optional data-* args.
  const actions = {};
  document.addEventListener("click", event => {
    const el = event.target.closest("[data-wpx]");
    if (!el) return;
    const handler = actions[el.dataset.wpx];
    if (!handler) return;
    event.preventDefault();
    event.stopPropagation();
    try { handler(el, event); } catch (error) { console.error("WPX action failed", el.dataset.wpx, error); say("That control hit an error. Try again."); }
  }, true);
  actions.closeOverlay = () => closeOverlay();

  const isTvLaunch = (() => {
    try {
      if (window.WeatherPowerAndroid && typeof window.WeatherPowerAndroid.isTelevision === "function" && window.WeatherPowerAndroid.isTelevision()) return true;
    } catch (_) {}
    return /[?&]tv=1\b/.test(location.search);
  })();

  function openExternal(url) {
    if (!url) return;
    try { window.open(url, "_blank", "noopener"); } catch (_) { location.href = url; }
  }
  actions.openUrl = el => openExternal(el.dataset.url);

  window.WPX = Object.assign(window.WPX || {}, {
    API, prefs, savePrefs, esc, escA, say, getJson, getText, loadScript, NWS, listFrom, pick, prop, num, timeLabel, compass, haversineMiles,
    mapReady, quietErrors, setRaster, removeLayerAndSource, setGeoJson, addLayerOnce, fc,
    openOverlay, closeOverlay, topOverlay, backHandlers, actions, isTvLaunch, openExternal,
    basemapStyle: () => (typeof mapLibreStyle === "function" ? mapLibreStyle() : "https://weatherpower.app/maps/weatherpower/style.json")
  });
})();
