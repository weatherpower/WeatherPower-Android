package app.weatherpower.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.UiModeManager;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.widget.FrameLayout;

import androidx.core.app.NotificationCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int PERMISSION_REQUEST_CODE = 100;
    private static final int FILE_CHOOSER_REQUEST_CODE = 101;
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 102;
    private static final String START_URL = "https://appassets.androidplatform.net/assets/index.html?wpv=190-code175-radar31-tv";
    private static final String NOTIFICATION_CHANNEL_ID = "weatherpower_alerts";
    private static final String NOTIFICATION_CHANNEL_NAME = "WeatherPower Alerts";
    private static final String WEATHERPOWER_USER_AGENT = "WeatherPowerAndroid/1.8.0 (weatherpower.app; joshua.yarbrough@weatherpower.app)";
    static final String FIREBASE_CONFIG_API_KEY = "AIzaSyAe2iFWm-1e0yVzaL7kDnsxuzaSY0m0jN4";
    private WebView webView;
    private View webViewContainer;
    private WebViewAssetLoader assetLoader;
    private ValueCallback<Uri[]> fileUploadCallback;
    private Uri cameraPhotoUri;
    private GeolocationPermissions.Callback pendingGeolocationCallback;
    private String pendingGeolocationOrigin;
    private Object predictiveBackCallback;
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean isTelevision;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        isTelevision = detectTelevision();
        configureSystemBars();
        createNotificationChannel();

        boolean isDebuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(isDebuggable);
        requestBasePermissions();
        setupWebView();
        registerPredictiveBack();
        WidgetRefreshReceiver.schedule(this);
        WidgetRefreshReceiver.refreshIfStale(this);
        if (savedInstanceState == null) webView.loadUrl(isTelevision ? START_URL + "&tv=1" : START_URL);
        else webView.restoreState(savedInstanceState);
    }

    private void configureSystemBars() {
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);

        // Android 15+ enforces edge-to-edge. Older versions keep the WeatherPower dark bars.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
        } else {
            window.setStatusBarColor(Color.rgb(3, 11, 16));
            window.setNavigationBarColor(Color.rgb(3, 11, 16));
        }

        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
    }

    private boolean detectTelevision() {
        UiModeManager uiModeManager = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
        if (uiModeManager != null && uiModeManager.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) return true;
        PackageManager pm = getPackageManager();
        return pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
            || pm.hasSystemFeature("android.software.leanback_only");
    }

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    private void setupWebView() {
        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.setBackgroundColor(Color.rgb(3, 11, 16));

        // Keep the WebView's layout viewport inside the real system-bar area. Applying
        // padding directly to WebView can leave its CSS viewport edge-to-edge on some
        // Samsung and Motorola WebView builds even though the pixels look inset.
        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(Color.rgb(3, 11, 16));
        container.addView(webView);
        webViewContainer = container;
        ViewCompat.setOnApplyWindowInsetsListener(container, (view, windowInsets) -> {
            Insets insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            view.setPadding(insets.left, insets.top, insets.right, insets.bottom);
            return windowInsets;
        });

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + " " + WEATHERPOWER_USER_AGENT);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        }
        CookieManager.getInstance().setAcceptCookie(true);

        assetLoader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();

        webView.addJavascriptInterface(new WeatherPowerBridge(), "WeatherPowerAndroid");
        webView.setWebViewClient(new WeatherPowerWebViewClient());
        webView.setWebChromeClient(new WeatherPowerChromeClient());
        setContentView(container);
        ViewCompat.requestApplyInsets(container);
        if (isTelevision) webView.requestFocus();
    }

    private void requestBasePermissions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;

        List<String> permissions = new ArrayList<>();
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (!isTelevision && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.CAMERA);
        }

        if (!permissions.isEmpty()) {
            requestPermissions(permissions.toArray(new String[0]), PERMISSION_REQUEST_CODE);
        }
    }

    private boolean hasLocationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasCameraPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasNotificationPermission()) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATION_PERMISSION_REQUEST_CODE);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_REQUEST_CODE && pendingGeolocationCallback != null) {
            pendingGeolocationCallback.invoke(pendingGeolocationOrigin, hasLocationPermission(), false);
            pendingGeolocationCallback = null;
            pendingGeolocationOrigin = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && intent.getBooleanExtra("openRadar", false)) {
            String alertId = intent.getStringExtra("alertId");
            String js = "window.openWeatherPowerRadarAlert && window.openWeatherPowerRadarAlert(\""
                + escapeJson(alertId == null ? "" : alertId) + "\");";
            mainHandler.postDelayed(() -> {
                if (webView != null) webView.evaluateJavascript(js, null);
            }, 250);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST_CODE || fileUploadCallback == null) return;

        Uri[] results = null;
        if (resultCode == RESULT_OK) {
            results = collectFileChooserResults(data);
        }

        fileUploadCallback.onReceiveValue(results);
        fileUploadCallback = null;
        cameraPhotoUri = null;
    }

    private Uri[] collectFileChooserResults(Intent data) {
        if (data == null || (data.getData() == null && data.getClipData() == null)) {
            return cameraPhotoUri == null ? null : new Uri[] { cameraPhotoUri };
        }

        if (data.getClipData() != null) {
            ClipData clipData = data.getClipData();
            Uri[] uris = new Uri[clipData.getItemCount()];
            for (int i = 0; i < clipData.getItemCount(); i++) {
                uris[i] = clipData.getItemAt(i).getUri();
            }
            return uris;
        }

        Uri uri = data.getData();
        return uri == null ? null : new Uri[] { uri };
    }

    private Intent createCameraIntent() {
        if (!hasCameraPermission()) return null;
        Intent cameraIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (cameraIntent.resolveActivity(getPackageManager()) == null) return null;

        try {
            File photoFile = createImageFile();
            cameraPhotoUri = FileProvider.getUriForFile(
                this,
                getPackageName() + ".fileprovider",
                photoFile
            );
            cameraIntent.putExtra(MediaStore.EXTRA_OUTPUT, cameraPhotoUri);
            cameraIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            return cameraIntent;
        } catch (IOException error) {
            cameraPhotoUri = null;
            return null;
        }
    }

    private File createImageFile() throws IOException {
        String timestamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
        File storageDir = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
        return File.createTempFile("WeatherPower_" + timestamp + "_", ".jpg", storageDir);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            NOTIFICATION_CHANNEL_NAME,
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("WeatherPower severe weather, rain, and forecast notifications");
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private void showWeatherNotification(String title, String body, String tag) {
        if (!hasNotificationPermission()) {
            requestNotificationPermissionIfNeeded();
            return;
        }

        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intent, flags);

        String safeTitle = title == null || title.trim().isEmpty() ? "WeatherPower Alert" : title.trim();
        String safeBody = body == null || body.trim().isEmpty() ? "Tap to open WeatherPower." : body.trim();
        int notificationId = Math.abs((tag == null || tag.isEmpty() ? safeTitle : tag).hashCode());

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_weatherpower)
            .setLargeIcon(BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher))
            .setColor(Color.rgb(94, 231, 255))
            .setContentTitle(safeTitle)
            .setContentText(safeBody)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(safeBody))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent);

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(notificationId, builder.build());
    }

    private void handleBackNavigation() {
        if (webView == null) {
            finish();
            return;
        }
        // Give the page a chance to close sheets, zoom the TV radar out, or step back a TV screen.
        webView.evaluateJavascript("(function(){try{return !!(window.wpHandleBack&&window.wpHandleBack());}catch(e){return false;}})()", value -> {
            if ("true".equals(value)) return;
            if (webView != null && webView.canGoBack()) {
                webView.goBack();
            } else {
                finish();
            }
        });
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (isTelevision && webView != null && event.getAction() == KeyEvent.ACTION_DOWN) {
            String key = null;
            switch (event.getKeyCode()) {
                case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                case KeyEvent.KEYCODE_MEDIA_PLAY:
                case KeyEvent.KEYCODE_MEDIA_PAUSE:
                    key = "playpause";
                    break;
                case KeyEvent.KEYCODE_MENU:
                    key = "menu";
                    break;
                case KeyEvent.KEYCODE_CHANNEL_UP:
                case KeyEvent.KEYCODE_PAGE_UP:
                    key = "zoomin";
                    break;
                case KeyEvent.KEYCODE_CHANNEL_DOWN:
                case KeyEvent.KEYCODE_PAGE_DOWN:
                    key = "zoomout";
                    break;
                case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                    key = "next";
                    break;
                case KeyEvent.KEYCODE_MEDIA_REWIND:
                    key = "prev";
                    break;
                default:
                    break;
            }
            if (key != null) {
                webView.evaluateJavascript("window.wpTvKey && window.wpTvKey(\"" + key + "\");", null);
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    private void registerPredictiveBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            predictiveBackCallback = Api33BackNavigation.register(this, this::handleBackNavigation);
        }
    }

    private void unregisterPredictiveBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && predictiveBackCallback != null) {
            Api33BackNavigation.unregister(this, predictiveBackCallback);
            predictiveBackCallback = null;
        }
    }

    @Override
    protected void onDestroy() {
        unregisterPredictiveBack();
        networkExecutor.shutdownNow();
        if (webView != null) {
            webView.removeJavascriptInterface("WeatherPowerAndroid");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        handleBackNavigation();
    }

    @TargetApi(Build.VERSION_CODES.TIRAMISU)
    private static final class Api33BackNavigation {
        private Api33BackNavigation() {}

        static Object register(Activity activity, Runnable action) {
            OnBackInvokedCallback callback = action::run;
            activity.getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                callback
            );
            return callback;
        }

        static void unregister(Activity activity, Object callback) {
            activity.getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(
                (OnBackInvokedCallback) callback
            );
        }
    }

    private String escapeJson(String value) {
        if (value == null) return "";
        return value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t");
    }

    private String readStream(InputStream stream) throws IOException {
        if (stream == null) return "";
        byte[] buffer = new byte[8192];
        StringBuilder builder = new StringBuilder();
        int read;
        while ((read = stream.read(buffer)) != -1) {
            builder.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
        }
        return builder.toString();
    }

    private String httpGetString(String urlString) {
        HttpURLConnection connection = null;
        try {
            if (urlString == null || !urlString.startsWith("https://")) {
                return "{\"__wpError\":\"Only HTTPS requests are allowed\"}";
            }
            URL url = new URL(urlString);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(16000);
            connection.setUseCaches(false);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Accept", "application/geo+json, application/json, text/plain, */*");
            connection.setRequestProperty("User-Agent", WEATHERPOWER_USER_AGENT);
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            String body = readStream(stream);
            if (status < 200 || status >= 300) {
                return "{\"__wpError\":\"HTTP " + status + " " + escapeJson(body) + "\"}";
            }
            return body == null || body.isEmpty() ? "{}" : body;
        } catch (Exception error) {
            return "{\"__wpError\":\"" + escapeJson(error.getMessage()) + "\"}";
        } finally {
            if (connection != null) connection.disconnect();
        }
    }


    private String httpPostJsonString(String urlString, String jsonBody) {
        HttpURLConnection connection = null;
        try {
            if (urlString == null || !urlString.startsWith("https://")) {
                return "{\"__wpError\":\"Only HTTPS requests are allowed\"}";
            }
            URL url = new URL(urlString);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(18000);
            connection.setUseCaches(false);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Accept", "application/json, text/plain, */*");
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("User-Agent", WEATHERPOWER_USER_AGENT);
            byte[] bytes = (jsonBody == null ? "{}" : jsonBody).getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            String body = readStream(stream);
            if (status < 200 || status >= 300) {
                return "{\"__wpError\":\"HTTP " + status + " " + escapeJson(body) + "\"}";
            }
            return body == null || body.isEmpty() ? "{}" : body;
        } catch (Exception error) {
            return "{\"__wpError\":\"" + escapeJson(error.getMessage()) + "\"}";
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String firebaseAnonymousIdToken() throws Exception {
        String url = "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + URLEncoder.encode(FIREBASE_CONFIG_API_KEY, "UTF-8");
        String response = httpPostJsonString(url, "{\"returnSecureToken\":true}");
        JSONObject json = new JSONObject(response);
        if (json.has("__wpError")) throw new IllegalStateException(json.optString("__wpError", "Firebase auth failed"));
        String token = json.optString("idToken", "");
        if (token.isEmpty()) throw new IllegalStateException("Firebase auth token was empty");
        return token;
    }

    private String submitSuggestionToFirebase(String payloadJson) {
        try {
            JSONObject input = new JSONObject(payloadJson == null || payloadJson.trim().isEmpty() ? "{}" : payloadJson);
            JSONObject payload = new JSONObject();
            long now = System.currentTimeMillis();

            payload.put("name", cleanSuggestionString(input.optString("name", "Anonymous"), 80, "Anonymous"));
            String email = cleanSuggestionString(input.optString("email", ""), 160, "");
            if (!email.isEmpty()) payload.put("email", email);
            payload.put("type", cleanSuggestionString(input.optString("type", "Feature idea"), 80, "Feature idea"));
            payload.put("message", cleanSuggestionString(input.optString("message", ""), 3000, ""));
            payload.put("status", "pending");
            payload.put("t", input.has("t") ? input.optLong("t", now) : now);
            Object createdAt = input.opt("createdAt");
            if (createdAt instanceof Number) payload.put("createdAt", createdAt);
            else payload.put("createdAt", cleanSuggestionString(String.valueOf(createdAt == null || createdAt == JSONObject.NULL ? new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.US).format(new Date()) : createdAt), 80, String.valueOf(now)));
            payload.put("source", cleanSuggestionString(input.optString("source", "WeatherPower Android app suggestions page"), 120, "WeatherPower Android app"));
            payload.put("page", cleanSuggestionString(input.optString("page", "weatherpower-android-app"), 120, "weatherpower-android-app"));
            String userAgent = cleanSuggestionString(input.optString("userAgent", "WeatherPower Android app"), 500, "WeatherPower Android app");
            if (!userAgent.isEmpty()) payload.put("userAgent", userAgent);

            if (payload.optString("message", "").trim().isEmpty()) {
                return "{\"ok\":false,\"error\":\"Suggestion message was empty.\"}";
            }

            // siteSuggestions rules allow brand-new pending suggestions without an auth token.
            // Keep this payload EXACTLY inside the database rule allowlist so validation does not reject it.
            String dbUrl = "https://weatherpower-54c84-default-rtdb.firebaseio.com/siteSuggestions.json";
            String response = httpPostJsonString(dbUrl, payload.toString());
            JSONObject json = new JSONObject(response);
            if (json.has("__wpError")) {
                return "{\"ok\":false,\"error\":\"" + escapeJson(json.optString("__wpError", "Permission denied")) + "\"}";
            }
            return "{\"ok\":true,\"name\":\"" + escapeJson(json.optString("name", "")) + "\"}";
        } catch (Exception error) {
            return "{\"ok\":false,\"error\":\"" + escapeJson(error.getMessage()) + "\"}";
        }
    }

    private static String cleanSuggestionString(String value, int maxLength, String fallback) {
        String text = value == null ? "" : value.trim();
        if (text.isEmpty()) text = fallback == null ? "" : fallback.trim();
        text = text.replace('\r', ' ').replace('\n', ' ').replaceAll("\\s+", " " ).trim();
        if (text.length() > maxLength) text = text.substring(0, maxLength).trim();
        return text;
    }

    private class WeatherPowerBridge {
        @JavascriptInterface
        public String getAppBuildInfo() {
            try {
                JSONObject info = new JSONObject();
                info.put("versionName", BuildConfig.VERSION_NAME.replace("-dev", "").replace("-debug", ""));
                info.put("versionCode", BuildConfig.VERSION_CODE);
                info.put("release", true);
                return info.toString();
            } catch (Exception error) {
                return "{}";
            }
        }

        @JavascriptInterface
        public boolean isTelevision() {
            return isTelevision;
        }

        @JavascriptInterface
        public void setKeepScreenOn(boolean keepOn) {
            runOnUiThread(() -> {
                if (keepOn) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public String fetchUrl(String url) {
            return MainActivity.this.httpGetString(url);
        }

        @JavascriptInterface
        public void fetchUrlAsync(String url, String callbackId) {
            final String safeCallbackId = callbackId == null ? "" : callbackId;
            networkExecutor.execute(() -> {
                final String body = MainActivity.this.httpGetString(url);
                final String js = "window.__weatherPowerNativeFetchComplete && window.__weatherPowerNativeFetchComplete(\""
                    + escapeJson(safeCallbackId)
                    + "\",\""
                    + escapeJson(body)
                    + "\");";
                mainHandler.post(() -> {
                    if (webView != null) webView.evaluateJavascript(js, null);
                });
            });
        }

        @JavascriptInterface
        public boolean supportsNotifications() {
            return true;
        }

        @JavascriptInterface
        public boolean hasNotificationPermission() {
            return MainActivity.this.hasNotificationPermission();
        }

        @JavascriptInterface
        public void requestNotificationPermission() {
            runOnUiThread(() -> requestNotificationPermissionIfNeeded());
        }

        @JavascriptInterface
        public void showWeatherNotification(String title, String body, String tag) {
            runOnUiThread(() -> MainActivity.this.showWeatherNotification(title, body, tag));
        }

        @JavascriptInterface
        public void setRainNotificationsEnabled(boolean enabled, double latitude, double longitude, String locationName) {
            runOnUiThread(() -> {
                if (enabled) requestNotificationPermissionIfNeeded();
                RainCheckReceiver.setEnabled(MainActivity.this, enabled, latitude, longitude, locationName);
            });
        }

        @JavascriptInterface
        public void updateForecastSnapshot(double latitude, double longitude, String locationName, double temperature, String summary, double rainChance, double high, double low) {
            runOnUiThread(() -> {
                WeatherPowerData.saveSnapshot(MainActivity.this, latitude, longitude, locationName, temperature, summary, rainChance, high, low);
                WeatherPowerForecastWidgetProvider.refreshAll(MainActivity.this);
                WeatherPowerRainWidgetProvider.refreshAll(MainActivity.this);
            });
        }

        @JavascriptInterface
        public boolean supportsForecastWidgets() {
            return true;
        }

        @JavascriptInterface
        public boolean supportsNativeShare() {
            return true;
        }

        @JavascriptInterface
        public void shareWeather(String title, String text) {
            final String safeTitle = cleanSuggestionString(title, 120, "WeatherPower forecast");
            final String safeText = cleanSuggestionString(text, 2000, "WeatherPower weather update");
            runOnUiThread(() -> {
                Intent shareIntent = new Intent(Intent.ACTION_SEND);
                shareIntent.setType("text/plain");
                shareIntent.putExtra(Intent.EXTRA_SUBJECT, safeTitle);
                shareIntent.putExtra(Intent.EXTRA_TEXT, safeText);
                startActivity(Intent.createChooser(shareIntent, "Share WeatherPower forecast"));
            });
        }

        @JavascriptInterface
        public boolean supportsNativeSuggestions() {
            return true;
        }

        @JavascriptInterface
        public void submitSuggestion(String payloadJson, String callbackId) {
            final String safeCallbackId = callbackId == null ? "" : callbackId;
            networkExecutor.execute(() -> {
                final String result = MainActivity.this.submitSuggestionToFirebase(payloadJson);
                final String js = "window.__weatherPowerSuggestionComplete && window.__weatherPowerSuggestionComplete(\""
                    + escapeJson(safeCallbackId)
                    + "\","
                    + result
                    + ");";
                mainHandler.post(() -> {
                    if (webView != null) webView.evaluateJavascript(js, null);
                });
            });
        }
    }

    private class WeatherPowerChromeClient extends WebChromeClient {
        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            if (hasLocationPermission()) {
                callback.invoke(origin, true, false);
                return;
            }

            pendingGeolocationOrigin = origin;
            pendingGeolocationCallback = callback;
            requestBasePermissions();
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                request.grant(request.getResources());
            }
        }

        @Override
        public boolean onShowFileChooser(
            WebView webView,
            ValueCallback<Uri[]> filePathCallback,
            WebChromeClient.FileChooserParams fileChooserParams
        ) {
            if (fileUploadCallback != null) {
                fileUploadCallback.onReceiveValue(null);
            }
            fileUploadCallback = filePathCallback;

            boolean imagesOnly = acceptsOnlyImages(fileChooserParams);
            Intent contentIntent = new Intent(Intent.ACTION_GET_CONTENT);
            contentIntent.addCategory(Intent.CATEGORY_OPENABLE);
            contentIntent.setType(imagesOnly ? "image/*" : "*/*");
            contentIntent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);

            Intent cameraIntent = imagesOnly ? createCameraIntent() : null;
            Intent chooserIntent = new Intent(Intent.ACTION_CHOOSER);
            chooserIntent.putExtra(Intent.EXTRA_INTENT, contentIntent);
            chooserIntent.putExtra(Intent.EXTRA_TITLE, imagesOnly ? "WeatherPower photo" : "WeatherPower file");
            if (cameraIntent != null) {
                chooserIntent.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] { cameraIntent });
            }

            try {
                startActivityForResult(chooserIntent, FILE_CHOOSER_REQUEST_CODE);
                return true;
            } catch (Exception error) {
                fileUploadCallback = null;
                return false;
            }
        }
    }

    private static boolean acceptsOnlyImages(WebChromeClient.FileChooserParams params) {
        if (params == null || params.getAcceptTypes() == null) return true;
        // No accept attribute keeps the original photo picker; anything non-image (e.g. .pal) opens all files.
        for (String type : params.getAcceptTypes()) {
            if (type == null) continue;
            for (String part : type.split(",")) {
                String t = part.trim().toLowerCase(Locale.US);
                if (!t.isEmpty() && !t.startsWith("image/")) return false;
            }
        }
        return true;
    }

    private class WeatherPowerWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri == null || !request.isForMainFrame() || "appassets.androidplatform.net".equals(uri.getHost())) return false;
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
            if (!scheme.equals("http") && !scheme.equals("https") && !scheme.equals("mailto") && !scheme.equals("tel")) return true;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            } catch (Exception error) {
                // Android TV often has no browser; fall back to showing the page in the WebView (Back returns).
                return false;
            }
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return assetLoader.shouldInterceptRequest(request.getUrl());
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
            return assetLoader.shouldInterceptRequest(Uri.parse(url));
        }
    }
}
