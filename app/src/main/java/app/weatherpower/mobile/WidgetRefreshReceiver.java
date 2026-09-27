package app.weatherpower.mobile;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;

public class WidgetRefreshReceiver extends BroadcastReceiver {
    static final String ACTION_REFRESH = "app.weatherpower.mobile.WIDGET_REFRESH";
    private static final long REFRESH_INTERVAL_MS = 30L * 60L * 1000L;
    private static final long STALE_AFTER_MS = 10L * 60L * 1000L;

    @Override
    public void onReceive(Context context, Intent intent) {
        final PendingResult pendingResult = goAsync();
        final Context appContext = context.getApplicationContext();
        new Thread(() -> {
            try {
                forceRefreshBlocking(appContext);
                schedule(appContext);
            } finally {
                pendingResult.finish();
            }
        }, "WeatherPowerWidgetRefreshReceiver").start();
    }

    static void schedule(Context context) {
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return;
        PendingIntent pendingIntent = refreshPendingIntent(context);
        long first = SystemClock.elapsedRealtime() + REFRESH_INTERVAL_MS;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) alarmManager.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, first, pendingIntent);
        else alarmManager.setInexactRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP, first, REFRESH_INTERVAL_MS, pendingIntent);
    }

    static void refreshIfStale(Context context) {
        long now = System.currentTimeMillis();
        long last = WeatherPowerData.prefs(context).getLong("widget_last_refresh_ms", 0L);
        if (now - last >= STALE_AFTER_MS) forceRefresh(context);
    }

    static void forceRefresh(Context context) {
        final Context appContext = context.getApplicationContext();
        new Thread(() -> forceRefreshBlocking(appContext), "WeatherPowerWidgetManualRefresh").start();
    }

    static void forceRefreshBlocking(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] forecastIds = manager.getAppWidgetIds(new ComponentName(context, WeatherPowerForecastWidgetProvider.class));
        int[] rainIds = manager.getAppWidgetIds(new ComponentName(context, WeatherPowerRainWidgetProvider.class));
        if (forecastIds != null && forecastIds.length > 0) WeatherPowerForecastWidgetProvider.refreshAllBlocking(context, manager, forecastIds);
        if (rainIds != null && rainIds.length > 0) WeatherPowerRainWidgetProvider.refreshAllBlocking(context, manager, rainIds);
        WeatherPowerData.prefs(context).edit().putLong("widget_last_refresh_ms", System.currentTimeMillis()).apply();
    }

    static PendingIntent refreshPendingIntent(Context context) {
        Intent intent = new Intent(context, WidgetRefreshReceiver.class).setAction(ACTION_REFRESH);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_MUTABLE;
        return PendingIntent.getBroadcast(context, 3306, intent, flags);
    }
}
