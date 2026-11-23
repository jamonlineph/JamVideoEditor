package app.openedits.studio;

import android.Manifest;
import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * OpenEdits Studio for Android and Googlebooks. Everything runs on the device: {@link Engine}
 * starts the editor's engine (Node.js, FFmpeg) and this activity shows its page in a WebView. A
 * second WebView, kept behind the first, runs the compositor the engine draws previews and exports
 * with (the job a hidden Electron window does on desktops).
 */
public class MainActivity extends Activity implements Engine.Listener {
    private static final String TAG = Engine.TAG;
    private static final int PICK_FILES = 1;
    private static final int ASK_MICROPHONE = 2;
    private static final int BG = Color.parseColor("#0b0c10");
    private static final int TEXT = Color.parseColor("#eef0f4");
    private static final int MUTED = Color.parseColor("#9aa0ad");
    private static final int ACCENT = Color.parseColor("#ff4d6a");

    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    private WebView renderer;
    private View splash;
    private TextView status;
    private ProgressBar spinner;
    private View errorPanel;
    private TextView errorText;
    private TextView errorLog;
    private ValueCallback<Uri[]> chooser;
    private PermissionRequest microphoneRequest;
    private Engine engine;
    private int port;
    private String token;
    private boolean editorShown;
    private int probes;
    /** Files shared to the app before the editor was up. */
    private final List<Uri> pendingShares = new ArrayList<>();

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        root = new FrameLayout(this);
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(BG);
        createWebViews();
        splash = buildSplash();
        root.addView(splash, match());
        setContentView(root);

