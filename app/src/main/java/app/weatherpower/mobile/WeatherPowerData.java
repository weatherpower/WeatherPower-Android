package app.weatherpower.mobile;

import android.content.Context;
import android.content.SharedPreferences;

final class WeatherPowerData {
    static final String PREFS = "weatherpower_native";
    static final String CHANNEL_ID = "weatherpower_alerts";
    static final String CHANNEL_NAME = "WeatherPower Alerts";

    private WeatherPowerData() {}

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static double latitude(Context context) {
        return Double.longBitsToDouble(prefs(context).getLong("lat", Double.doubleToLongBits(33.8957)));
    }

    static double longitude(Context context) {
        return Double.longBitsToDouble(prefs(context).getLong("lon", Double.doubleToLongBits(-94.8263)));
    }

    static String locationName(Context context) {
        return prefs(context).getString("name", "Idabel");
    }

    static void saveLocation(Context context, double lat, double lon, String name) {
        prefs(context).edit()
            .putLong("lat", Double.doubleToLongBits(lat))
            .putLong("lon", Double.doubleToLongBits(lon))
            .putString("name", name == null || name.trim().isEmpty() ? "WeatherPower" : name.trim())
            .apply();
    }

    static void saveSnapshot(Context context, double lat, double lon, String name, double temp, String summary, double pop, double high, double low) {
        saveLocation(context, lat, lon, name);
        prefs(context).edit()
            .putFloat("temp", (float) temp)
            .putString("summary", summary == null || summary.trim().isEmpty() ? "Weather" : summary.trim())
            .putFloat("pop", (float) pop)
            .putFloat("high", (float) high)
            .putFloat("low", (float) low)
            .putLong("updated", System.currentTimeMillis())
            .apply();
    }
}
