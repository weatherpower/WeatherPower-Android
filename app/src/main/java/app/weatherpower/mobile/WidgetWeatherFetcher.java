package app.weatherpower.mobile;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

final class WidgetWeatherFetcher {
    static final class ForecastData {
        String location;
        String summary;
        int temp;
        int high;
        int low;
        int pop;
        int wind;
        String windDirection;
        String nextRainTime;
        String updated;
        String backgroundMode;
        boolean severeThunder;
        boolean live;
    }

    private WidgetWeatherFetcher() {}

    static ForecastData fetch(Context context, int widgetId) {
        WidgetConfigStore.Config config = WidgetConfigStore.load(context, widgetId);
        ForecastData fallback = fallback(context, config);
        try {
            ForecastData data = fetchOpenMeteo(context, config, fallback);
            save(context, config, data);
            return data;
        } catch (Exception openMeteoError) {
            try {
                ForecastData data = fetchOpenMeteoCurrentWeather(context, config, fallback);
                save(context, config, data);
                return data;
            } catch (Exception backupError) {
                fallback.updated = "Offline · tap to retry";
                fallback.live = false;
                return fallback;
            }
        }
    }

    private static ForecastData fetchOpenMeteo(Context context, WidgetConfigStore.Config config, ForecastData fallback) throws Exception {
        double lat = config.lat;
        double lon = config.lon;
        String url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon + "&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m&hourly=precipitation_probability,precipitation,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=2";
        JSONObject json = new JSONObject(fetchUrl(url));
        ForecastData data = new ForecastData();
        data.location = shorten(config.locationName);
        JSONObject current = json.optJSONObject("current");
        if (current == null) throw new IllegalStateException("No current block");
        data.temp = (int) Math.round(current.optDouble("temperature_2m", fallback.temp));
        int currentCode = current.optInt("weather_code", 3);
        JSONObject daily = json.optJSONObject("daily");
        JSONObject hourly = json.optJSONObject("hourly");
        int bestStormCodeToday = strongestStormCodeForToday(hourly, daily);
        if (isThunderCode(bestStormCodeToday) && !isThunderCode(currentCode)) currentCode = bestStormCodeToday;
        data.severeThunder = isSevereThunderCode(currentCode) || isSevereThunderCode(bestStormCodeToday);
        data.summary = friendlySummary(summaryForCode(currentCode));
        JSONArray highs = daily == null ? null : daily.optJSONArray("temperature_2m_max");
        JSONArray lows = daily == null ? null : daily.optJSONArray("temperature_2m_min");
        JSONArray popsDaily = daily == null ? null : daily.optJSONArray("precipitation_probability_max");
        data.high = highs == null ? fallback.high : (int) Math.round(highs.optDouble(0, fallback.high));
        data.low = lows == null ? fallback.low : (int) Math.round(lows.optDouble(0, fallback.low));
        data.pop = popsDaily == null ? fallback.pop : popsDaily.optInt(0, fallback.pop);
        data.wind = (int) Math.round(current.optDouble("wind_speed_10m", fallback.wind));
        data.windDirection = direction(current.optDouble("wind_direction_10m", 0));
        data.nextRainTime = nextRain(hourly);
        if (data.severeThunder && !data.nextRainTime.toLowerCase(Locale.US).contains("thunder")) data.nextRainTime = "Thunderstorms possible";
        data.updated = "Live " + new SimpleDateFormat("h:mm a", Locale.US).format(new Date());
        data.backgroundMode = config.backgroundMode;
        data.live = true;
        return data;
    }

