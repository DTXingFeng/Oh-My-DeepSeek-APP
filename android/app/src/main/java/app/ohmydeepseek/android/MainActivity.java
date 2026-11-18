package app.ohmydeepseek.android;

import android.app.Activity;
import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLConnection;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String HOST = "app.ohmydeepseek.local";
    private static final String HOME = "https://" + HOST + "/index.html";
    private static final int PICK_FILE = 101;
    private static final int SAVE_FILE = 102;
    private static final int AUDIO_PERMISSION = 103;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Object exportLock = new Object();
    private WebView web;
    private SecureKeyStore keys;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest audioRequest;
    private File exportFile;
    private OutputStream exportStream;
    private String exportName;
    private String exportMime;
    private boolean exportReady;
    private Boolean pageDark;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        keys = new SecureKeyStore(this);
        FrameLayout root = new FrameLayout(this);
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(Color.WHITE);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        updateSystemBars();
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        // Content URIs come exclusively from Android's document picker.
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(false);
        settings.setUserAgentString(settings.getUserAgentString() + " OhMyDeepSeek/" + BuildConfig.VERSION_NAME);
        web.addJavascriptInterface(new AndroidBridge(), "OhMyDeepSeekAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!HOST.equals(uri.getHost())) return null;
                if (!isLocal(uri)) return response(403, "Forbidden", "text/plain", new byte[0]);
                String path = uri.getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                if (path.contains("..") || path.contains("\\")) return response(403, "Forbidden", "text/plain", new byte[0]);
                try {
                    InputStream input = getAssets().open("web" + path);
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Cache-Control", "no-cache");
                    headers.put("X-Content-Type-Options", "nosniff");
                    return new WebResourceResponse(mime(path), "UTF-8", 200, "OK", headers, input);
                } catch (IOException error) {
                    return response(404, "Not Found", "text/plain", new byte[0]);
                }
            }

            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (isLocal(request.getUrl())) return false;
                openExternal(request.getUrl().toString());
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                picker.setType("*/*");
                String[] mimes = Arrays.stream(params.getAcceptTypes())
                        .flatMap(value -> Arrays.stream(value.split(",")))
                        .map(String::trim)
                        .filter(type -> type.matches("[a-zA-Z0-9!#$&^_.+*-]+/[a-zA-Z0-9!#$&^_.+*-]+"))
                        .distinct().toArray(String[]::new);
                if (mimes.length > 0) picker.putExtra(Intent.EXTRA_MIME_TYPES, mimes);
                picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(picker, PICK_FILE); }
                catch (ActivityNotFoundException error) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                    toast("设备没有可用的文件选择器");
                }
                return true;
            }

            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (!isLocal(request.getOrigin()) || audioRequest != null ||
                            !Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                        request.deny();
                        return;
                    }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                    } else {
                        audioRequest = request;
                        requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, AUDIO_PERMISSION);
                    }
                });
            }

            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                runOnUiThread(() -> { if (audioRequest == request) audioRequest = null; });
            }
        });
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> openExternal(url));
        web.loadUrl(HOME);
    }

    private static boolean isLocal(Uri uri) {
        return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost()) &&
                (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null;
    }

    private static String mime(String path) {
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".woff2")) return "font/woff2";
        String guessed = URLConnection.guessContentTypeFromName(path);
        return guessed == null ? "application/octet-stream" : guessed;
    }

    private static WebResourceResponse response(int status, String reason, String mime, byte[] bytes) {
        return new WebResourceResponse(mime, "UTF-8", status, reason, Collections.emptyMap(), new ByteArrayInputStream(bytes));
    }

    private void toast(String message) {
        runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_LONG).show());
    }

    private void openExternal(String value) {
        Uri uri = Uri.parse(value);
        if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) return;
        runOnUiThread(() -> {
            try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
            catch (ActivityNotFoundException error) { toast("设备没有可用的浏览器"); }
        });
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == AUDIO_PERMISSION && audioRequest != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                audioRequest.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            } else audioRequest.deny();
            audioRequest = null;
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent intent) {
        super.onActivityResult(requestCode, resultCode, intent);
        if (requestCode == PICK_FILE && fileCallback != null) {
            ValueCallback<Uri[]> callback = fileCallback;
            fileCallback = null;
            callback.onReceiveValue(pickedFiles(resultCode, intent));
        } else if (requestCode == SAVE_FILE) {
            Uri destination = intent == null ? null : intent.getData();
            boolean cancelled = resultCode != RESULT_OK || destination == null;
            io.execute(() -> {
                boolean ok = false;
                if (!cancelled) {
                    synchronized (exportLock) {
                        try (InputStream input = new FileInputStream(exportFile);
                             OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
                            if (output == null) throw new IOException("No destination stream");
                            byte[] buffer = new byte[64 * 1024];
                            int length;
                            while ((length = input.read(buffer)) != -1) output.write(buffer, 0, length);
                            output.flush();
                            ok = true;
                        } catch (Exception error) { /* Report failure without logging private data. */ }
                    }
                }
                clearExport();
                reportExport(ok, cancelled);
            });
        }
    }

    private static Uri[] pickedFiles(int resultCode, Intent intent) {
        if (resultCode != RESULT_OK || intent == null) return null;
        LinkedHashSet<Uri> selected = new LinkedHashSet<>();
        // Some document providers use ClipData even when the user selects one file.
        ClipData clip = intent.getClipData();
        if (clip != null) {
            for (int index = 0; index < clip.getItemCount(); index++) {
                Uri uri = clip.getItemAt(index).getUri();
                if (uri != null) selected.add(uri);
            }
        }
        Uri data = intent.getData();
        if (data != null) selected.add(data);
        return selected.isEmpty() ? null : selected.toArray(new Uri[0]);
    }

    private void reportExport(boolean ok, boolean cancelled) {
        runOnUiThread(() -> {
            if (!isFinishing() && !isDestroyed()) web.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('ohmydeepseek-export-result',{detail:{ok:"
                            + ok + ",cancelled:" + cancelled + "}}))", null);
        });
    }

    private void clearExport() {
        synchronized (exportLock) {
            if (exportStream != null) try { exportStream.close(); } catch (IOException ignored) { }
            exportStream = null;
            if (exportFile != null) exportFile.delete();
            exportFile = null;
            exportReady = false;
        }
    }

    private void updateSystemBars() {
        boolean dark = pageDark != null ? pageDark : (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        getWindow().setStatusBarColor(dark ? Color.rgb(26, 26, 26) : Color.WHITE);
        getWindow().setNavigationBarColor(dark ? Color.rgb(26, 26, 26) : Color.WHITE);
        getWindow().getDecorView().setSystemUiVisibility(dark ? 0 : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    }

    @Override public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        updateSystemBars();
    }

    @Override public void onBackPressed() {
        web.evaluateJavascript("window.ohMyDeepSeekBack ? window.ohMyDeepSeekBack() : false", handled -> {
            if (!"true".equals(handled)) {
                if (web.canGoBack()) web.goBack();
                else moveTaskToBack(true);
            }
        });
    }

    @Override protected void onPause() {
        if (audioRequest == null) web.evaluateJavascript("window.dispatchEvent(new Event('ohmydeepseek-background'))", null);
        super.onPause();
    }

    @Override protected void onDestroy() {
        if (audioRequest != null) audioRequest.deny();
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        clearExport();
        io.shutdown();
        web.removeJavascriptInterface("OhMyDeepSeekAndroid");
        web.destroy();
        super.onDestroy();
    }

    /** No arbitrary file paths, shell execution, or network requests are exposed to JavaScript. */
    private final class AndroidBridge {
        @JavascriptInterface public String readApiKey() { return keys.read(); }
        @JavascriptInterface public boolean writeApiKey(String value) { return keys.write(value); }
        @JavascriptInterface public void openExternal(String url) { MainActivity.this.openExternal(url); }
        @JavascriptInterface public void setDarkMode(boolean dark) {
            runOnUiThread(() -> { pageDark = dark; updateSystemBars(); });
        }

        @JavascriptInterface public boolean beginExport(String name, String mime) {
            synchronized (exportLock) {
                if (exportFile != null) return false;
                try {
                    exportFile = File.createTempFile("history-", ".export", getCacheDir());
                    exportStream = new FileOutputStream(exportFile);
                    exportName = name.replaceAll("[\\\\/\\p{Cntrl}]", "_");
                    exportMime = mime;
                    return true;
                } catch (Exception error) { clearExport(); return false; }
            }
        }

        @JavascriptInterface public boolean appendExport(String chunk) {
            synchronized (exportLock) {
                if (exportStream == null || chunk.length() > 128 * 1024) return false;
                try { exportStream.write(Base64.decode(chunk, Base64.DEFAULT)); return true; }
                catch (Exception error) { clearExport(); return false; }
            }
        }

        @JavascriptInterface public void finishExport() {
            synchronized (exportLock) {
                if (exportStream == null || exportReady) { reportExport(false, false); return; }
                try { exportStream.close(); exportStream = null; exportReady = true; }
                catch (IOException error) { clearExport(); reportExport(false, false); return; }
            }
            runOnUiThread(() -> {
                Intent picker = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType(exportMime).putExtra(Intent.EXTRA_TITLE, exportName);
                try { startActivityForResult(picker, SAVE_FILE); }
                catch (ActivityNotFoundException error) { clearExport(); reportExport(false, false); }
            });
        }

        @JavascriptInterface public void cancelExport() { clearExport(); }
    }
}
