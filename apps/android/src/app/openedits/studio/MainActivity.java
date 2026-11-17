package app.openedits.studio;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.text.InputType;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * A window onto OpenEdits Studio. The editor itself (engine, FFmpeg, compositor) runs in the
 * Googlebook's Linux Terminal, started with `openedits-web`; this app shows its page, and gives it
 * what a browser tab would: a file picker for imports, the microphone for voiceovers, and a place
 * to save exports (the Downloads folder).
 */
public class MainActivity extends Activity {
    private static final String TAG = "OpenEdits";
    private static final String DEFAULT_ADDRESS = "http://localhost:4417/";
    private static final int PICK_FILES = 1;
    private static final int ASK_MICROPHONE = 2;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private WebView web;
    private ScrollView setup;
    private TextView message;
    private EditText link;
    private ValueCallback<Uri[]> chooser;
    private PermissionRequest microphoneRequest;
    /** Set while the page being loaded has failed, so its "finished" event does not reveal an error page. */
    private boolean failed;
    private int probes;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("openedits", MODE_PRIVATE);

        FrameLayout root = new FrameLayout(this);
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(Color.parseColor("#0d0e11"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0d0e11"));
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setup = buildSetupScreen();
        root.addView(setup, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        configureWebView();
        if (state != null && web.restoreState(state) != null) {
            showEditor();
            return;
        }
        if (!openFromIntent(getIntent())) open(address());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openFromIntent(intent);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }

    // ---- Where the editor is ------------------------------------------------------------------

    /** The editor's address without the sign-in token, e.g. http://localhost:4417/ */
    private String address() {
        return prefs.getString("address", DEFAULT_ADDRESS);
    }

    /** Only this device's loopback is ever shown in the app. */
    private static boolean isEditor(Uri uri) {
        if (uri == null || !"http".equals(uri.getScheme())) return false;
        String host = uri.getHost();
        return "localhost".equals(host) || "127.0.0.1".equals(host);
    }

    private boolean openFromIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || !isEditor(intent.getData())) return false;
        open(intent.getData().toString());
        return true;
    }

    private void open(String url) {
        Uri uri = Uri.parse(url.trim());
        if (!isEditor(uri)) {
            showSetup("That is not the editor's link. It starts with http://localhost: and is printed in the Terminal by openedits-web.");
            return;
        }
        String base = "http://" + uri.getHost() + (uri.getPort() > 0 ? ":" + uri.getPort() : "") + "/";
        prefs.edit().putString("address", base).apply();
        failed = false;
        probes = 0;
        handler.removeCallbacksAndMessages(null);
        Log.i(TAG, "opening " + base);
        web.loadUrl(uri.toString());
    }

