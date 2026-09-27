package app.weatherpower.mobile;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class WidgetConfigActivity extends Activity {
    private int appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
    private EditText cityInput;
    private RadioButton matchButton;
    private RadioButton transparentButton;
    private TextView statusText;
    private String selectedName;
    private double selectedLat;
    private double selectedLon;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_widget_config);
        setResult(RESULT_CANCELED);

        cityInput = findViewById(R.id.widgetConfigSearch);
        matchButton = findViewById(R.id.widgetConfigMatch);
        transparentButton = findViewById(R.id.widgetConfigTransparent);
        statusText = findViewById(R.id.widgetConfigStatus);
        Button useCurrent = findViewById(R.id.widgetConfigCurrentLocation);
        Button done = findViewById(R.id.widgetConfigDone);
        Button cancel = findViewById(R.id.widgetConfigCancel);
        RadioGroup group = findViewById(R.id.widgetConfigRadioGroup);

        Intent intent = getIntent();
        Bundle extras = intent.getExtras();
        if (extras != null) {
            appWidgetId = extras.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        }
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish();
            return;
        }

        WidgetConfigStore.Config config = WidgetConfigStore.load(this, appWidgetId);
        selectedName = config.locationName;
        selectedLat = config.lat;
        selectedLon = config.lon;
        cityInput.setText(config.locationName);
        if (WidgetConfigStore.BG_TRANSPARENT.equals(config.backgroundMode)) {
            transparentButton.setChecked(true);
        } else {
            matchButton.setChecked(true);
        }
        statusText.setText("Using " + selectedName);

        useCurrent.setOnClickListener(v -> {
            selectedName = WeatherPowerData.locationName(this);
            selectedLat = WeatherPowerData.latitude(this);
            selectedLon = WeatherPowerData.longitude(this);
            cityInput.setText(selectedName);
            statusText.setText("Using current app location: " + selectedName);
        });

        done.setOnClickListener(v -> saveAndFinish());
        cancel.setOnClickListener(v -> finish());
        group.setOnCheckedChangeListener((rg, checkedId) -> statusText.setVisibility(View.VISIBLE));
    }

    private void saveAndFinish() {
        String text = cityInput.getText().toString().trim();
        String bg = transparentButton.isChecked() ? WidgetConfigStore.BG_TRANSPARENT : WidgetConfigStore.BG_MATCH;
        if (TextUtils.isEmpty(text) || text.equalsIgnoreCase(selectedName)) {
            WidgetConfigStore.save(this, appWidgetId, selectedName, selectedLat, selectedLon, bg);
            updateWidget();
            return;
        }

        statusText.setText("Searching for " + text + "...");
        new Thread(() -> {
            try {
                LocationResult result = geocode(text);
                runOnUiThread(() -> {
                    selectedName = result.name;
                    selectedLat = result.lat;
                    selectedLon = result.lon;
                    WidgetConfigStore.save(this, appWidgetId, selectedName, selectedLat, selectedLon, bg);
                    updateWidget();
                });
            } catch (Exception error) {
                runOnUiThread(() -> statusText.setText("Could not find that city. Try 'Idabel' or 'Dallas, TX'."));
            }
        }, "WeatherPowerWidgetConfigSearch").start();
    }

    private void updateWidget() {
        AppWidgetManager manager = AppWidgetManager.getInstance(this);
        android.appwidget.AppWidgetProviderInfo info = manager.getAppWidgetInfo(appWidgetId);
        String className = info != null && info.provider != null ? info.provider.getClassName() : "";
        if (className.contains("Rain")) {
            WeatherPowerRainWidgetProvider.updateSingle(this, manager, appWidgetId);
        } else {
            WeatherPowerForecastWidgetProvider.updateSingle(this, manager, appWidgetId);
        }
        Intent result = new Intent();
        result.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        setResult(RESULT_OK, result);
        finish();
    }

    private static final class LocationResult {
        final String name;
        final double lat;
        final double lon;

        LocationResult(String name, double lat, double lon) {
            this.name = name;
            this.lat = lat;
            this.lon = lon;
        }
    }

    private static LocationResult geocode(String query) throws Exception {
        String urlString = "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=" + java.net.URLEncoder.encode(query, "UTF-8");
        HttpURLConnection connection = (HttpURLConnection) new URL(urlString).openConnection();
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(10000);
        connection.setRequestProperty("User-Agent", "WeatherPowerWidgetConfig/1.0");
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
            StringBuilder builder = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) builder.append(line);
            JSONObject json = new JSONObject(builder.toString());
            JSONArray results = json.optJSONArray("results");
            if (results == null || results.length() == 0) throw new IllegalStateException("No city found");
            JSONObject item = results.getJSONObject(0);
            String name = item.optString("name", query);
            String admin = item.optString("admin1", "");
            String country = item.optString("country_code", "");
            String display = name;
            if (!admin.isEmpty()) display += ", " + admin;
            if (!country.isEmpty()) display += " " + country;
            return new LocationResult(display, item.getDouble("latitude"), item.getDouble("longitude"));
        } finally {
            connection.disconnect();
        }
    }
}