    private static ForecastData fetchOpenMeteoCurrentWeather(Context context, WidgetConfigStore.Config config, ForecastData fallback) throws Exception {
        double lat = config.lat;
        double lon = config.lon;
        String url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon + "&current_weather=true&hourly=precipitation_probability,precipitation,weathercode&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=2";
        JSONObject json = new JSONObject(fetchUrl(url));
        ForecastData data = new ForecastData();
        data.location = shorten(config.locationName);
        JSONObject current = json.optJSONObject("current_weather");
        if (current == null) throw new IllegalStateException("No current_weather block");
        int currentCode = current.optInt("weathercode", 3);
        data.temp = (int) Math.round(current.optDouble("temperature", fallback.temp));
        data.summary = friendlySummary(summaryForCode(currentCode));
        data.severeThunder = isSevereThunderCode(currentCode);
        JSONObject daily = json.optJSONObject("daily");
        JSONObject hourly = json.optJSONObject("hourly");
        JSONArray highs = daily == null ? null : daily.optJSONArray("temperature_2m_max");
        JSONArray lows = daily == null ? null : daily.optJSONArray("temperature_2m_min");
        JSONArray popsDaily = daily == null ? null : daily.optJSONArray("precipitation_probability_max");
        data.high = highs == null ? fallback.high : (int) Math.round(highs.optDouble(0, fallback.high));
        data.low = lows == null ? fallback.low : (int) Math.round(lows.optDouble(0, fallback.low));
        data.pop = popsDaily == null ? fallback.pop : popsDaily.optInt(0, fallback.pop);
        data.wind = (int) Math.round(current.optDouble("windspeed", fallback.wind));
        data.windDirection = direction(current.optDouble("winddirection", 0));
        data.nextRainTime = nextRain(hourly);
        data.updated = "Live " + new SimpleDateFormat("h:mm a", Locale.US).format(new Date());
        data.backgroundMode = config.backgroundMode;
        data.live = true;
        return data;
    }

    private static void save(Context context, WidgetConfigStore.Config config, ForecastData data) {
        WeatherPowerData.saveSnapshot(context, config.lat, config.lon, data.location, data.temp, data.summary, data.pop, data.high, data.low);
        WeatherPowerData.prefs(context).edit().putLong("widget_last_live_success_ms", System.currentTimeMillis()).apply();
    }

    private static ForecastData fallback(Context context, WidgetConfigStore.Config config) {
        ForecastData data = new ForecastData();
        android.content.SharedPreferences prefs = WeatherPowerData.prefs(context);
        data.location = shorten(config.locationName);
        data.temp = Math.round(prefs.getFloat("temp", 81f));
        data.summary = prefs.getString("summary", "Open WeatherPower");
        data.pop = Math.round(prefs.getFloat("pop", 0f));
        data.high = Math.round(prefs.getFloat("high", data.temp));
        data.low = Math.round(prefs.getFloat("low", data.temp));
        data.wind = 0;
        data.windDirection = "";
        data.nextRainTime = data.pop >= 35 ? "Rain possible soon" : "Tap to refresh forecast";
        long saved = prefs.getLong("updated", 0L);
        data.updated = saved > 0L ? "Cached " + new SimpleDateFormat("h:mm a", Locale.US).format(new Date(saved)) : "Tap to refresh";
        data.backgroundMode = config.backgroundMode;
        data.severeThunder = data.summary != null && data.summary.toLowerCase(Locale.US).contains("severe");
        data.live = false;
        return data;
    }