    // ---- The page -----------------------------------------------------------------------------

    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        CookieManager.getInstance().setAcceptCookie(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (isEditor(request.getUrl())) return false;
                // Anything else belongs in the browser.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                } catch (ActivityNotFoundException e) {
                    /* nothing to open it with */
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                failed = true;
                Log.i(TAG, "editor unreachable: " + error.getDescription());
                showSetup("The editor is not running yet.\n\nOpen the Terminal app, run openedits-web and leave it open. Then press Try again.");
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (!request.isForMainFrame()) return;
                failed = true;
                Log.i(TAG, "editor answered " + response.getStatusCode());
                showSetup(response.getStatusCode() == 401
                        ? "The editor is running, but this app has not been signed in to it yet.\n\nCopy the link that openedits-web printed in the Terminal (it ends in ?token=…), paste it below and press Open. You only do this once."
                        : "The editor answered with an error (" + response.getStatusCode() + "). Press Try again, or restart openedits-web in the Terminal.");
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                if (failed) return;
                showEditor();
                probe();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (chooser != null) chooser.onReceiveValue(null);
                chooser = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(pick, PICK_FILES);
                } catch (ActivityNotFoundException e) {
                    chooser = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        boolean wantsMicrophone = false;
                        for (String r : request.getResources()) wantsMicrophone |= PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r);
                        if (!wantsMicrophone || !isEditor(request.getOrigin())) {
                            request.deny();
                        } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                        } else {
                            microphoneRequest = request;
                            requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, ASK_MICROPHONE);
                        }
                    }
                });
            }
        });

        // Exports: the page's Download button.
        web.setDownloadListener(new android.webkit.DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String disposition, String mime, long length) {
                saveToDownloads(url);
            }
        });
    }

    /** Logs whether the page reached the engine (also what the emulator test in CI waits for). */
    private void probe() {
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript(
                        "(function(){try{var c=document.createElement('canvas');return JSON.stringify({connected:!!(window.openedits&&window.openedits.live.state.connected),screen:(window.openedits&&window.openedits.live.state.appState||{}).screen||null,webgl2:!!c.getContext('webgl2')})}catch(e){return String(e)}})()",
                        new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                Log.i(TAG, "editor state " + value);
                                if ((value == null || !value.contains("connected\\\":true")) && ++probes < 30) probe();
                            }
                        });
            }
        }, 1000);
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_FILES || chooser == null) return;
        Uri[] files = null;
        if (result == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                files = new Uri[clip.getItemCount()];
                for (int i = 0; i < files.length; i++) files[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                files = new Uri[] {data.getData()};
            }
        }
        chooser.onReceiveValue(files);
        chooser = null;
    }

    @Override
    public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request != ASK_MICROPHONE || microphoneRequest == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) microphoneRequest.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        else microphoneRequest.deny();
        microphoneRequest = null;
    }

    @Override
    public void onBackPressed() {
        // The editor is one page: Back should not unload it by accident. Leave with the window's own controls.
        if (setup.getVisibility() == View.VISIBLE) super.onBackPressed();
    }

    // ---- Saving an export -----------------------------------------------------------------------

    private void saveToDownloads(final String url) {
        final Uri source = Uri.parse(url);
        if (!isEditor(source)) return;
        String path = source.getQueryParameter("path");
        final String name = path == null || path.isEmpty() ? "OpenEdits export.mp4" : path.substring(path.lastIndexOf('/') + 1);
        final String cookie = CookieManager.getInstance().getCookie(url);
        Toast.makeText(this, "Saving " + name + " to Downloads…", Toast.LENGTH_SHORT).show();
        new Thread(new Runnable() {
            @Override
            public void run() {
                Uri target = null;
                String problem = null;
                try {
                    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                    if (cookie != null) conn.setRequestProperty("Cookie", cookie);
                    if (conn.getResponseCode() != 200) throw new java.io.IOException("the editor answered " + conn.getResponseCode());
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    String type = conn.getContentType();
                    if (type != null) values.put(MediaStore.MediaColumns.MIME_TYPE, type.split(";")[0].trim());
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    target = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (target == null) throw new java.io.IOException("Downloads is not available");
                    long total = 0;
                    try (InputStream in = conn.getInputStream(); OutputStream out = getContentResolver().openOutputStream(target)) {
                        byte[] buffer = new byte[1 << 16];
                        for (int n; (n = in.read(buffer)) > 0; total += n) out.write(buffer, 0, n);
                    }
                    ContentValues done = new ContentValues();
                    done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    getContentResolver().update(target, done, null, null);
                    Log.i(TAG, "saved " + name + " (" + total + " bytes)");
                } catch (Exception e) {
                    problem = e.getMessage();
                    Log.w(TAG, "could not save " + name, e);
                    if (target != null) getContentResolver().delete(target, null, null);
                }
                final String text = problem == null ? "Saved " + name + " to Downloads" : "Could not save " + name + ": " + problem;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, text, Toast.LENGTH_LONG).show();
                    }
                });
            }
        }).start();
    }

    // ---- The "start the editor" screen --------------------------------------------------------

    private void showEditor() {
        setup.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
    }

    private void showSetup(String text) {
        handler.removeCallbacksAndMessages(null);
        message.setText(text);
        web.setVisibility(View.INVISIBLE);
        setup.setVisibility(View.VISIBLE);
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    private ScrollView buildSetupScreen() {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(dp(28), dp(36), dp(28), dp(36));

        TextView title = new TextView(this);
        title.setText("OpenEdits Studio");
        title.setTextColor(Color.parseColor("#e9ebef"));
        title.setTextSize(26);
        column.addView(title);

        message = new TextView(this);
        message.setTextColor(Color.parseColor("#b6bac4"));
        message.setTextSize(16);
        message.setLineSpacing(dp(4), 1f);
        message.setPadding(0, dp(14), 0, dp(18));
        column.addView(message);

        link = new EditText(this);
        link.setHint("http://localhost:4417/?token=…");
        link.setSingleLine(true);
        link.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        link.setTextColor(Color.parseColor("#e9ebef"));
        link.setHintTextColor(Color.parseColor("#6d7280"));
        column.addView(link, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setPadding(0, dp(12), 0, 0);
        Button openLink = new Button(this);
        openLink.setText("Open");
        openLink.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String text = link.getText().toString().trim();
                if (text.isEmpty()) open(address());
                else open(text);
            }
        });
        buttons.addView(openLink);
        Button retry = new Button(this);
        retry.setText("Try again");
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                open(address());
            }
        });
        buttons.addView(retry);
        column.addView(buttons);

        TextView help = new TextView(this);
        help.setText("This app is the window. The editor itself runs in the Linux Terminal: install the OpenEdits Studio .deb there once (sudo apt install ./OpenEdits-Studio-*.deb), then run openedits-web whenever you want to edit.");
        help.setTextColor(Color.parseColor("#6d7280"));
        help.setTextSize(13);
        help.setLineSpacing(dp(3), 1f);
        help.setPadding(0, dp(28), 0, 0);
        column.addView(help);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.parseColor("#0d0e11"));
        LinearLayout holder = new LinearLayout(this);
        holder.setGravity(Gravity.CENTER_HORIZONTAL);
        holder.addView(column, new LinearLayout.LayoutParams(Math.min(dp(640), getResources().getDisplayMetrics().widthPixels), ViewGroup.LayoutParams.WRAP_CONTENT));
        scroll.addView(holder);
        scroll.setVisibility(View.GONE);
        return scroll;
    }
}
