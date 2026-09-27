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

public class WeatherPowerRainWidgetProvider extends AppWidgetProvider {
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
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, WeatherPowerRainWidgetProvider.class));
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
        }, "WeatherPowerRainWidget").start();
    }

    private static void updateAllBlocking(Context context, AppWidgetManager manager, int[] ids) {
        if (ids == null || ids.length == 0) return;
        for (int id : ids) {
            WidgetWeatherFetcher.ForecastData data = WidgetWeatherFetcher.fetch(context, id);
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.weatherpower_rain_widget);
            int background = WidgetConfigStore.backgroundDrawable(data.backgroundMode, data.summary);
            views.setInt(R.id.rainWidgetRoot, "setBackgroundResource", background);
            views.setTextViewText(R.id.rainWidgetLocation, "● " + data.location);
            views.setTextViewText(R.id.rainWidgetHeadline, data.nextRainTime);
            String chanceLabel = data.summary != null && data.summary.toLowerCase().contains("thunder") ? "% storm chance · " : "% rain chance · ";
            views.setTextViewText(R.id.rainWidgetChance, data.pop + chanceLabel + data.summary);
            views.setTextViewText(R.id.rainWidgetTemp, data.temp + "°");
            views.setTextViewText(R.id.rainWidgetIcon, WidgetWeatherFetcher.iconForSummary(data.summary));
            views.setTextViewText(R.id.rainWidgetUpdated, data.updated + " · tap to refresh");
            views.setTextColor(R.id.rainWidgetLocation, Color.WHITE);
            views.setTextColor(R.id.rainWidgetSettings, Color.WHITE);
            views.setTextColor(R.id.rainWidgetHeadline, Color.WHITE);
            views.setTextColor(R.id.rainWidgetChance, Color.parseColor("#E7F6FF"));
            views.setTextColor(R.id.rainWidgetTemp, Color.WHITE);
            views.setTextColor(R.id.rainWidgetIcon, data.severeThunder ? Color.parseColor("#FF3B3B") : Color.WHITE);
            views.setTextColor(R.id.rainWidgetUpdated, Color.parseColor("#92DDEA"));
            views.setOnClickPendingIntent(R.id.rainWidgetRoot, launchIntent(context));
            views.setOnClickPendingIntent(R.id.rainWidgetSettings, configIntent(context, id));
            views.setOnClickPendingIntent(R.id.rainWidgetUpdated, WidgetRefreshReceiver.refreshPendingIntent(context));
            manager.updateAppWidget(id, views);
        }
    }

    private static PendingIntent launchIntent(Context context) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(context, 3002, intent, flags);
    }

    private static PendingIntent configIntent(Context context, int widgetId) {
        Intent intent = new Intent(context, WidgetConfigActivity.class);
        intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(context, 3200 + widgetId, intent, flags);
    }
}
