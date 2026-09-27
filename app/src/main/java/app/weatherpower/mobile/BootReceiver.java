package app.weatherpower.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        final PendingResult pendingResult = goAsync();
        final Context appContext = context.getApplicationContext();
        new Thread(() -> {
            try {
                WidgetRefreshReceiver.schedule(appContext);
                if (WeatherPowerData.prefs(appContext).getBoolean("rain_enabled", false)) RainCheckReceiver.schedule(appContext);
                WidgetRefreshReceiver.forceRefreshBlocking(appContext);
            } finally {
                pendingResult.finish();
            }
        }, "WeatherPowerBootRefresh").start();
    }
}
