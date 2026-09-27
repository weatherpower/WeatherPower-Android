# Task: port Radar 3.1 features + Tropical Storm Center + Android TV UI

App = Java WebView wrapper (app/src/main/java/app/weatherpower/mobile/MainActivity.java) loading
app/src/main/assets/index.html via WebViewAssetLoader (origin https://appassets.androidplatform.net). The UI is
all in index.html (MapLibre). Keep package co.median.android.pkmqnq and versioning scheme (bump versionCode).
All data must be real — never invent weather data. Keep the user's MapLibre basemap (no Esri/Carto).

## Server endpoints (live on weatherpower.app, no key needed from the app)
Render service base: https://weatherpower.app/wpcc-render
- Radar products (Level III): /api/radar/products, /sites, /latest?site=KTLX&product=N0B,
  /tile/<key>/{z}/{x}/{y}.png?pal=, /live/<SITE>/<PRODUCT>/{z}/{x}/{y}.png (N0B,N0G velocity kt,N0S,N0C CC,N0X,N0K,EET,DVL)
- 3D volume: /api/radar/volume
- MRMS: /api/mrms/products, /latest?product=hail|rotation|rotation_mid|rain&window=, /tile/..., /value?key&lat&lon
- Gas stations: /gas/dots.js, /gas/t/<lat>_<lon>.js, /gas/status (EIA prices: api.eia.gov DEMO_KEY)
- Tornado shelters: /data/tornado-shelters.json
- Models: /api/models/runs/<hrrr|nam|gfs|ecmwf>, /hours/..., /frame/..., /probe/...
- Sounding image: /api/sounding?lat&lon&fhr
API server: https://weatherpower.app/wpcc-api/sounding?lat&lon&model=hrrr&hours=19 (JSON)
Tropical: NHC MapServer https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer
Route weather: api.weather.gov points/hourly + alerts.
Reference implementation: the Radar 3.1 add-on blocks (wp_*_block.html) — ask the user for radar-3.1-model-studio.html if needed.

## Deliverables
1. Radar: product/tilt/site pickers, velocity/CC/all products, MRMS layers, gas stations, shelters, route weather,
   point soundings, Model Studio, palette import.
2. Tropical Storm Center page: active storms list, cones, tracks, watches/warnings, 7-day outlook, GOES satellite,
   storm detail (intensity, motion, pressure, advisory time).
3. Android TV: add <uses-feature android.software.leanback required=false>, touchscreen required=false,
   LEANBACK_LAUNCHER intent + banner (320x180). In index.html detect TV (bridge flag from MainActivity via
   UiModeManager) and switch to a 10-foot UI: D-pad focus navigation with visible focus ring, large type,
   screens: Live Radar (arrows pan, OK/Back zoom, layer bar), Tropical, Alerts, Forecast/Models, ambient mode.
4. GitHub Actions workflow building debug APK as an artifact (no signing secrets in repo).
