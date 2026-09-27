package app.weatherpower.mobile;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.graphics.BitmapFactory;
import android.graphics.Color;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

public class RainCheckReceiver extends BroadcastReceiver {
    private static final String ACTION_CHECK = "app.weatherpower.mobile.RAIN_CHECK";
    private static final long CHECK_INTERVAL_MS = 60L * 60L * 1000L;
    private static final long MIN_NOTIFICATION_INTERVAL_MS = 60L * 60L * 1000L;
    private static final long LOOKAHEAD_MS = 12L * 60L * 60L * 1000L;
    private static final int RAIN_POP_THRESHOLD = 40;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!WeatherPowerData.prefs(context).getBoolean("rain_enabled", false)) return;
        PendingResult result = goAsync();
        new Thread(() -> {
            try {
                checkRain(context.getApplicationContext());
            } finally {
                result.finish();
            }
        }, "WeatherPowerRainCheck").start();
    }

    static void setEnabled(Context context, boolean enabled, double lat, double lon, String name) {
        SharedPreferences prefs = WeatherPowerData.prefs(context);
        boolean wasEnabled = prefs.getBoolean("rain_enabled", false);
        String oldLocationKey = prefs.getString("rain_location_key", "");
        String newLocationKey = String.format(Locale.US, "%.3f,%.3f", lat, lon);
        WeatherPowerData.saveLocation(context, lat, lon, name);
        prefs.edit()
            .putBoolean("rain_enabled", enabled)
            .putString("rain_location_key", newLocationKey)
            .apply();
        if (enabled) {
            schedule(context);
            if (!wasEnabled || !newLocationKey.equals(oldLocationKey)) runNow(context);
        } else {
            cancel(context);
        }
    }

    static void schedule(Context context) {
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return;
        PendingIntent pendingIntent = pendingIntent(context);
        long first = System.currentTimeMillis() + 5L * 60L * 1000L;
        alarmManager.setInexactRepeating(AlarmManager.RTC_WAKEUP, first, CHECK_INTERVAL_MS, pendingIntent);
    }

    static void cancel(Context context) {
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager != null) alarmManager.cancel(pendingIntent(context));
    }

    static void runNow(Context context) {
        Intent intent = new Intent(context, RainCheckReceiver.class).setAction(ACTION_CHECK);
        context.sendBroadcast(intent);
    }

    private static PendingIntent pendingIntent(Context context) {
        Intent intent = new Intent(context, RainCheckReceiver.class).setAction(ACTION_CHECK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(context, 2206, intent, flags);
    }

    private static void checkRain(Context context) {
        try {
            double lat = WeatherPowerData.latitude(context);
            double lon = WeatherPowerData.longitude(context);
            String url = "https://api.open-meteo.com/v1/forecast?latitude=" + enc(String.valueOf(lat)) +
                "&longitude=" + enc(String.valueOf(lon)) +
                "&hourly=precipitation_probability,precipitation,weather_code" +
                "&current=temperature_2m,weather_code,precipitation" +
                "&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=2";
            JSONObject json = new JSONObject(fetch(url));
            JSONObject hourly = json.getJSONObject("hourly");
            JSONArray times = hourly.getJSONArray("time");
            JSONArray pops = hourly.optJSONArray("precipitation_probability");
            JSONArray precip = hourly.optJSONArray("precipitation");
            JSONArray codes = hourly.optJSONArray("weather_code");

            int selected = -1;
            int selectedPop = 0;
            double selectedPrecip = 0;
            int selectedCode = 0;
            long selectedMillis = 0L;
            long now = System.currentTimeMillis();
            long end = now + LOOKAHEAD_MS;

            for (int i = 0; i < times.length(); i++) {
                long millis = parseLocalTime(times.getString(i));
                if (millis < now - 10L * 60L * 1000L) continue;
                if (millis > end) break;

                int pop = pops == null || pops.isNull(i) ? 0 : pops.optInt(i, 0);
                double amount = precip == null || precip.isNull(i) ? 0 : precip.optDouble(i, 0);
                int code = codes == null || codes.isNull(i) ? 0 : codes.optInt(i, 0);

                if (isRainSignal(pop, amount, code)) {
                    selected = i;
                    selectedPop = pop;
                    selectedPrecip = amount;
                    selectedCode = code;
                    selectedMillis = millis;
                    break;
                }
            }

            if (selected < 0) return;

            String eventKey = times.getString(selected) + ":" + selectedPop + ":" + Math.round(selectedPrecip * 1000) + ":" + selectedCode;
            SharedPreferences prefs = WeatherPowerData.prefs(context);
            long lastNotify = prefs.getLong("last_rain_notify_ms", 0L);
            if (now - lastNotify < MIN_NOTIFICATION_INTERVAL_MS) return;
            if (eventKey.equals(prefs.getString("last_rain_event", ""))) return;
            prefs.edit()
                .putString("last_rain_event", eventKey)
                .putLong("last_rain_notify_ms", now)
                .apply();

            String location = WeatherPowerData.locationName(context);
            String when = displayTimeWithDay(selectedMillis);
            String eventName;
            if (isThunderCode(selectedCode)) eventName = "Thunderstorms";
            else eventName = "Rain";
            String title = eventName + " possible at " + displayClock(selectedMillis);
            String detail = eventName + " possible " + when + " for " + location + ". Chance: " + selectedPop + "%" +
                (selectedPrecip > 0 ? " · " + String.format(Locale.US, "%.2f in", selectedPrecip) : "") +
                ". Tap to check radar.";
            showRainNotification(context, title, detail, eventKey);
        } catch (Exception ignored) {
        }
    }

    private static boolean isRainSignal(int pop, double amount, int code) {
        if (amount >= 0.01) return true;
        if (pop >= RAIN_POP_THRESHOLD) return true;
        return isRainCode(code) && pop >= 30;
    }

    private static boolean isRainCode(int code) {
        return (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || isThunderCode(code);
    }

    private static boolean isThunderCode(int code) {
        return code == 95 || code == 96 || code == 99;
    }

    private static boolean isSevereThunderCode(int code) {
        return code == 96 || code == 99;
    }

    private static long parseLocalTime(String value) throws Exception {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.US);
        format.setTimeZone(TimeZone.getDefault());
        Date date = format.parse(value);
        return date == null ? System.currentTimeMillis() : date.getTime();
    }

    private static String displayClock(long millis) {
        return new SimpleDateFormat("h:mm a", Locale.US).format(new Date(millis));
    }

    private static String displayTimeWithDay(long millis) {
        Calendar target = Calendar.getInstance();
        target.setTimeInMillis(millis);
        Calendar today = Calendar.getInstance();

        Calendar tomorrow = Calendar.getInstance();
        tomorrow.add(Calendar.DAY_OF_YEAR, 1);

        String clock = displayClock(millis);
        if (sameDay(target, today)) return "today at " + clock;
        if (sameDay(target, tomorrow)) return "tomorrow at " + clock;
        return new SimpleDateFormat("EEE 'at' h:mm a", Locale.US).format(new Date(millis));
    }

    private static boolean sameDay(Calendar a, Calendar b) {
        return a.get(Calendar.YEAR) == b.get(Calendar.YEAR) && a.get(Calendar.DAY_OF_YEAR) == b.get(Calendar.DAY_OF_YEAR);
    }

    private static String fetch(String urlString) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(urlString).openConnection();
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(10_000);
        connection.setRequestProperty("User-Agent", "WeatherPowerAndroid/1.8.0 weatherpower.app");
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
            StringBuilder builder = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) builder.append(line);
            return builder.toString();
        } finally {
            connection.disconnect();
        }
    }

    private static String enc(String value) throws Exception {
        return URLEncoder.encode(value, "UTF-8");
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(WeatherPowerData.CHANNEL_ID, WeatherPowerData.CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("WeatherPower rain, forecast, and severe weather notifications");
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private static void showRainNotification(Context context, String title, String body, String tag) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        ensureChannel(context);
        Intent launch = new Intent(context, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(context, 2207, launch, flags);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, WeatherPowerData.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_weatherpower)
            .setLargeIcon(BitmapFactory.decodeResource(context.getResources(), R.mipmap.ic_launcher))
            .setColor(Color.rgb(94, 231, 255))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(contentIntent);
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(Math.abs(("rain-" + tag).hashCode()), builder.build());
    }
}