        collectShares(getIntent());
        engine = Engine.get(this);
        EngineService.start(this);
        engine.start(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        collectShares(intent);
        if (editorShown) importShares();
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        engine.setListener(null);
        destroyWebViews();
        if (isFinishing()) {
            engine.stop();
            EngineService.stop(this);
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        // The editor is one page: Back must not unload it. Leave with the window's own controls.
        if (!editorShown) super.onBackPressed();
    }

    // ---- The engine ------------------------------------------------------------------------------

    @Override
    public void onStatus(String text) {
        if (!editorShown) status.setText(text);
    }

    @Override
    public void onReady(int p, String t) {
        port = p;
        token = t;
        status.setText("Opening the editor…");
        probes = 0;
        web.loadUrl(base() + "?token=" + t);
    }

    @Override
    public void onFailed(String message) {
        Log.w(TAG, "engine failed: " + message);
        editorShown = false;
        showError(message);
    }

    private String base() {
        return "http://127.0.0.1:" + port + "/";
    }

    private boolean isEditor(Uri uri) {
        return uri != null && "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost()) && uri.getPort() == port;
    }

    // ---- The WebViews ------------------------------------------------------------------------------

    private void createWebViews() {
        renderer = new WebView(this);
        configure(renderer);
        renderer.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isEditor(request.getUrl());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) handler.postDelayed(MainActivity.this::loadRenderer, 2000);
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                return recoverFromCrash();
            }
        });
        // Behind the editor and never seen, but attached and "visible", so Android does not throttle it.
        root.addView(renderer, 0, match());

        web = new WebView(this);
        configure(web);
        web.setWebViewClient(new EditorClient());
        web.setWebChromeClient(new EditorChrome());
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> saveExport(Uri.parse(url), mime));
        web.setVisibility(View.INVISIBLE);
        root.addView(web, 1, match());
    }

    private void destroyWebViews() {
        for (WebView v : new WebView[] {web, renderer}) {
            if (v == null) continue;
            root.removeView(v);
            v.destroy();
        }
        web = null;
        renderer = null;
    }

    private void configure(WebView v) {
        v.setBackgroundColor(BG);
        WebSettings s = v.getSettings();
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
    }

    private void loadRenderer() {
        if (renderer != null && port > 0) renderer.loadUrl(base() + "render-host.html");
    }

    /** All WebViews share one renderer process: if it dies, start both pages again. */
    private boolean recoverFromCrash() {
        Log.w(TAG, "WebView renderer is gone; reloading the editor");
        destroyWebViews();
        createWebViews();
        editorShown = false;
        splash.setVisibility(View.VISIBLE);
        splash.setAlpha(1f);
        if (engine.isReady()) onReady(engine.port(), engine.token());
        return true;
    }

    private final class EditorClient extends WebViewClient {
        private boolean failed;

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (isEditor(request.getUrl())) return false;
            // Links out of the editor open in the browser.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
            } catch (ActivityNotFoundException e) {
                /* nothing to open it with */
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            failed = false;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            failed = true;
            Log.i(TAG, "editor page failed: " + error.getDescription());
            // The engine may still be binding its port: try again shortly.
            handler.postDelayed(() -> {
                if (engine.isReady()) web.loadUrl(base());
            }, 1000);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            CookieManager.getInstance().flush();
            if (failed || !isEditor(Uri.parse(url))) return;
            // Signed in (the cookie is set): now the compositor page can connect too.
            loadRenderer();
            showEditor();
            probe();
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            return recoverFromCrash();
        }
    }

    private final class EditorChrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (chooser != null) chooser.onReceiveValue(null);
            chooser = callback;
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("*/*");
            boolean subtitles = false;
            for (String type : params.getAcceptTypes()) {
                if (type != null && (type.contains("srt") || type.contains("subrip"))) subtitles = true;
            }
            pick.putExtra(Intent.EXTRA_MIME_TYPES, subtitles
                ? new String[] {"application/x-subrip", "text/plain", "application/octet-stream"}
                : new String[] {"video/*", "audio/*", "image/*", "application/octet-stream"});
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
            runOnUiThread(() -> {
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
            });
        }
    }

    /** Logs whether the page reached the engine (also what the emulator test in CI waits for). */
    private void probe() {
        handler.postDelayed(() -> {
            if (web == null) return;
            web.evaluateJavascript(
                    "(function(){try{var c=document.createElement('canvas');var l=window.openedits&&window.openedits.live;return JSON.stringify({connected:!!(l&&l.state.connected),screen:(l&&l.state.appState||{}).screen||null,webgl2:!!c.getContext('webgl2')})}catch(e){return String(e)}})()",
                    value -> {
                        Log.i(TAG, "editor state " + value);
                        boolean connected = value != null && value.contains("connected\\\":true");
                        if (connected) importShares();
                        else if (++probes < 60) probe();
                    });
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

    // ---- Files shared to the app ("Open with" / "Share") ---------------------------------------

    private void collectShares(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) pendingShares.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) pendingShares.addAll(list);
        } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null && "content".equals(intent.getData().getScheme())) {
            pendingShares.add(intent.getData());
        }
        intent.setAction(Intent.ACTION_MAIN);
    }

    /** Copy shared files into the workspace's inbox (the home screen lists it), and into the open project if there is one. */
    private void importShares() {
        if (pendingShares.isEmpty()) return;
        final List<Uri> uris = new ArrayList<>(pendingShares);
        pendingShares.clear();
        Toast.makeText(this, "Importing " + uris.size() + (uris.size() == 1 ? " file…" : " files…"), Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            final JSONArray paths = new JSONArray();
            File inbox = new File(engine.workspace(), "inbox");
            inbox.mkdirs();
            for (Uri u : uris) {
                try {
                    File target = unique(inbox, displayName(u));
                    try (InputStream in = getContentResolver().openInputStream(u); OutputStream out = new FileOutputStream(target)) {
                        copy(in, out);
                    }
                    paths.put(target.getPath());
                } catch (Exception e) {
                    Log.w(TAG, "could not import " + u, e);
                }
            }
            runOnUiThread(() -> {
                if (web == null || paths.length() == 0) return;
                web.evaluateJavascript("(function(){var l=window.openedits&&window.openedits.live;if(l&&l.state.project)l.run('importToMediaPanel',{paths:" + paths + "});})()", null);
                Toast.makeText(this, "Imported " + paths.length() + (paths.length() == 1 ? " file" : " files"), Toast.LENGTH_SHORT).show();
            });
        }).start();
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0).replaceAll("[/\\\\\\x00]", "_");
        } catch (Exception e) {
            /* fall through */
        }
        return "shared-" + System.currentTimeMillis();
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name);
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int n = 2; f.exists(); n++) f = new File(dir, stem + " (" + n + ")" + ext);
        return f;
    }

    // ---- Saving an export -----------------------------------------------------------------------

    /** The page's Download button: copy the file from the workspace to Movies (videos) or Downloads. */
    private void saveExport(Uri url, String mime) {
        if (!isEditor(url)) return;
        String path = url.getQueryParameter("path");
        if (path == null) return;
        final File file = new File(path);
        try {
            String ws = engine.workspace().getCanonicalPath() + File.separator;
            if (!file.getCanonicalPath().startsWith(ws) || !file.isFile()) {
                Toast.makeText(this, "That file is not in the editor's workspace", Toast.LENGTH_LONG).show();
                return;
            }
        } catch (java.io.IOException e) {
            return;
        }
        final String name = file.getName();
        final String type = mime != null && !mime.isEmpty() && !mime.equals("application/octet-stream") ? mime : guessType(name);
        final boolean share = "1".equals(url.getQueryParameter("share"));
        Toast.makeText(this, "Saving " + name + "…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            Uri target = null;
            String problem = null;
            String where;
            Uri collection;
            if (type.startsWith("video/")) {
                collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
                where = Environment.DIRECTORY_MOVIES + "/OpenEdits Studio";
            } else if (type.startsWith("audio/")) {
                collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
                where = Environment.DIRECTORY_MUSIC + "/OpenEdits Studio";
            } else if (type.startsWith("image/")) {
                collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                where = Environment.DIRECTORY_PICTURES + "/OpenEdits Studio";
            } else {
                collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                where = Environment.DIRECTORY_DOWNLOADS;
            }
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, type);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, where);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                target = getContentResolver().insert(collection, values);
                if (target == null) throw new java.io.IOException("the shared storage is not available");
                try (InputStream in = new FileInputStream(file); OutputStream out = getContentResolver().openOutputStream(target)) {
                    copy(in, out);
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContentResolver().update(target, done, null, null);
                Log.i(TAG, "saved " + name + " to " + where);
            } catch (Exception e) {
                problem = e.getMessage();
                Log.w(TAG, "could not save " + name, e);
                if (target != null) getContentResolver().delete(target, null, null);
            }
            final String text = problem == null ? "Saved " + name + " to " + where : "Could not save " + name + ": " + problem;
            final Uri saved = problem == null ? target : null;
            runOnUiThread(() -> {
                Toast.makeText(MainActivity.this, text, Toast.LENGTH_LONG).show();
                if (share && saved != null) {
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType(type);
                    send.putExtra(Intent.EXTRA_STREAM, saved);
                    send.setClipData(ClipData.newUri(getContentResolver(), name, saved));
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try {
                        startActivity(Intent.createChooser(send, "Share video"));
                    } catch (ActivityNotFoundException ignored) {
                        Toast.makeText(this, "No app available to share this file.", Toast.LENGTH_LONG).show();
                    }
                }
            });
        }).start();
    }

    private static String guessType(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".mp4") || n.endsWith(".m4v")) return "video/mp4";
        if (n.endsWith(".mov")) return "video/quicktime";
        if (n.endsWith(".webm")) return "video/webm";
        if (n.endsWith(".mkv")) return "video/x-matroska";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".m4a") || n.endsWith(".aac")) return "audio/mp4";
        if (n.endsWith(".wav")) return "audio/wav";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        return "application/octet-stream";
    }

    private static void copy(InputStream in, OutputStream out) throws java.io.IOException {
        byte[] buffer = new byte[1 << 16];
        for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
    }

    // ---- The start-up screen ---------------------------------------------------------------------

    private void showEditor() {
        if (editorShown) return;
        editorShown = true;
        web.setVisibility(View.VISIBLE);
        splash.animate().alpha(0f).setDuration(280).setListener(new AnimatorListenerAdapter() {
            @Override
            public void onAnimationEnd(Animator animation) {
                if (editorShown) splash.setVisibility(View.GONE);
                splash.animate().setListener(null);
            }
        }).start();
    }

    private void showError(String message) {
        splash.animate().cancel();
        splash.setAlpha(1f);
        splash.setVisibility(View.VISIBLE);
        if (web != null) web.setVisibility(View.INVISIBLE);
        spinner.setVisibility(View.GONE);
        status.setText("The editor could not start");
        errorText.setText(message);
        errorLog.setText(engine.recentLog());
        errorPanel.setVisibility(View.VISIBLE);
    }

    private void restart() {
        errorPanel.setVisibility(View.GONE);
        spinner.setVisibility(View.VISIBLE);
        status.setText("Starting the engine…");
        engine.stop();
        engine.start(this);
    }

    private View buildSplash() {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        column.setPadding(dp(28), dp(48), dp(28), dp(48));

        ImageView icon = new ImageView(this);
        icon.setImageResource(R.mipmap.ic_launcher);
        column.addView(icon, new LinearLayout.LayoutParams(dp(96), dp(96)));

        TextView title = new TextView(this);
        title.setText("OpenEdits Studio");
        title.setTextColor(TEXT);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, dp(22), 0, dp(4));
        column.addView(title);

        TextView tagline = new TextView(this);
        tagline.setText("Edit videos on this device. No account, no upload.");
        tagline.setTextColor(MUTED);
        tagline.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        tagline.setGravity(Gravity.CENTER);
        column.addView(tagline);

        spinner = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        spinner.setIndeterminate(true);
        spinner.setIndeterminateTintList(ColorStateList.valueOf(ACCENT));
        LinearLayout.LayoutParams bar = new LinearLayout.LayoutParams(dp(220), dp(6));
        bar.topMargin = dp(36);
        column.addView(spinner, bar);

        status = new TextView(this);
        status.setText("Starting…");
        status.setTextColor(MUTED);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        status.setGravity(Gravity.CENTER);
        status.setPadding(0, dp(14), 0, 0);
        column.addView(status);

        // Shown only when the engine cannot start: what happened, its last output, and a way out.
        LinearLayout error = new LinearLayout(this);
        error.setOrientation(LinearLayout.VERTICAL);
        error.setPadding(dp(18), dp(16), dp(18), dp(16));
        GradientDrawable card = new GradientDrawable();
        card.setColor(Color.parseColor("#15171e"));
        card.setCornerRadius(dp(14));
        card.setStroke(dp(1), Color.parseColor("#262a35"));
        error.setBackground(card);
        errorText = new TextView(this);
        errorText.setTextColor(TEXT);
        errorText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        error.addView(errorText);
        errorLog = new TextView(this);
        errorLog.setTextColor(MUTED);
        errorLog.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        errorLog.setTypeface(Typeface.MONOSPACE);
        errorLog.setTextIsSelectable(true);
        ScrollView logScroll = new ScrollView(this);
        logScroll.addView(errorLog);
        LinearLayout.LayoutParams logParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(180));
        logParams.topMargin = dp(10);
        error.addView(logScroll, logParams);
        LinearLayout buttons = new LinearLayout(this);
        buttons.setPadding(0, dp(12), 0, 0);
        Button retry = button("Restart the engine", true);
        retry.setOnClickListener(v -> restart());
        buttons.addView(retry);
        Button copyLog = button("Copy details", false);
        copyLog.setOnClickListener(v -> {
            ClipboardManager cm = getSystemService(ClipboardManager.class);
            cm.setPrimaryClip(ClipData.newPlainText("OpenEdits Studio log", errorText.getText() + "\n\n" + errorLog.getText()));
            Toast.makeText(this, "Copied", Toast.LENGTH_SHORT).show();
        });
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        gap.leftMargin = dp(10);
        buttons.addView(copyLog, gap);
        error.addView(buttons);
        error.setVisibility(View.GONE);
        errorPanel = error;
        LinearLayout.LayoutParams errorParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        errorParams.topMargin = dp(24);
        column.addView(error, errorParams);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundResource(R.drawable.splash_background);
        FrameLayout holder = new FrameLayout(this);
        FrameLayout.LayoutParams center = new FrameLayout.LayoutParams(Math.min(dp(560), getResources().getDisplayMetrics().widthPixels), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        holder.addView(column, center);
        scroll.addView(holder);
        return scroll;
    }

    private Button button(String label, boolean primary) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(primary ? Color.WHITE : TEXT);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(primary ? ACCENT : Color.parseColor("#232733"));
        bg.setCornerRadius(dp(10));
        b.setBackground(bg);
        b.setPadding(dp(16), 0, dp(16), 0);
        return b;
    }

    private FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }
}
