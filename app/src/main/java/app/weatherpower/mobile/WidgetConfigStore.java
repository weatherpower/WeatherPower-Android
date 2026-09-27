package app.weatherpower.mobile;

import android.content.Context;
import android.content.SharedPreferences;

final class WidgetConfigStore {
    private static final String PREFS = "weatherpower_widget_config";
    static final String BG_MATCH = "match";
    static final String BG_TRANSPARENT = "transparent";

    static final class Config {
        final String locationName;
        final double lat;
        final double lon;
        final String backgroundMode;

        Config(String locationName, double lat, double lon, String backgroundMode) {
            this.locationName = locationName;
            this.lat = lat;
            this.lon = lon;
            this.backgroundMode = backgroundMode;
        }
    }

    private WidgetConfigStore() {}

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static Config load(Context context, int widgetId) {
        SharedPreferences prefs = prefs(context);
        String name = prefs.getString(key(widgetId, "name"), WeatherPowerData.locationName(context));
        double lat = Double.longBitsToDouble(prefs.getLong(key(widgetId, "lat"), Double.doubleToLongBits(WeatherPowerData.latitude(context))));
        double lon = Double.longBitsToDouble(prefs.getLong(key(widgetId, "lon"), Double.doubleToLongBits(WeatherPowerData.longitude(context))));
        String background = prefs.getString(key(widgetId, "bg"), BG_MATCH);
        return new Config(name, lat, lon, background == null ? BG_MATCH : background);
    }

    static void save(Context context, int widgetId, String name, double lat, double lon, String backgroundMode) {
        prefs(context).edit()
            .putString(key(widgetId, "name"), name)
            .putLong(key(widgetId, "lat"), Double.doubleToLongBits(lat))
            .putLong(key(widgetId, "lon"), Double.doubleToLongBits(lon))
            .putString(key(widgetId, "bg"), backgroundMode)
            .apply();
    }

    static void delete(Context context, int widgetId) {
        prefs(context).edit()
            .remove(key(widgetId, "name"))
            .remove(key(widgetId, "lat"))
            .remove(key(widgetId, "lon"))
            .remove(key(widgetId, "bg"))
            .apply();
    }

    static int backgroundDrawable(String mode, String summary) {
        if (BG_TRANSPARENT.equals(mode)) return R.drawable.widget_transparent_bg;
        String value = summary == null ? "" : summary.toLowerCase();
        if (value.contains("thunder")) return R.drawable.widget_bg_storm;
        if (value.contains("rain") || value.contains("shower")) return R.drawable.widget_bg_rain;
        if (value.contains("snow")) return R.drawable.widget_bg_snow;
        if (value.contains("clear")) return R.drawable.widget_bg_clear;
        if (value.contains("cloud")) return R.drawable.widget_bg_cloudy;
        return R.drawable.widget_bg_clear;
    }

    private static String key(int widgetId, String suffix) {
        return widgetId + "_" + suffix;
    }
}
