package app.weatherpower.mobile;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.widget.RemoteViews;

public class WeatherPowerForecastWidgetProvider extends AppWidgetProvider {
    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (intent != null && (WidgetRefreshReceiver.ACTION_REFRESH.equals(intent.getAction()) || AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(intent.getAction()))) {
            WidgetRefreshReceiver.schedule(context);
        }
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        WidgetRefreshReceiver.schedule(context);
        updateAllAsync(context, appWidgetManager, appWidgetIds, goAsync());
    }

    @Override
    public void onDeleted(Context context, int[] appWidgetIds) {
        for (int id : appWidgetIds) WidgetConfigStore.delete(context, id);
        super.onDeleted(context, appWidgetIds);
    }

    static void refreshAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, WeatherPowerForecastWidgetProvider.class));
        updateAllAsync(context, manager, ids, null);
    }

    static void refreshAllBlocking(Context context, AppWidgetManager manager, int[] ids) {
        updateAllBlocking(context, manager, ids);
    }

    static void updateSingle(Context context, AppWidgetManager manager, int id) {
        updateAllAsync(context, manager, new int[]{id}, null);
    }

    private static void updateAllAsync(Context context, AppWidgetManager manager, int[] ids, BroadcastReceiver.PendingResult pendingResult) {
        final Context appContext = context.getApplicationContext();
        new Thread(() -> {
            try { updateAllBlocking(appContext, manager, ids); }
            finally { if (pendingResult != null) pendingResult.finish(); }
        }, "WeatherPowerForecastWidget").start();
    }

    private static void updateAllBlocking(Context context, AppWidgetManager manager, int[] ids) {
        if (ids == null || ids.length == 0) return;
        for (int id : ids) {
            WidgetWeatherFetcher.ForecastData data = WidgetWeatherFetcher.fetch(context, id);
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.weatherpower_forecast_widget);
            int background = WidgetConfigStore.backgroundDrawable(data.backgroundMode, data.summary);
            views.setInt(R.id.widgetRoot, "setBackgroundResource", background);
            views.setTextViewText(R.id.widgetLocation, data.location);
            views.setTextViewText(R.id.widgetConditionIcon, WidgetWeatherFetcher.iconForSummary(data.summary));
            views.setTextColor(R.id.widgetConditionIcon, data.severeThunder ? Color.parseColor("#FF3B3B") : Color.WHITE);
            views.setTextViewText(R.id.widgetTemp, data.temp + "°");
            views.setTextViewText(R.id.widgetHiLo, "H " + data.high + "°\nL " + data.low + "°");
            views.setTextViewText(R.id.widgetSummary, data.summary);
            views.setTextViewText(R.id.widgetWind, data.windDirection + " " + data.wind + " mph");
            views.setTextViewText(R.id.widgetRain, data.nextRainTime);
            views.setTextViewText(R.id.widgetUpdated, data.updated + " · tap to refresh");
            views.setTextColor(R.id.widgetLocation, Color.WHITE);
            views.setTextColor(R.id.widgetLocationPin, Color.WHITE);
            views.setTextColor(R.id.widgetSettings, Color.WHITE);
            views.setTextColor(R.id.widgetTemp, Color.WHITE);
            views.setTextColor(R.id.widgetHiLo, Color.parseColor("#D7F7FF"));
            views.setTextColor(R.id.widgetSummary, Color.WHITE);
            views.setTextColor(R.id.widgetWind, Color.WHITE);
            views.setTextColor(R.id.widgetRain, Color.parseColor("#E7F6FF"));
            views.setTextColor(R.id.widgetUpdated, Color.parseColor("#92DDEA"));
            views.setOnClickPendingIntent(R.id.widgetRoot, launchIntent(context));
            views.setOnClickPendingIntent(R.id.widgetSettings, configIntent(context, id));
            views.setOnClickPendingIntent(R.id.widgetUpdated, WidgetRefreshReceiver.refreshPendingIntent(context));
            manager.updateAppWidget(id, views);
        }
    }

    private static PendingIntent launchIntent(Context context) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(context, 3001, intent, flags);
    }

    private static PendingIntent configIntent(Context context, int widgetId) {
        Intent intent = new Intent(context, WidgetConfigActivity.class);
        intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(context, 3100 + widgetId, intent, flags);
    }
}