    private static String nextRain(JSONObject hourly) {
        if (hourly == null) return "No rain soon";
        JSONArray time = hourly.optJSONArray("time");
        JSONArray pop = hourly.optJSONArray("precipitation_probability");
        JSONArray precip = hourly.optJSONArray("precipitation");
        JSONArray code = hourly.optJSONArray("weather_code");
        if (code == null) code = hourly.optJSONArray("weathercode");
        if (time == null) return "No rain soon";
        long now = System.currentTimeMillis();
        long end = now + 12L * 60L * 60L * 1000L;
        for (int i = 0; i < time.length(); i++) {
            long millis = parseLocalTime(time.optString(i));
            if (millis < now - 10L * 60L * 1000L) continue;
            if (millis > end) break;
            int p = pop == null || pop.isNull(i) ? 0 : pop.optInt(i, 0);
            double amount = precip == null || precip.isNull(i) ? 0 : precip.optDouble(i, 0);
            int c = code == null || code.isNull(i) ? 0 : code.optInt(i, 0);
            if (isThunderCode(c) && p >= 20) return "Thunderstorms possible at " + displayHour(millis);
            if (p >= 40 || amount >= 0.01 || (((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) && p >= 30)) return "Rain possible at " + displayHour(millis);
        }
        return "No rain soon";
    }

    private static int strongestStormCodeForToday(JSONObject hourly, JSONObject daily) {
        if (hourly == null) return 0;
        JSONArray times = hourly.optJSONArray("time");
        JSONArray codes = hourly.optJSONArray("weather_code");
        if (codes == null) codes = hourly.optJSONArray("weathercode");
        if (times == null || codes == null) return 0;
        String today = null;
        if (daily != null) {
            JSONArray dates = daily.optJSONArray("time");
            if (dates != null && dates.length() > 0) today = dates.optString(0, null);
        }
        if (today == null || today.isEmpty()) today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        int best = 0;
        for (int i = 0; i < times.length() && i < codes.length(); i++) {
            String time = times.optString(i, "");
            if (!time.startsWith(today)) continue;
            int code = codes.optInt(i, 0);
            if (isSevereThunderCode(code)) return code;
            if (isThunderCode(code)) best = code;
        }
        return best;
    }

    private static boolean isThunderCode(int code) { return code == 95 || code == 96 || code == 99; }
    private static boolean isSevereThunderCode(int code) { return code == 96 || code == 99; }

    private static long parseLocalTime(String value) {
        try {
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.US);
            format.setTimeZone(TimeZone.getDefault());
            Date date = format.parse(value);
            return date == null ? System.currentTimeMillis() : date.getTime();
        } catch (Exception ignored) { return System.currentTimeMillis(); }
    }

    private static String displayHour(long millis) { return new SimpleDateFormat("h:mm a", Locale.US).format(new Date(millis)); }

    private static String summaryForCode(int code) {
        if (code == 0) return "Clear";
        if (code == 1 || code == 2) return "Partly cloudy";
        if (code == 3) return "Cloudy";
        if (code == 45 || code == 48) return "Fog";
        if (code == 51 || code == 53 || code == 55 || code == 56 || code == 57) return "Drizzle";
        if (code == 61 || code == 63 || code == 65 || code == 66 || code == 67) return "Rain";
        if (code == 71 || code == 73 || code == 75 || code == 77 || code == 85 || code == 86) return "Snow";
        if (code == 80 || code == 81 || code == 82) return "Showers";
        if (code == 95 || code == 96 || code == 99) return "Thunderstorm";
        return "Weather";
    }

    private static String friendlySummary(String summary) { return summary == null || summary.trim().isEmpty() ? "Weather" : summary; }

    static String iconForSummary(String summary) {
        String value = summary == null ? "" : summary.toLowerCase(Locale.US);
        if (value.contains("thunder")) return "⛈";
        if (value.contains("snow")) return "❄";
        if (value.contains("rain") || value.contains("shower") || value.contains("drizzle")) return "🌧";
        if (value.contains("fog")) return "🌫";
        if (value.contains("partly")) return "⛅";
        if (value.contains("cloud")) return "☁";
        if (value.contains("clear")) return "☀";
        return "⛅";
    }

    private static String direction(double degrees) {
        String[] dirs = {"N", "NE", "E", "SE", "S", "SW", "W", "NW"};
        return dirs[(int) Math.round(((degrees % 360) / 45.0)) % 8];
    }

    private static String shorten(String location) {
        if (location == null || location.trim().isEmpty()) return "WeatherPower";
        String text = location.trim();
        if (text.length() > 18) {
            int comma = text.indexOf(',');
            if (comma > 0) return text.substring(0, comma).trim();
            return text.substring(0, 18).trim();
        }
        return text;
    }

    private static String fetchUrl(String urlString) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(urlString).openConnection();
        connection.setConnectTimeout(6500);
        connection.setReadTimeout(6500);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "WeatherPowerAndroidWidget/1.8.0 weatherpower.app");
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) throw new IllegalStateException("Weather API HTTP " + status);
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
            StringBuilder builder = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) builder.append(line);
            return builder.toString();
        } finally { connection.disconnect(); }
    }
}
