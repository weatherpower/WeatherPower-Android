/* WeatherPower Radar 3.1 tools for the Android app.
 * Level III site products (all tilts), MRMS hail/rotation/rain, gas stations, tornado shelters,
 * route weather, point soundings, Model Studio and GR-style palette import.
 * Everything draws on the existing radar MapLibre map (the user's WeatherPower basemap). */
(function () {
  "use strict";
  const X = window.WPX;
  if (!X) return;
  const { API, esc, escA, say, getJson, getText, listFrom, pick, num, timeLabel, fc } = X;

  /* ---------- Settings ---------- */
  const defaults = {
    tab: "radar",
    l3: { on: false, site: "", family: "B", code: "N0B", tilt: 0, pal: "", opacity: 0.8 },
    mrms: { product: "", window: "" , opacity: 0.8 },
    gas: false,
    shelters: false,
    model: { on: false, model: "hrrr", run: "", field: "", fhr: 0, opacity: 0.7 }
  };
  const P = X.prefs.radar31 = Object.assign({}, defaults, X.prefs.radar31 || {});
  ["l3", "mrms", "model"].forEach(k => { P[k] = Object.assign({}, defaults[k], P[k] || {}); });
  P.model.on = false; // Model frames are opt-in each session, like the main app's model layer.
  const palettes = X.prefs.palettes = X.prefs.palettes || {};
  const save = () => X.savePrefs();

  /* ---------- Level III products ---------- */
  const L3_FAMILIES = [
    { family: "B", label: "Reflectivity", short: "REF", units: "dBZ", tilts: true },
    { family: "G", label: "Velocity", short: "VEL", units: "kt", tilts: true },
    { family: "S", label: "Storm-Rel Velocity", short: "SRV", units: "kt", tilts: true },
    { family: "C", label: "Correlation Coeff", short: "CC", units: "", tilts: true },
    { family: "X", label: "Diff Reflectivity", short: "ZDR", units: "dB", tilts: true },
    { family: "K", label: "Specific Diff Phase", short: "KDP", units: "°/km", tilts: true },
    { family: "EET", label: "Echo Tops", short: "EET", units: "kft", tilts: false },
    { family: "DVL", label: "Digital VIL", short: "DVL", units: "kg/m²", tilts: false }
  ];
  const TILTS = ["Tilt 1 · 0.5°", "Tilt 2", "Tilt 3", "Tilt 4"];
  let serverProducts = null; // extra products advertised by /api/radar/products
  let serverSites = null;
  const l3Latest = { key: "", time: "", tiles: "", fetchedAt: 0, error: "", for: "" };

  function familyInfo(family) {
    return L3_FAMILIES.find(f => f.family === family) || (serverProducts || []).find(p => p.family === family) || L3_FAMILIES[0];
  }

  function l3Code(family = P.l3.family, tilt = P.l3.tilt) {
    const info = familyInfo(family);
    return info.tilts ? `N${Math.max(0, Math.min(3, Number(tilt) || 0))}${family}` : (info.code || family);
  }

  async function loadServerProducts() {
    if (serverProducts) return serverProducts;
    try {
      const list = listFrom(await getJson(API.radarProducts(), { label: "Radar products" }), ["products"]);
      const known = new Set(L3_FAMILIES.map(f => f.family));
      serverProducts = [];
      list.forEach(item => {
        const code = String(typeof item === "string" ? item : pick(item, ["code", "product", "id", "name"], "")).toUpperCase();
        const label = typeof item === "string" ? item : pick(item, ["label", "title", "description", "name"], code);
        const tilt = code.match(/^N([0-3])([A-Z])$/);
        const family = tilt ? tilt[2] : code;
        if (!family || known.has(family)) return;
        known.add(family);
        serverProducts.push({ family, code, label: String(label), short: code, units: String(pick(item, ["units", "unit"], "")), tilts: !!tilt });
      });
    } catch (error) {
      serverProducts = [];
      console.warn("Radar products list unavailable", error);
    }
    return serverProducts;
  }

  function icaoFor(id) {
    const raw = String(id || "").trim().toUpperCase();
    if (/^[A-Z]{4}$/.test(raw)) return raw;
    if (["GUA", "HKI", "HKM", "HMO", "HWA", "ABC", "ACG", "AEC", "AHG", "AIH", "AKC", "APD"].includes(raw)) return `P${raw}`;
    if (raw === "JUA") return "TJUA";
    return raw ? `K${raw}` : "";
  }

  async function loadSites() {
    if (serverSites) return serverSites;
    try {
      const list = listFrom(await getJson(API.radarSites(), { label: "Radar sites" }), ["sites"]);
      serverSites = list.map(item => {
        const props = item.properties || item;
        const coords = item.geometry?.coordinates;
        return {
          id: icaoFor(pick(props, ["icao", "id", "site", "code", "name"], "")),
          name: String(pick(props, ["name", "city", "location", "description"], "")),
          lat: num(pick(props, ["lat", "latitude"], coords ? coords[1] : null)),
          lon: num(pick(props, ["lon", "lng", "longitude"], coords ? coords[0] : null))
        };
      }).filter(s => s.id && s.lat !== null && s.lon !== null);
    } catch (error) {
      console.warn("Radar site list unavailable, using built-in NEXRAD list", error);
      serverSites = [];
    }
    if (!serverSites.length && typeof RADAR_FALLBACK_SITES !== "undefined") {
      serverSites = RADAR_FALLBACK_SITES.map(([id, lat, lon]) => ({ id: icaoFor(id), name: "", lat, lon }));
    }
    return serverSites;
  }

  function mapCenter() {
    try {
      if (radarMap) { const c = radarMap.getCenter(); return { latitude: c.lat, longitude: c.lng }; }
    } catch (_) {}
    return { latitude: state.location.latitude, longitude: state.location.longitude };
  }

  function sitesByDistance(center = mapCenter()) {
    return (serverSites || []).map(s => Object.assign({ miles: X.haversineMiles([center.longitude, center.latitude], [s.lon, s.lat]) }, s))
      .sort((a, b) => a.miles - b.miles);
  }

  function currentSite() {
    if (P.l3.site) return P.l3.site;
    try { return icaoFor(currentVelocityRadarSite()); } catch (_) { return "KTLX"; }
  }

  function paletteParam() {
    const pal = P.l3.pal && palettes[P.l3.pal];
    return pal ? encodePalette(pal.text) : "";
  }

  async function refreshL3Latest(force) {
    const site = currentSite();
    const code = l3Code();
    const want = `${site}/${code}/${P.l3.pal}`;
    if (!force && l3Latest.for === want && Date.now() - l3Latest.fetchedAt < 120000) return l3Latest;
    l3Latest.for = want;
    l3Latest.fetchedAt = Date.now();
    try {
      const json = await getJson(API.radarLatest(site, code), { label: "Latest radar scan" });
      if (json && json.error) throw new Error(json.error);
      const key = String(pick(json, ["key", "id", "scan_key", "file", "name"], ""));
      const template = pick(json, ["tiles", "tile_url", "tileUrl", "template"], "");
      l3Latest.key = key;
      l3Latest.time = pick(json, ["time", "valid", "valid_time", "validTime", "scan_time", "timestamp", "datetime", "vol_time"], "");
      l3Latest.tiles = Array.isArray(template) ? template[0] : (template || "");
      l3Latest.error = "";
    } catch (error) {
      // /live always serves the newest scan, so the layer still works without /latest metadata.
      l3Latest.key = "";
      l3Latest.time = "";
      l3Latest.tiles = "";
      l3Latest.error = String(error.message || error);
    }
    return l3Latest;
  }

  function withPal(url, pal) {
    if (!pal || /[?&]pal=/.test(url)) return url;
    return `${url}${url.includes("?") ? "&" : "?"}pal=${encodeURIComponent(pal)}`;
  }

  function l3TileTemplate(site = currentSite(), code = l3Code(), pal = paletteParam()) {
    if (l3Latest.for.startsWith(`${site}/${code}/`)) {
      if (l3Latest.tiles) return withPal(absolute(l3Latest.tiles), pal);
      if (l3Latest.key) return API.radarTile(l3Latest.key, pal);
    }
    const bucket = Math.floor(Date.now() / 120000);
    const live = API.radarLive(site, code, pal);
    return `${live}${live.includes("?") ? "&" : "?"}v=${bucket}`;
  }

  function absolute(url) {
    if (/^https?:/i.test(url)) return url;
    return `${API.render}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  /* ---------- Palette import (GR / RadarScope .pal) ---------- */
  function parsePalette(text) {
    const lines = String(text || "").split(/\r?\n/);
    const out = { product: "", units: "", scale: 1, stops: [] };
    lines.forEach(line => {
      const clean = line.replace(/;.*$/, "").trim();
      if (!clean) return;
      const m = clean.match(/^([A-Za-z0-9]+)\s*:\s*(.*)$/);
      if (!m) return;
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === "product") out.product = value;
      else if (key === "units") out.units = value;
      else if (key === "scale") out.scale = Number(value) || 1;
      else if (key === "color" || key === "color4" || key === "solidcolor" || key === "solidcolor4") {
        const parts = value.split(/\s+/).map(Number);
        if (parts.length >= 4 && parts.every(Number.isFinite)) {
          const [v, r, g, b] = parts;
          out.stops.push({ value: v, color: `rgb(${r},${g},${b})` });
        }
      }
    });
    if (out.stops.length < 2) throw new Error("No Color: lines found. Use a GR2/GR Level 3 or RadarScope .pal file.");
    out.stops.sort((a, b) => a.value - b.value);
    return out;
  }

  function encodePalette(text) {
    // The render service takes the palette itself; send the .pal body without comments, base64url encoded.
    const compact = String(text || "").split(/\r?\n/).map(l => l.replace(/;.*$/, "").trim()).filter(Boolean).join("\n");
    try {
      return btoa(unescape(encodeURIComponent(compact))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } catch (_) {
      return "";
    }
  }

  function paletteBar(stops) {
    if (!stops || !stops.length) return "";
    const min = stops[0].value, max = stops[stops.length - 1].value, span = (max - min) || 1;
    const grad = stops.map(s => `${s.color} ${(((s.value - min) / span) * 100).toFixed(1)}%`).join(",");
    return `<div class="wpx-palbar" style="background:linear-gradient(90deg,${grad})"></div><div class="wpx-palscale"><span>${esc(min)}</span><span>${esc(max)}</span></div>`;
  }

  function importPaletteFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        const parsed = parsePalette(text);
        const name = (file.name || "Custom palette").replace(/\.[^.]+$/, "").slice(0, 40);
        const id = `pal_${Date.now().toString(36)}`;
        palettes[id] = { name, text, product: parsed.product, units: parsed.units, stops: parsed.stops.slice(0, 64), family: P.l3.family };
        P.l3.pal = id;
        save();
        say(`Palette “${name}” imported`);
        applyAll(true);
        renderSheet();
      } catch (error) {
        say(error.message || "That palette could not be read.");
      }
    };
    reader.onerror = () => say("That file could not be opened.");
    reader.readAsText(file);
  }

  /* ---------- MRMS ---------- */
  const MRMS_PRODUCTS = [
    { id: "hail", label: "Hail (MESH)", units: "in", windows: [30, 60, 120, 360, 1440] },
    { id: "rotation", label: "Rotation 0–2 km", units: "s⁻¹", windows: [30, 60, 120, 360, 1440] },
    { id: "rotation_mid", label: "Rotation 3–6 km", units: "s⁻¹", windows: [30, 60, 120, 360, 1440] },
    { id: "rain", label: "Rainfall (QPE)", units: "in", windows: [60, 180, 360, 720, 1440] }
  ];
  const mrmsLatest = { key: "", time: "", tiles: "", for: "", fetchedAt: 0, error: "" };
  let mrmsServerLoaded = false;

  async function loadMrmsProducts() {
    if (mrmsServerLoaded) return;
    mrmsServerLoaded = true;
    try {
      const list = listFrom(await getJson(API.mrmsProducts(), { label: "MRMS products" }), ["products"]);
      list.forEach(item => {
        const id = String(typeof item === "string" ? item : pick(item, ["id", "product", "key", "name"], ""));
        const known = MRMS_PRODUCTS.find(p => p.id === id);
        const windows = Array.isArray(item?.windows) ? item.windows : null;
        if (known && windows && windows.length) known.windows = windows;
        if (known && item?.label) known.label = String(item.label);
      });
    } catch (error) { console.warn("MRMS product list unavailable", error); }
  }

  function windowLabel(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return n >= 60 ? `${n / 60}h` : `${n}m`;
  }

  async function refreshMrmsLatest(force) {
    if (!P.mrms.product) return mrmsLatest;
    const want = `${P.mrms.product}/${P.mrms.window}`;
    if (!force && mrmsLatest.for === want && Date.now() - mrmsLatest.fetchedAt < 120000) return mrmsLatest;
    mrmsLatest.for = want;
    mrmsLatest.fetchedAt = Date.now();
    try {
      const json = await getJson(API.mrmsLatest(P.mrms.product, P.mrms.window), { label: "MRMS latest" });
      if (json && json.error) throw new Error(json.error);
      mrmsLatest.key = String(pick(json, ["key", "id", "file", "name"], ""));
      const template = pick(json, ["tiles", "tile_url", "tileUrl", "template"], "");
      mrmsLatest.tiles = Array.isArray(template) ? template[0] : (template || "");
      mrmsLatest.time = pick(json, ["time", "valid", "valid_time", "validTime", "timestamp", "datetime"], "");
      mrmsLatest.error = mrmsLatest.key || mrmsLatest.tiles ? "" : "No MRMS scan is available right now.";
    } catch (error) {
      mrmsLatest.key = "";
      mrmsLatest.tiles = "";
      mrmsLatest.error = String(error.message || error);
    }
    return mrmsLatest;
  }

  function mrmsTemplate() {
    if (mrmsLatest.tiles) return absolute(mrmsLatest.tiles);
    if (mrmsLatest.key) return API.mrmsTile(mrmsLatest.key);
    return "";
  }

  /* ---------- Gas stations + EIA prices ---------- */
  const gas = { features: null, loading: false, error: "", eia: null, status: null, tiles: new Set(), rev: 0 };

  function extractJson(text) {
    const body = String(text || "").trim();
    try { return JSON.parse(body); } catch (_) {}
    const starts = [body.indexOf("["), body.indexOf("{")].filter(i => i >= 0);
    if (!starts.length) throw new Error("No data in gas feed");
    const start = Math.min(...starts);
    const end = Math.max(body.lastIndexOf("]"), body.lastIndexOf("}"));
    return JSON.parse(body.slice(start, end + 1));
  }

  function gasFeatures(json) {
    if (json && json.type === "FeatureCollection") return json.features || [];
    const list = listFrom(json, ["stations", "dots", "d", "s"]);
    return list.map(item => {
      let lat, lon, price, name = "", brand = "", updated = "";
      if (Array.isArray(item)) {
        lat = num(item[0]); lon = num(item[1]); price = num(item[2]);
        name = typeof item[3] === "string" ? item[3] : "";
      } else if (item && typeof item === "object") {
        lat = num(pick(item, ["lat", "latitude", "y", "la"]));
        lon = num(pick(item, ["lon", "lng", "longitude", "x", "lo"]));
        price = num(pick(item, ["price", "regular", "reg", "p", "r", "gas"]));
        name = String(pick(item, ["name", "n", "station", "title"], ""));
        brand = String(pick(item, ["brand", "b"], ""));
        updated = pick(item, ["updated", "time", "t", "ts"], "");
      }
      if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
      return { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { name: name || brand || "Gas station", brand, price, updated: updated ? String(updated) : "" } };
    }).filter(Boolean);
  }

  async function loadGas() {
    if (gas.loading || gas.features) return;
    gas.loading = true;
    gas.error = "";
    try {
      gas.features = gasFeatures(extractJson(await getText(API.gasDots(), { label: "Gas stations" })));
    } catch (error) {
      gas.features = [];
      gas.error = `Gas stations unavailable: ${error.message || error}`;
    }
    gas.rev++;
    gas.loading = false;
    loadGasPrices();
    applyAll();
    if (isSheetOpen() && P.tab === "map") renderSheet();
  }

  async function loadGasTileAroundCenter() {
    if (!P.gas || !radarMap || radarMap.getZoom() < 9) return;
    const c = radarMap.getCenter();
    const key = `${Math.floor(c.lat)}_${Math.floor(c.lng)}`;
    if (gas.tiles.has(key)) return;
    gas.tiles.add(key);
    try {
      const extra = gasFeatures(extractJson(await getText(API.gasTile(Math.floor(c.lat), Math.floor(c.lng)), { label: "Gas tile" })));
      if (extra.length) {
        const seen = new Set((gas.features || []).map(f => f.geometry.coordinates.join(",")));
        gas.features = (gas.features || []).concat(extra.filter(f => !seen.has(f.geometry.coordinates.join(","))));
        gas.rev++;
        applyAll();
      }
    } catch (error) { console.warn("Gas detail tile unavailable", key, error); }
  }

  async function loadGasPrices() {
    if (gas.eia) return;
    gas.eia = { loading: true, rows: [] };
    try {
      const json = await getJson(API.eiaGas(), { label: "EIA gas prices" });
      const rows = json?.response?.data || [];
      const latest = {};
      rows.forEach(row => { if (!latest[row.duoarea]) latest[row.duoarea] = row; });
      gas.eia = { loading: false, rows: Object.values(latest), period: rows[0]?.period || "" };
    } catch (error) {
      gas.eia = { loading: false, rows: [], error: String(error.message || error) };
    }
    try { gas.status = await getJson(API.gasStatus(), { label: "Gas status" }); } catch (_) { gas.status = null; }
    if (isSheetOpen() && P.tab === "map") renderSheet();
  }

  /* ---------- Tornado shelters ---------- */
  const shelters = { features: null, loading: false, error: "", rev: 0 };

  async function loadShelters() {
    if (shelters.loading || shelters.features) return;
    shelters.loading = true;
    try {
      const json = await getJson(API.shelters(), { label: "Tornado shelters" });
      if (json && json.type === "FeatureCollection") shelters.features = json.features || [];
      else {
        shelters.features = listFrom(json, ["shelters"]).map(item => {
          const lat = num(pick(item, ["lat", "latitude"])), lon = num(pick(item, ["lon", "lng", "longitude"]));
          if (lat === null || lon === null) return null;
          return { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: Object.assign({}, item) };
        }).filter(Boolean);
      }
    } catch (error) {
      shelters.features = [];
      shelters.error = `Shelter list unavailable: ${error.message || error}`;
    }
    shelters.rev++;
    shelters.loading = false;
    applyAll();
    if (isSheetOpen() && P.tab === "map") renderSheet();
  }

  /* ---------- Route weather ---------- */
  const route = { from: null, to: null, results: null, geometry: null, loading: false, error: "", depart: 0, fromResults: [], toResults: [], straight: false, rev: 0 };

  async function geocode(query) {
    if (typeof searchLocationsRaw === "function") return searchLocationsRaw(query, 5);
    return [];
  }

  async function runRoute() {
    const from = route.from || { name: state.location.name, latitude: state.location.latitude, longitude: state.location.longitude };
    const to = route.to;
    if (!to) { say("Pick a destination first."); return; }
    route.loading = true;
    route.error = "";
    route.results = null;
    renderSheet();
    try {
      let coords, durationSec;
      route.straight = false;
      try {
        const json = await getJson(API.osrmRoute(from, to), { label: "Route" });
        const best = json?.routes?.[0];
        if (!best) throw new Error("No drivable route found");
        coords = best.geometry.coordinates;
        durationSec = best.duration;
      } catch (routeError) {
        // Routing server down: fall back to the direct line, clearly labeled, at a 55 mph average.
        route.straight = true;
        coords = [[from.longitude, from.latitude], [to.longitude, to.latitude]];
        durationSec = X.haversineMiles(coords[0], coords[1]) / 55 * 3600;
      }
      route.geometry = coords;
      const cum = [0];
      for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + X.haversineMiles(coords[i - 1], coords[i]));
      const total = cum[cum.length - 1] || 0.001;
      const samples = Math.max(2, Math.min(10, Math.ceil(total / 45) + 1));
      const departMs = Date.now() + Number(route.depart || 0) * 3600000;
      const points = [];
      for (let s = 0; s < samples; s++) {
        const target = total * s / (samples - 1);
        let i = cum.findIndex(d => d >= target);
        if (i <= 0) i = Math.max(1, i);
        const seg = cum[i] - cum[i - 1] || 1;
        const t = Math.max(0, Math.min(1, (target - cum[i - 1]) / seg));
        const a = coords[i - 1], b = coords[i] || a;
        points.push({ lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t, miles: target, eta: departMs + durationSec * 1000 * (target / total) });
      }
      route.results = await Promise.all(points.map(routePointWeather));
      route.summary = { miles: total, hours: durationSec / 3600, from: from.name, to: to.name };
    } catch (error) {
      route.error = String(error.message || error);
    }
    route.loading = false;
    route.rev++;
    applyAll();
    fitRoute();
    renderSheet();
  }

  async function routePointWeather(point) {
    const out = Object.assign({}, point, { forecast: null, alerts: [], place: "", error: "" });
    try {
      const meta = await getJson(API.nwsPoint(point.lat, point.lon), { label: "NWS point", headers: X.NWS.headers });
      const rel = meta?.properties?.relativeLocation?.properties;
      out.place = rel ? `${rel.city}, ${rel.state}` : "";
      const hourlyUrl = meta?.properties?.forecastHourly;
      if (hourlyUrl) {
        const hourly = await getJson(hourlyUrl, { label: "NWS hourly", headers: X.NWS.headers });
        const periods = hourly?.properties?.periods || [];
        out.forecast = periods.find(p => new Date(p.startTime).getTime() <= point.eta && new Date(p.endTime).getTime() > point.eta) || periods[0] || null;
      }
    } catch (error) {
      out.error = "No NWS forecast here (outside the US or service busy).";
    }
    try {
      const alerts = await getJson(API.nwsAlertsPoint(point.lat, point.lon), { label: "NWS alerts", headers: X.NWS.headers });
      out.alerts = (alerts?.features || []).map(f => f.properties?.event).filter(Boolean);
    } catch (_) {}
    return out;
  }

  function routeFeatureCollection() {
    if (!route.geometry) return fc([]);
    const features = [{ type: "Feature", geometry: { type: "LineString", coordinates: route.geometry }, properties: { kind: "line" } }];
    (route.results || []).forEach((p, i) => {
      const wet = /rain|storm|shower|snow|sleet|ice|drizzle/i.test(p.forecast?.shortForecast || "");
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { kind: "point", idx: i, color: p.alerts.length ? "#ff4d4d" : wet ? "#4fb3ff" : "#5ee7a0", label: p.forecast ? `${p.forecast.temperature}°` : "" } });
    });
    return fc(features);
  }

  function fitRoute() {
    if (!radarMap || !route.geometry || route.geometry.length < 2) return;
    const lons = route.geometry.map(c => c[0]), lats = route.geometry.map(c => c[1]);
    try { radarMap.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 60, maxZoom: 9, duration: 600 }); } catch (_) {}
  }

  /* ---------- Model Studio ---------- */
  const MODELS = [
    { id: "hrrr", label: "HRRR" },
    { id: "nam", label: "NAM" },
    { id: "gfs", label: "GFS" },
    { id: "ecmwf", label: "ECMWF" }
  ];
  const FALLBACK_FIELDS = [
    { id: "refc", label: "Composite reflectivity" },
    { id: "t2m", label: "2 m temperature" },
    { id: "d2m", label: "2 m dew point" },
    { id: "gust", label: "Wind gust" },
    { id: "cape", label: "CAPE" },
    { id: "apcp", label: "Total precipitation" }
  ];
  const studio = { runs: {}, hours: {}, fields: {}, frame: null, loading: false, error: "", playing: false, timer: 0, probe: null };

  function runId(item) {
    return String(typeof item === "string" || typeof item === "number" ? item : pick(item, ["run", "id", "init", "cycle", "name", "time"], ""));
  }

  function fieldsFrom(json) {
    const raw = json && !Array.isArray(json) ? pick(json, ["fields", "params", "parameters", "variables", "products", "layers"], null) : null;
    if (!Array.isArray(raw) || !raw.length) return null;
    return raw.map(f => typeof f === "string" ? { id: f, label: f } : { id: String(pick(f, ["id", "key", "name", "field"], "")), label: String(pick(f, ["label", "title", "name", "id"], "")) }).filter(f => f.id);
  }

  async function loadRuns(model = P.model.model) {
    if (studio.runs[model]) return studio.runs[model];
    studio.loading = true;
    studio.error = "";
    try {
      const json = await getJson(API.modelRuns(model), { label: "Model runs" });
      const runs = listFrom(json, ["runs", "cycles"]).map(item => ({ id: runId(item), raw: item })).filter(r => r.id);
      studio.runs[model] = runs;
      studio.fields[model] = fieldsFrom(json) || fieldsFrom(runs[0]?.raw) || FALLBACK_FIELDS;
      if (!runs.length) studio.error = `No ${model.toUpperCase()} runs are published yet.`;
    } catch (error) {
      studio.runs[model] = [];
      studio.fields[model] = FALLBACK_FIELDS;
      studio.error = `Model runs unavailable: ${error.message || error}`;
    }
    studio.loading = false;
    if (!studio.runs[model].some(r => r.id === P.model.run)) P.model.run = studio.runs[model][0]?.id || "";
    if (!studio.fields[model].some(f => f.id === P.model.field)) P.model.field = studio.fields[model][0]?.id || "";
    save();
    return studio.runs[model];
  }

  async function loadHours() {
    const model = P.model.model, run = P.model.run;
    if (!run) return [];
    const key = `${model}/${run}`;
    if (studio.hours[key]) return studio.hours[key];
    let hours = null;
    const runInfo = (studio.runs[model] || []).find(r => r.id === run)?.raw;
    if (runInfo && Array.isArray(runInfo.hours)) hours = runInfo.hours;
    if (!hours) {
      try {
        const json = await getJson(API.modelHours(model, run), { label: "Model hours" });
        hours = listFrom(json, ["hours", "fhrs", "forecast_hours"]);
        const fields = fieldsFrom(json);
        if (fields) studio.fields[model] = fields;
      } catch (error) {
        studio.error = `Forecast hours unavailable: ${error.message || error}`;
        hours = [];
      }
    }
    studio.hours[key] = hours.map(h => Number(typeof h === "object" ? pick(h, ["fhr", "hour", "h"], 0) : h)).filter(Number.isFinite).sort((a, b) => a - b);
    if (!studio.hours[key].includes(Number(P.model.fhr))) P.model.fhr = studio.hours[key][0] ?? 0;
    return studio.hours[key];
  }

  async function fetchFrameSpec(model, run, field, fhr) {
    const url = API.modelFrame(model, run, field, fhr);
    try {
      const json = await getJson(url, { label: "Model frame" });
      const template = pick(json, ["tiles", "tile_url", "tileUrl", "template"], "");
      const image = pick(json, ["image", "url", "png", "src"], "");
      const bounds = pick(json, ["bounds", "bbox", "extent"], null);
      const valid = pick(json, ["valid", "valid_time", "validTime", "time"], "");
      if (template) return { kind: "tiles", url: absolute(Array.isArray(template) ? template[0] : template), valid };
      if (image && normalizeBounds(bounds)) return { kind: "image", url: absolute(image), bounds: normalizeBounds(bounds), valid };
    } catch (_) {
      // Not JSON: the frame endpoint serves imagery directly.
    }
    return { kind: "tiles", url: `${url}/{z}/{x}/{y}.png`, valid: "" };
  }

  async function loadFrame() {
    const { model, run, field, fhr } = P.model;
    if (!run || !field) return;
    const want = `${model}/${run}/${field}/${fhr}`;
    studio.frameFor = want;
    const frame = await fetchFrameSpec(model, run, field, fhr);
    if (studio.frameFor !== want) return;
    studio.frame = frame;
    applyAll();
    syncStudioChrome();
  }

  function normalizeBounds(b) {
    if (Array.isArray(b) && b.length === 4 && b.every(v => Number.isFinite(Number(v)))) {
      const [w, s, e, n] = b.map(Number);
      return [[w, n], [e, n], [e, s], [w, s]];
    }
    if (b && typeof b === "object") {
      const w = num(pick(b, ["west", "minx", "xmin", "left"])), s = num(pick(b, ["south", "miny", "ymin", "bottom"]));
      const e = num(pick(b, ["east", "maxx", "xmax", "right"])), n = num(pick(b, ["north", "maxy", "ymax", "top"]));
      if ([w, s, e, n].every(v => v !== null)) return [[w, n], [e, n], [e, s], [w, s]];
    }
    return null;
  }

  function stepModel(delta) {
    const hours = studio.hours[`${P.model.model}/${P.model.run}`] || [];
    if (!hours.length) return;
    let i = hours.indexOf(Number(P.model.fhr));
    i = (i + delta + hours.length) % hours.length;
    P.model.fhr = hours[i];
    save();
    loadFrame();
  }

  function setStudioPlaying(play) {
    studio.playing = !!play;
    clearInterval(studio.timer);
    if (studio.playing) studio.timer = setInterval(() => stepModel(1), 1200);
    syncStudioChrome();
  }

  function syncStudioChrome() {
    const label = document.getElementById("wpxModelHour");
    if (label) label.textContent = `F${String(P.model.fhr).padStart(2, "0")}${studio.frame?.valid ? ` · valid ${timeLabel(studio.frame.valid)}` : ""}`;
    const slider = document.getElementById("wpxModelSlider");
    const hours = studio.hours[`${P.model.model}/${P.model.run}`] || [];
    if (slider) slider.value = String(Math.max(0, hours.indexOf(Number(P.model.fhr))));
    const play = document.querySelector('[data-wpx="studioPlay"]');
    if (play) play.textContent = studio.playing ? "Pause" : "Play";
  }

  async function openStudio() {
    P.model.on = true;
    save();
    await loadRuns();
    await loadHours();
    renderSheet();
    loadFrame();
  }

  /* ---------- Soundings ---------- */
  let soundingArmed = false;

  function openSounding(lat, lon) {
    soundingArmed = false;
    const body = X.openOverlay({ id: "sounding", title: `Sounding · ${lat.toFixed(2)}, ${lon.toFixed(2)}`, className: "wpx-sounding" });
    const s = { fhr: 0, data: null, error: "" };
    const draw = () => {
      const rows = soundingRows(s.data, s.fhr);
      body.innerHTML = `
        <div class="wpx-card">
          <div class="wpx-row"><strong>HRRR forecast hour</strong><span id="wpxSndHour">F${String(s.fhr).padStart(2, "0")}</span></div>
          <input type="range" min="0" max="18" value="${s.fhr}" id="wpxSndSlider" aria-label="Forecast hour">
          <div class="wpx-btnrow"><button class="wpx-btn" data-wpx="sndStep" data-d="-1">‹ Hour</button><button class="wpx-btn" data-wpx="sndStep" data-d="1">Hour ›</button></div>
        </div>
        <div class="wpx-card wpx-snd-img"><img alt="Skew-T sounding" src="${escA(API.soundingImage(lat.toFixed(3), lon.toFixed(3), s.fhr))}" onerror="this.replaceWith(Object.assign(document.createElement('p'),{className:'wpx-note',textContent:'Sounding image is not available for this point/hour.'}))"></div>
        <div class="wpx-card"><h3>Parameters</h3>${s.error ? `<p class="wpx-note">${esc(s.error)}</p>` : !s.data ? `<p class="wpx-note">Loading sounding data…</p>` : rows.length ? `<div class="wpx-kv">${rows.map(([k, v]) => `<div><small>${esc(k)}</small><strong>${esc(v)}</strong></div>`).join("")}</div>` : `<p class="wpx-note">No parameter values were returned for this hour.</p>`}</div>`;
    };
    X.actions.sndStep = el => { s.fhr = Math.max(0, Math.min(18, s.fhr + Number(el.dataset.d))); draw(); };
    body.addEventListener("change", e => { if (e.target.id === "wpxSndSlider") { s.fhr = Number(e.target.value); draw(); } });
    draw();
    getJson(API.soundingJson(lat.toFixed(3), lon.toFixed(3), "hrrr", 19), { label: "Sounding", timeoutMs: 25000 })
      .then(json => { s.data = json; draw(); })
      .catch(error => { s.error = `Sounding data unavailable: ${error.message || error}`; draw(); });
  }

  const SND_LABELS = { sbcape: "SBCAPE", mlcape: "MLCAPE", mucape: "MUCAPE", sbcin: "SBCIN", mlcin: "MLCIN", cape: "CAPE", cin: "CIN", lcl: "LCL", lfc: "LFC", el: "EL", srh01: "0–1 km SRH", srh03: "0–3 km SRH", shear06: "0–6 km shear", bwd06: "0–6 km shear", pwat: "PWAT", li: "Lifted index", stp: "STP", scp: "SCP", lr75: "700–500 lapse", lapse: "Lapse rate", t2m: "Temp", td2m: "Dew point", temp: "Temp", dewp: "Dew point" };

  function soundingRows(data, fhr) {
    if (!data) return [];
    let hour = data;
    const list = listFrom(data, ["hours", "forecast", "profiles", "soundings", "data"]);
    if (list.length && typeof list[0] === "object") {
      hour = list.find(h => Number(pick(h, ["fhr", "hour", "f", "h"], -1)) === Number(fhr)) || list[Math.min(list.length - 1, fhr)] || list[0];
    }
    const params = hour.params || hour.indices || hour.parameters || hour;
    const rows = [];
    Object.entries(params || {}).forEach(([k, v]) => {
      if (typeof v === "number" && Number.isFinite(v)) rows.push([SND_LABELS[k.toLowerCase()] || k, Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10]);
      else if (v && typeof v === "object" && Number.isFinite(v.value)) rows.push([SND_LABELS[k.toLowerCase()] || k, `${Math.round(v.value * 10) / 10}${v.units ? ` ${v.units}` : ""}`]);
    });
    return rows.filter(([k]) => !/^(lat|lon|fhr|hour|f|h)$/i.test(k)).slice(0, 24);
  }

  /* ---------- Map layers ---------- */
  function applyAll(forceLatest) {
    const map = radarMap;
    if (!X.mapReady(map)) return;
    bindMap(map);
    const before = typeof rasterLayerBeforeId === "function" ? rasterLayerBeforeId("wp-nexrad-layer") : undefined;

    // Level III site product replaces the mosaic while on.
    if (P.l3.on) {
      if (forceLatest || !l3Latest.for.startsWith(`${currentSite()}/${l3Code()}/`)) {
        refreshL3Latest(forceLatest).then(() => { setL3(map, before); syncSheetStatus(); });
      }
      setL3(map, before);
      try { if (map.getLayer("wp-nexrad-layer")) map.setLayoutProperty("wp-nexrad-layer", "visibility", "none"); } catch (_) {}
    } else {
      X.removeLayerAndSource(map, "wpx-l3");
      try { if (map.getLayer("wp-nexrad-layer")) map.setLayoutProperty("wp-nexrad-layer", "visibility", "visible"); } catch (_) {}
    }

    if (P.mrms.product) {
      if (forceLatest || mrmsLatest.for !== `${P.mrms.product}/${P.mrms.window}`) refreshMrmsLatest(forceLatest).then(() => { setMrms(map, before); syncSheetStatus(); });
      setMrms(map, before);
    } else X.removeLayerAndSource(map, "wpx-mrms");

    if (P.model.on && studio.frame) setModelFrame(map, before);
    else X.removeLayerAndSource(map, "wpx-model");

    setPoints(map, "wpx-gas", P.gas ? fc(gas.features || []) : fc([]), "#ffb020", `${P.gas}:${gas.rev}`);
    setPoints(map, "wpx-shelters", P.shelters ? fc(shelters.features || []) : fc([]), "#b56cff", `${P.shelters}:${shelters.rev}`);
    setRoute(map);
  }

  function setL3(map, before) {
    if (!P.l3.on) return;
    X.setRaster(map, "wpx-l3", [l3TileTemplate()], { opacity: P.l3.opacity, beforeId: before, maxzoom: 14, attribution: "NEXRAD Level III: NOAA/NWS · WeatherPower render" });
  }

  function setMrms(map, before) {
    const tiles = mrmsTemplate();
    if (!tiles) { X.removeLayerAndSource(map, "wpx-mrms"); return; }
    X.setRaster(map, "wpx-mrms", [tiles], { opacity: P.mrms.opacity, beforeId: before, maxzoom: 12, attribution: "MRMS: NOAA/NSSL" });
  }

  function setModelFrame(map, before) {
    drawFrame(map, studio.frame, P.model.opacity, before);
  }

  function drawFrame(map, f, opacity, before) {
    if (!f) return;
    if (f.kind === "tiles") {
      X.removeLayerAndSource(map, "wpx-model-img");
      X.setRaster(map, "wpx-model", [f.url], { opacity, beforeId: before, resampling: "linear", attribution: "Model data: NOAA/NCEP · ECMWF open data" });
    } else if (f.kind === "image" && f.bounds) {
      X.removeLayerAndSource(map, "wpx-model");
      const src = map.getSource("wpx-model-img");
      try {
        if (src && src.updateImage) src.updateImage({ url: f.url, coordinates: f.bounds });
        else {
          map.addSource("wpx-model-img", { type: "image", url: f.url, coordinates: f.bounds });
          map.addLayer({ id: "wpx-model-img-layer", type: "raster", source: "wpx-model-img", paint: { "raster-opacity": opacity, "raster-fade-duration": 0 } }, before && map.getLayer(before) ? before : undefined);
        }
      } catch (error) { console.warn("Model image frame failed", error); }
    }
  }

  function setPoints(map, id, data, color, changeKey) {
    const had = !!map.getSource(id);
    X.setGeoJson(map, id, data, changeKey);
    if (!had && map.getSource(id)) {
      X.addLayerOnce(map, { id: `${id}-dot`, type: "circle", source: id, paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 2.5, 10, 6, 14, 9],
        "circle-color": id === "wpx-gas" ? ["case", ["has", "price"], ["interpolate", ["linear"], ["to-number", ["get", "price"], 0], 2.5, "#3ddc84", 3.25, "#ffd84d", 4, "#ff8a3d", 5, "#ff3b3b"], color] : color,
        "circle-stroke-color": "#08101f", "circle-stroke-width": 1.2
      } });
      if (id === "wpx-gas") X.addLayerOnce(map, { id: `${id}-label`, type: "symbol", source: id, minzoom: 10, filter: ["has", "price"], layout: { "text-field": ["number-format", ["to-number", ["get", "price"]], { "min-fraction-digits": 2, "max-fraction-digits": 2 }], "text-size": 11, "text-offset": [0, 1.2], "text-allow-overlap": false }, paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.2 } });
    }
  }

  function setRoute(map) {
    const had = !!map.getSource("wpx-route");
    X.setGeoJson(map, "wpx-route", routeFeatureCollection(), `route:${route.rev}`);
    if (!had && map.getSource("wpx-route")) {
      X.addLayerOnce(map, { id: "wpx-route-line", type: "line", source: "wpx-route", filter: ["==", ["get", "kind"], "line"], paint: { "line-color": "#52e0fa", "line-width": 4, "line-opacity": 0.85 } });
      X.addLayerOnce(map, { id: "wpx-route-pt", type: "circle", source: "wpx-route", filter: ["==", ["get", "kind"], "point"], paint: { "circle-radius": 8, "circle-color": ["get", "color"], "circle-stroke-color": "#08101f", "circle-stroke-width": 2 } });
      X.addLayerOnce(map, { id: "wpx-route-lbl", type: "symbol", source: "wpx-route", filter: ["==", ["get", "kind"], "point"], layout: { "text-field": ["get", "label"], "text-size": 12, "text-offset": [0, -1.5] }, paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.4 } });
    }
  }

  function bindMap(map) {
    if (map.__wpxBound) return;
    map.__wpxBound = true;
    map.on("click", event => onMapClick(map, event));
    map.on("moveend", () => { if (P.gas) loadGasTileAroundCenter(); });
    map.on("styledata", () => { if (!map.getSource("wpx-route") && X.mapReady(map)) setTimeout(() => applyAll(), 0); });
  }

  function popup(map, lngLat, html) {
    try {
      if (window.__wpxPopup) window.__wpxPopup.remove();
      window.__wpxPopup = new maplibregl.Popup({ closeButton: true, maxWidth: "280px", className: "wpx-popup" }).setLngLat(lngLat).setHTML(html).addTo(map);
    } catch (error) { console.warn(error); }
  }

  async function onMapClick(map, event) {
    const { lng, lat } = event.lngLat;
    if (soundingArmed) {
      soundingArmed = false;
      syncSheetStatus();
      openSounding(lat, lng);
      return;
    }
    const hits = map.queryRenderedFeatures(event.point, { layers: ["wpx-gas-dot", "wpx-shelters-dot", "wpx-route-pt"].filter(id => map.getLayer(id)) });
    const hit = hits[0];
    if (hit) {
      const p = hit.properties || {};
      if (hit.layer.id === "wpx-gas-dot") {
        popup(map, event.lngLat, `<strong>${esc(p.name || "Gas station")}</strong>${p.brand && p.brand !== p.name ? `<br><small>${esc(p.brand)}</small>` : ""}<br>${p.price ? `Regular: <b>$${Number(p.price).toFixed(2)}</b>` : "No price reported"}${p.updated ? `<br><small>Updated ${esc(timeLabel(p.updated))}</small>` : ""}`);
      } else if (hit.layer.id === "wpx-shelters-dot") {
        const name = p.name || p.NAME || p.title || "Tornado shelter";
        const addr = p.address || p.ADDRESS || p.addr || "";
        const detail = p.type || p.capacity || p.notes || p.description || "";
        popup(map, event.lngLat, `<strong>${esc(name)}</strong>${addr ? `<br>${esc(addr)}` : ""}${detail ? `<br><small>${esc(detail)}</small>` : ""}<br><small>Confirm access with local officials before storms.</small>`);
      } else if (hit.layer.id === "wpx-route-pt") {
        const r = (route.results || [])[Number(p.idx)];
        if (r) popup(map, event.lngLat, routePointHtml(r));
      }
      return;
    }
    if (P.mrms.product && mrmsLatest.key) {
      try {
        const json = await getJson(API.mrmsValue(mrmsLatest.key, lat.toFixed(4), lng.toFixed(4)), { label: "MRMS value" });
        const value = pick(json, ["value", "v", "val"], null);
        const units = pick(json, ["units", "unit"], (MRMS_PRODUCTS.find(p => p.id === P.mrms.product) || {}).units || "");
        popup(map, event.lngLat, `<strong>${esc((MRMS_PRODUCTS.find(p => p.id === P.mrms.product) || {}).label || "MRMS")}</strong><br>${value === null || value === undefined ? "No value at this point" : `${esc(typeof value === "number" ? Math.round(value * 100) / 100 : value)} ${esc(units)}`}`);
      } catch (error) { console.warn("MRMS probe failed", error); }
      return;
    }
    if (P.model.on && P.model.run && P.model.field) {
      try {
        const json = await getJson(API.modelProbe(P.model.model, P.model.run, P.model.field, P.model.fhr, lat.toFixed(4), lng.toFixed(4)), { label: "Model probe" });
        const value = pick(json, ["value", "v", "val"], null);
        const units = pick(json, ["units", "unit"], "");
        if (value !== null) popup(map, event.lngLat, `<strong>${esc(P.model.model.toUpperCase())} ${esc(fieldLabel())}</strong><br>F${esc(P.model.fhr)}: <b>${esc(typeof value === "number" ? Math.round(value * 10) / 10 : value)} ${esc(units)}</b>`);
      } catch (error) { console.warn("Model probe failed", error); }
    }
  }

  function fieldLabel() {
    return ((studio.fields[P.model.model] || FALLBACK_FIELDS).find(f => f.id === P.model.field) || {}).label || P.model.field;
  }

  function routePointHtml(r) {
    const f = r.forecast;
    return `<strong>${esc(r.place || `Mile ${Math.round(r.miles)}`)}</strong><br><small>Arrive ~${esc(new Date(r.eta).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))} · mile ${Math.round(r.miles)}</small><br>${f ? `${esc(f.temperature)}°${esc(f.temperatureUnit || "F")} · ${esc(f.shortForecast)}<br><small>Wind ${esc(f.windSpeed || "--")} ${esc(f.windDirection || "")}${f.probabilityOfPrecipitation?.value != null ? ` · ${esc(f.probabilityOfPrecipitation.value)}% precip` : ""}</small>` : `<small>${esc(r.error || "No forecast")}</small>`}${r.alerts.length ? `<br><b style="color:#ff6b6b">${esc(r.alerts.join(", "))}</b>` : ""}`;
  }

  /* ---------- Sheet UI ---------- */
  const TABS = [["radar", "Radar"], ["mrms", "MRMS"], ["map", "Map"], ["route", "Route"], ["sounding", "Sounding"], ["models", "Models"]];

  function isSheetOpen() { return !!document.getElementById("wpxRadarSheet"); }

  function openSheet(tab) {
    if (tab) P.tab = tab;
    save();
    if (!isSheetOpen()) {
      const el = document.createElement("div");
      el.id = "wpxRadarSheet";
      el.className = "wpx-sheet";
      document.body.appendChild(el);
      el.addEventListener("change", onSheetChange);
      el.addEventListener("input", onSheetInput);
    }
    loadSites().then(() => { if (P.tab === "radar") renderSheet(); });
    loadServerProducts().then(() => { if (P.tab === "radar") renderSheet(); });
    loadMrmsProducts();
    renderSheet();
  }

  function closeSheet() {
    document.getElementById("wpxRadarSheet")?.remove();
    soundingArmed = false;
    setStudioPlaying(false);
  }
  X.backHandlers.push(() => {
    if (X.topOverlay()) return false;
    if (isSheetOpen()) { closeSheet(); return true; }
    return false;
  });

  function chip(action, label, active, extra = "") {
    return `<button class="wpx-chip${active ? " active" : ""}" data-wpx="${action}" ${extra}>${esc(label)}</button>`;
  }

  function renderSheet() {
    const el = document.getElementById("wpxRadarSheet");
    if (!el) return;
    const scroll = el.querySelector(".wpx-sheet-body")?.scrollTop || 0;
    el.innerHTML = `<div class="wpx-sheet-head"><strong>Radar 3.1</strong><div class="wpx-tabs">${TABS.map(([id, label]) => chip("sheetTab", label, P.tab === id, `data-tab="${id}"`)).join("")}</div><button class="wpx-icon-btn" data-wpx="closeSheet" aria-label="Close">×</button></div><div class="wpx-sheet-body">${sheetBody()}</div>`;
    el.querySelector(".wpx-sheet-body").scrollTop = scroll;
  }

  function sheetBody() {
    if (P.tab === "mrms") return mrmsBody();
    if (P.tab === "map") return mapBody();
    if (P.tab === "route") return routeBody();
    if (P.tab === "sounding") return soundingBody();
    if (P.tab === "models") return modelsBody();
    return radarBody();
  }

  function statusLine() {
    if (!P.l3.on) return `<p class="wpx-note">Level III site mode is off; the main radar mosaic is showing.</p>`;
    const code = l3Code();
    const time = l3Latest.for.startsWith(`${currentSite()}/${code}/`) && l3Latest.time ? `scan ${timeLabel(l3Latest.time)}` : "latest scan";
    return `<p class="wpx-note" id="wpxL3Status">${esc(currentSite())} ${esc(code)} · ${esc(time)}${l3Latest.error ? " · live tiles" : ""}</p>`;
  }

  function radarBody() {
    const families = L3_FAMILIES.concat(serverProducts || []);
    const info = familyInfo(P.l3.family);
    const sites = sitesByDistance();
    const site = currentSite();
    const pals = Object.entries(palettes);
    const pal = P.l3.pal && palettes[P.l3.pal];
    return `
      <div class="wpx-row"><strong>Level III site radar</strong><label class="wpx-switch"><input type="checkbox" id="wpxL3On"${P.l3.on ? " checked" : ""}><span></span></label></div>
      ${statusLine()}
      <div class="wpx-label">Radar site</div>
      <div class="wpx-inline">
        <select id="wpxSite" aria-label="Radar site">${(sites.length ? sites : [{ id: site, name: "", miles: 0 }]).slice(0, 160).map(s => `<option value="${escA(s.id)}"${s.id === site ? " selected" : ""}>${esc(s.id)}${s.name ? ` · ${esc(s.name)}` : ""}${Number.isFinite(s.miles) && s.miles ? ` · ${Math.round(s.miles)} mi` : ""}</option>`).join("")}</select>
        <button class="wpx-btn" data-wpx="nearestSite">Nearest</button>
      </div>
      <div class="wpx-label">Product</div>
      <div class="wpx-chips">${families.map(f => chip("l3Family", f.short, P.l3.family === f.family, `data-family="${escA(f.family)}" title="${escA(f.label)}"`)).join("")}</div>
      <p class="wpx-note">${esc(info.label)}${info.units ? ` (${esc(info.units)})` : ""}</p>
      <div class="wpx-label">Tilt</div>
      <div class="wpx-chips">${TILTS.map((label, i) => `<button class="wpx-chip${Number(P.l3.tilt) === i ? " active" : ""}" data-wpx="l3Tilt" data-tilt="${i}"${info.tilts ? "" : " disabled"}>${esc(label)}</button>`).join("")}</div>
      <div class="wpx-label">Opacity <span id="wpxL3OpacityValue">${Math.round(P.l3.opacity * 100)}%</span></div>
      <input type="range" id="wpxL3Opacity" min="20" max="100" value="${Math.round(P.l3.opacity * 100)}" aria-label="Level III opacity">
      <div class="wpx-label">Color palette</div>
      <div class="wpx-inline">
        <select id="wpxPal" aria-label="Palette"><option value="">WeatherPower default</option>${pals.map(([id, p]) => `<option value="${escA(id)}"${P.l3.pal === id ? " selected" : ""}>${esc(p.name)}${p.product ? ` (${esc(p.product)})` : ""}</option>`).join("")}</select>
        <label class="wpx-btn wpx-file">Import .pal<input type="file" id="wpxPalFile" accept=".pal,.txt,text/plain,application/octet-stream"></label>
      </div>
      ${pal ? `${paletteBar(pal.stops)}<div class="wpx-btnrow"><button class="wpx-btn subtle" data-wpx="deletePal">Remove “${esc(pal.name)}”</button></div>` : `<p class="wpx-note">Import a GR2Analyst / GR Level 3 or RadarScope .pal file to recolor site products.</p>`}`;
  }

  function mrmsBody() {
    const product = MRMS_PRODUCTS.find(p => p.id === P.mrms.product);
    const status = !product ? "Off" : mrmsLatest.error ? mrmsLatest.error : mrmsLatest.time ? `Valid ${timeLabel(mrmsLatest.time)}` : "Loading latest…";
    return `
      <div class="wpx-label">MRMS layer</div>
      <div class="wpx-chips">${chip("mrmsProduct", "Off", !P.mrms.product, 'data-id=""')}${MRMS_PRODUCTS.map(p => chip("mrmsProduct", p.label, P.mrms.product === p.id, `data-id="${p.id}"`)).join("")}</div>
      ${product ? `<div class="wpx-label">Accumulation window</div><div class="wpx-chips">${product.windows.map(w => chip("mrmsWindow", windowLabel(w), String(P.mrms.window) === String(w), `data-w="${escA(w)}"`)).join("")}</div>
      <div class="wpx-label">Opacity</div><input type="range" id="wpxMrmsOpacity" min="20" max="100" value="${Math.round(P.mrms.opacity * 100)}" aria-label="MRMS opacity">` : ""}
      <p class="wpx-note" id="wpxMrmsStatus">${esc(status)}</p>
      <p class="wpx-note">Tap the map to read the MRMS value at a point. Data: NOAA/NSSL Multi-Radar Multi-Sensor.</p>`;
  }

  function mapBody() {
    const eia = gas.eia;
    const areaNames = { NUS: "U.S. average", R10: "East Coast", R20: "Midwest", R30: "Gulf Coast", R40: "Rocky Mountain", R50: "West Coast" };
    return `
      <div class="wpx-row"><div><strong>Gas stations</strong><small>Station prices from WeatherPower + EIA averages</small></div><label class="wpx-switch"><input type="checkbox" id="wpxGasOn"${P.gas ? " checked" : ""}><span></span></label></div>
      ${P.gas ? `${gas.loading ? `<p class="wpx-note">Loading stations…</p>` : gas.error ? `<p class="wpx-note">${esc(gas.error)}</p>` : `<p class="wpx-note">${(gas.features || []).length.toLocaleString()} stations · zoom in past 9 for more detail</p>`}
      ${eia ? eia.loading ? `<p class="wpx-note">Loading EIA prices…</p>` : eia.rows.length ? `<div class="wpx-kv">${eia.rows.map(r => `<div><small>${esc(areaNames[r.duoarea] || r["area-name"] || r.duoarea)}</small><strong>$${Number(r.value).toFixed(3)}</strong></div>`).join("")}</div><p class="wpx-note">EIA weekly regular gasoline, week of ${esc(eia.period)}.</p>` : `<p class="wpx-note">EIA prices unavailable${eia.error ? `: ${esc(eia.error)}` : ""}.</p>` : ""}` : ""}
      <div class="wpx-row"><div><strong>Tornado shelters</strong><small>Public shelter locations</small></div><label class="wpx-switch"><input type="checkbox" id="wpxShelterOn"${P.shelters ? " checked" : ""}><span></span></label></div>
      ${P.shelters ? shelters.loading ? `<p class="wpx-note">Loading shelters…</p>` : shelters.error ? `<p class="wpx-note">${esc(shelters.error)}</p>` : `<p class="wpx-note">${(shelters.features || []).length.toLocaleString()} shelters on the map. Always confirm a shelter is open before severe weather.</p>` : ""}`;
  }

  function routeBody() {
    const from = route.from || { name: `${state.location.name} (current)` };
    return `
      <div class="wpx-label">From</div>
      <div class="wpx-inline"><input type="search" id="wpxRouteFrom" placeholder="${escA(from.name)}" aria-label="Start"><button class="wpx-btn" data-wpx="routeFromHere">Here</button></div>
      ${route.fromResults.length ? `<div class="wpx-results">${route.fromResults.map((r, i) => `<button class="wpx-result" data-wpx="routePick" data-which="from" data-i="${i}">${esc(r.name)}<small>${esc(r.subtitle || "")}</small></button>`).join("")}</div>` : `<p class="wpx-note">${esc(from.name)}</p>`}
      <div class="wpx-label">To</div>
      <input type="search" id="wpxRouteTo" placeholder="${escA(route.to ? route.to.name : "City, state, or ZIP")}" aria-label="Destination">
      ${route.toResults.length ? `<div class="wpx-results">${route.toResults.map((r, i) => `<button class="wpx-result" data-wpx="routePick" data-which="to" data-i="${i}">${esc(r.name)}<small>${esc(r.subtitle || "")}</small></button>`).join("")}</div>` : route.to ? `<p class="wpx-note">${esc(route.to.name)}${route.to.subtitle ? `, ${esc(route.to.subtitle)}` : ""}</p>` : ""}
      <div class="wpx-label">Leave</div>
      <div class="wpx-chips">${[[0, "Now"], [1, "+1 h"], [2, "+2 h"], [4, "+4 h"], [8, "+8 h"]].map(([h, l]) => chip("routeDepart", l, Number(route.depart) === h, `data-h="${h}"`)).join("")}</div>
      <div class="wpx-btnrow"><button class="wpx-btn primary" data-wpx="routeGo"${route.loading ? " disabled" : ""}>${route.loading ? "Checking route…" : "Get route weather"}</button>${route.geometry ? `<button class="wpx-btn subtle" data-wpx="routeClear">Clear</button>` : ""}</div>
      ${route.error ? `<p class="wpx-note">${esc(route.error)}</p>` : ""}
      ${route.summary ? `<p class="wpx-note">${Math.round(route.summary.miles)} mi · about ${route.summary.hours.toFixed(1)} h${route.straight ? " · routing unavailable, showing direct line" : ""}. Forecasts: NWS hourly at your estimated arrival time.</p>` : ""}
      ${(route.results || []).map(r => `<div class="wpx-route-stop${r.alerts.length ? " alert" : ""}">${routePointHtml(r)}</div>`).join("")}`;
  }

  function soundingBody() {
    return `
      <p class="wpx-note">Point soundings use the HRRR (0–18 h) from the WeatherPower sounding service.</p>
      <div class="wpx-btnrow"><button class="wpx-btn primary" data-wpx="armSounding">${soundingArmed ? "Tap the map now…" : "Tap map for a sounding"}</button><button class="wpx-btn" data-wpx="soundingHere">At ${esc(state.location.name)}</button></div>`;
  }

  function modelsBody() {
    const runs = studio.runs[P.model.model] || [];
    const fields = studio.fields[P.model.model] || FALLBACK_FIELDS;
    const hours = studio.hours[`${P.model.model}/${P.model.run}`] || [];
    if (!P.model.on) return `<p class="wpx-note">Model Studio draws HRRR, NAM, GFS and ECMWF forecast fields on this map, with hour-by-hour playback and tap-to-probe values.</p><div class="wpx-btnrow"><button class="wpx-btn primary" data-wpx="studioOpen">Open Model Studio</button></div>`;
    return `
      <div class="wpx-chips">${MODELS.map(m => chip("studioModel", m.label, P.model.model === m.id, `data-id="${m.id}"`)).join("")}</div>
      ${studio.loading ? `<p class="wpx-note">Loading runs…</p>` : ""}
      ${studio.error ? `<p class="wpx-note">${esc(studio.error)}</p>` : ""}
      <div class="wpx-inline">
        <select id="wpxRun" aria-label="Model run">${runs.map(r => `<option value="${escA(r.id)}"${r.id === P.model.run ? " selected" : ""}>${esc(timeLabel(r.id) || r.id)} run</option>`).join("") || `<option>No runs</option>`}</select>
        <select id="wpxField" aria-label="Model field">${fields.map(f => `<option value="${escA(f.id)}"${f.id === P.model.field ? " selected" : ""}>${esc(f.label)}</option>`).join("")}</select>
      </div>
      <div class="wpx-row"><strong id="wpxModelHour">F${String(P.model.fhr).padStart(2, "0")}</strong><span class="wpx-note">${hours.length ? `${hours.length} hours` : ""}</span></div>
      <input type="range" id="wpxModelSlider" min="0" max="${Math.max(0, hours.length - 1)}" value="${Math.max(0, hours.indexOf(Number(P.model.fhr)))}" aria-label="Forecast hour"${hours.length ? "" : " disabled"}>
      <div class="wpx-btnrow"><button class="wpx-btn" data-wpx="studioStep" data-d="-1">‹</button><button class="wpx-btn primary" data-wpx="studioPlay">${studio.playing ? "Pause" : "Play"}</button><button class="wpx-btn" data-wpx="studioStep" data-d="1">›</button><button class="wpx-btn subtle" data-wpx="studioClose">Hide</button></div>
      <div class="wpx-label">Opacity</div><input type="range" id="wpxModelOpacity" min="20" max="100" value="${Math.round(P.model.opacity * 100)}" aria-label="Model opacity">
      <p class="wpx-note">Tap the map to probe the value at a point.</p>`;
  }

  function syncSheetStatus() {
    const l3 = document.getElementById("wpxL3Status");
    if (l3 && P.tab === "radar") l3.outerHTML = statusLine();
    const mrms = document.getElementById("wpxMrmsStatus");
    if (mrms) {
      const product = MRMS_PRODUCTS.find(p => p.id === P.mrms.product);
      mrms.textContent = !product ? "Off" : mrmsLatest.error ? mrmsLatest.error : mrmsLatest.time ? `Valid ${timeLabel(mrmsLatest.time)}` : "Loading latest…";
    }
    const arm = document.querySelector('[data-wpx="armSounding"]');
    if (arm) arm.textContent = soundingArmed ? "Tap the map now…" : "Tap map for a sounding";
  }

  let routeSearchTimer = 0;
  function onSheetInput(e) {
    const t = e.target;
    if (t.id === "wpxL3Opacity") {
      P.l3.opacity = Number(t.value) / 100;
      const label = document.getElementById("wpxL3OpacityValue");
      if (label) label.textContent = `${t.value}%`;
      try { radarMap?.setPaintProperty("wpx-l3-layer", "raster-opacity", P.l3.opacity); } catch (_) {}
      save();
    } else if (t.id === "wpxMrmsOpacity") {
      P.mrms.opacity = Number(t.value) / 100;
      try { radarMap?.setPaintProperty("wpx-mrms-layer", "raster-opacity", P.mrms.opacity); } catch (_) {}
      save();
    } else if (t.id === "wpxModelOpacity") {
      P.model.opacity = Number(t.value) / 100;
      ["wpx-model-layer", "wpx-model-img-layer"].forEach(id => { try { if (radarMap?.getLayer(id)) radarMap.setPaintProperty(id, "raster-opacity", P.model.opacity); } catch (_) {} });
      save();
    } else if (t.id === "wpxRouteFrom" || t.id === "wpxRouteTo") {
      clearTimeout(routeSearchTimer);
      const which = t.id === "wpxRouteFrom" ? "fromResults" : "toResults";
      const q = t.value;
      routeSearchTimer = setTimeout(async () => {
        try { route[which] = q.trim().length >= 2 ? await geocode(q) : []; } catch (_) { route[which] = []; }
        const focusId = t.id, value = q;
        renderSheet();
        const input = document.getElementById(focusId);
        if (input) { input.value = value; input.focus(); }
      }, 350);
    } else if (t.id === "wpxModelSlider") {
      const hours = studio.hours[`${P.model.model}/${P.model.run}`] || [];
      P.model.fhr = hours[Number(t.value)] ?? P.model.fhr;
      save();
      syncStudioChrome();
      clearTimeout(studio.slideTimer);
      studio.slideTimer = setTimeout(loadFrame, 180);
    }
  }

  function onSheetChange(e) {
    const t = e.target;
    if (t.id === "wpxL3On") { P.l3.on = t.checked; save(); applyAll(true); renderSheet(); }
    else if (t.id === "wpxSite") { P.l3.site = t.value; save(); applyAll(true); renderSheet(); }
    else if (t.id === "wpxPal") { P.l3.pal = t.value; save(); applyAll(true); renderSheet(); }
    else if (t.id === "wpxPalFile") { importPaletteFile(t.files && t.files[0]); t.value = ""; }
    else if (t.id === "wpxGasOn") { P.gas = t.checked; save(); if (P.gas) loadGas(); applyAll(); renderSheet(); }
    else if (t.id === "wpxShelterOn") { P.shelters = t.checked; save(); if (P.shelters) loadShelters(); applyAll(); renderSheet(); }
    else if (t.id === "wpxRun") { P.model.run = t.value; save(); loadHours().then(() => { renderSheet(); loadFrame(); }); }
    else if (t.id === "wpxField") { P.model.field = t.value; save(); loadFrame(); }
  }

  Object.assign(X.actions, {
    openRadar31: () => { if (isSheetOpen()) closeSheet(); else openSheet(); },
    r31Open: el => {
      const tab = el.dataset.tab || "radar";
      try { closePage(); } catch (_) {}
      if (state.tab !== "radar") setTab("radar");
      setTimeout(() => { openSheet(tab); if (tab === "models" && !P.model.on) openStudio(); }, 120);
    },
    closeSheet: () => closeSheet(),
    sheetTab: el => { P.tab = el.dataset.tab; save(); if (P.tab === "map") { if (P.gas) loadGas(); if (P.shelters) loadShelters(); } renderSheet(); },
    nearestSite: () => {
      const s = sitesByDistance({ latitude: state.location.latitude, longitude: state.location.longitude })[0];
      if (s) { P.l3.site = s.id; P.l3.on = true; save(); applyAll(true); renderSheet(); say(`Nearest radar: ${s.id}`); }
    },
    l3Family: el => { P.l3.family = el.dataset.family; if (!familyInfo(P.l3.family).tilts) P.l3.tilt = 0; P.l3.on = true; save(); applyAll(true); renderSheet(); },
    l3Tilt: el => { P.l3.tilt = Number(el.dataset.tilt) || 0; P.l3.on = true; save(); applyAll(true); renderSheet(); },
    deletePal: () => { if (P.l3.pal) delete palettes[P.l3.pal]; P.l3.pal = ""; save(); applyAll(true); renderSheet(); },
    mrmsProduct: el => {
      P.mrms.product = el.dataset.id || "";
      const product = MRMS_PRODUCTS.find(p => p.id === P.mrms.product);
      if (product && !product.windows.map(String).includes(String(P.mrms.window))) P.mrms.window = product.windows[1] ?? product.windows[0];
      save(); mrmsLatest.for = ""; applyAll(true); renderSheet();
    },
    mrmsWindow: el => { P.mrms.window = el.dataset.w; save(); applyAll(true); renderSheet(); },
    routeFromHere: () => { route.from = null; route.fromResults = []; renderSheet(); },
    routePick: el => {
      const list = el.dataset.which === "from" ? route.fromResults : route.toResults;
      const item = list[Number(el.dataset.i)];
      if (!item) return;
      route[el.dataset.which] = item;
      route.fromResults = [];
      route.toResults = [];
      renderSheet();
    },
    routeDepart: el => { route.depart = Number(el.dataset.h) || 0; renderSheet(); },
    routeGo: () => runRoute(),
    routeClear: () => { route.geometry = null; route.results = null; route.summary = null; route.rev++; applyAll(); renderSheet(); },
    armSounding: () => { soundingArmed = !soundingArmed; syncSheetStatus(); if (soundingArmed) say("Tap anywhere on the radar map"); },
    soundingHere: () => openSounding(state.location.latitude, state.location.longitude),
    studioOpen: () => openStudio(),
    studioClose: () => { P.model.on = false; setStudioPlaying(false); save(); applyAll(); renderSheet(); },
    studioModel: el => { P.model.model = el.dataset.id; save(); studio.frame = null; loadRuns().then(loadHours).then(() => { renderSheet(); loadFrame(); }); renderSheet(); },
    studioStep: el => { setStudioPlaying(false); stepModel(Number(el.dataset.d)); },
    studioPlay: () => setStudioPlaying(!studio.playing)
  });

  /* ---------- Hooks into the main radar ---------- */
  if (typeof runRadarMapLayerUpdate === "function") {
    const original = runRadarMapLayerUpdate;
    // eslint-disable-next-line no-global-assign
    runRadarMapLayerUpdate = function () {
      const out = original.apply(this, arguments);
      try { applyAll(); } catch (error) { console.warn("Radar 3.1 layer sync failed", error); }
      return out;
    };
  }

  if (typeof installRadarMapLayers === "function") {
    const originalInstall = installRadarMapLayers;
    // eslint-disable-next-line no-global-assign
    installRadarMapLayers = function () {
      const out = originalInstall.apply(this, arguments);
      try { applyAll(); } catch (error) { console.warn("Radar 3.1 layer install failed", error); }
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
      if (tab !== "radar") closeSheet();
      const out = originalSetTab.apply(this, arguments);
      try { injectButton(); } catch (_) {}
      return out;
    };
  }
  injectButton();

  // Keep site/MRMS scans fresh while radar is on screen.
  setInterval(() => {
    if (document.visibilityState === "hidden" || state.tab !== "radar") return;
    if (P.l3.on || P.mrms.product) applyAll(true);
  }, 120000);

  if (P.gas) loadGas();
  if (P.shelters) loadShelters();

  X.radar = {
    L3_FAMILIES, MRMS_PRODUCTS, icaoFor, loadSites, sitesByDistance, l3Code, currentSite,
    l3Template: async (site, code) => {
      try {
        const json = await getJson(API.radarLatest(site, code), { label: "Latest radar scan" });
        const key = String(pick(json, ["key", "id", "scan_key", "file"], ""));
        const template = pick(json, ["tiles", "tile_url", "tileUrl", "template"], "");
        return { tiles: template ? absolute(Array.isArray(template) ? template[0] : template) : key ? API.radarTile(key, "") : API.radarLive(site, code, ""), time: pick(json, ["time", "valid", "valid_time", "scan_time", "timestamp"], "") };
      } catch (_) {
        return { tiles: `${API.radarLive(site, code, "")}?v=${Math.floor(Date.now() / 120000)}`, time: "" };
      }
    },
    mrmsTemplate: async (product, windowMin) => {
      const json = await getJson(API.mrmsLatest(product, windowMin), { label: "MRMS latest" });
      const key = String(pick(json, ["key", "id", "file"], ""));
      const template = pick(json, ["tiles", "tile_url", "tileUrl", "template"], "");
      return { tiles: template ? absolute(Array.isArray(template) ? template[0] : template) : key ? API.mrmsTile(key) : "", time: pick(json, ["time", "valid", "valid_time", "timestamp"], "") };
    },
    studio: { MODELS, FALLBACK_FIELDS, loadRuns, loadHours, fetchFrameSpec, drawFrame, prefs: P.model, state: studio, fieldLabel },
    openSheet, closeSheet, openSounding
  };
})();
