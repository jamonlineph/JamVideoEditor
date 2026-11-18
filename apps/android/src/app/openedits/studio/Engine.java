package app.openedits.studio;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.res.AssetManager;
import android.os.Handler;
import android.os.Looper;
import android.system.Os;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The editor's engine, run on this device: the bundled Node.js runs the same engine the desktop
 * apps use (projects, FFmpeg, export, the MCP server), and serves the editor's page to this app's
 * WebViews over loopback.
 *
 * The programs and libraries ship in the APK's native library folder as lib_*.so files (the only
 * files an app may execute). {@link #prepare} recreates their real names as symlinks in
 * files/runtime and unpacks the JavaScript (assets/app) to files/app when the app was updated.
 */
final class Engine {
    static final String TAG = "OpenEdits";
    private static final Pattern LINK = Pattern.compile("http://localhost:(\\d+)/\\?token=([0-9a-f]+)");
    private static final int PORT = 4417;
    private static final int LOG_LINES = 300;

    interface Listener {
        void onStatus(String text);

        void onReady(int port, String token);

        void onFailed(String message);
    }

    private static Engine instance;

    static synchronized Engine get(Context context) {
        if (instance == null) instance = new Engine(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ArrayDeque<String> log = new ArrayDeque<>();
    private Listener listener;
    private Process process;
    private Thread starter;
    private int port;
    private String token;

    private Engine(Context context) {
        this.context = context;
    }

    File workspace() {
        return new File(context.getFilesDir(), "OpenEdits");
    }

    synchronized boolean isReady() {
        return token != null && process != null && process.isAlive();
    }

    synchronized int port() {
        return port;
    }

    synchronized String token() {
        return token;
    }

    /** The engine's recent output, for the error screen. */
    synchronized String recentLog() {
        StringBuilder b = new StringBuilder();
        for (String line : log) b.append(line).append('\n');
        return b.toString();
    }

    /** Start the engine unless it is running or starting; the listener hears how it goes. */
    synchronized void start(Listener l) {
        listener = l;
        if (isReady()) {
            final int p = port;
            final String t = token;
            main.post(() -> deliverReady(p, t));
            return;
        }
        if (starter != null && starter.isAlive()) return;
        starter = new Thread(this::run, "openedits-engine-start");
        starter.start();
    }

    synchronized void setListener(Listener l) {
        listener = l;
    }

    synchronized void stop() {
        if (process != null) {
            process.destroy();
            process = null;
        }
        token = null;
    }

    // ---- Starting --------------------------------------------------------------------------------

    private void run() {
        try {
            status("Preparing the editor…");
            Runtime rt = prepare();
            status("Starting the engine…");
            launch(rt);
        } catch (Exception e) {
            Log.e(TAG, "engine did not start", e);
            fail(e.getMessage() == null ? e.toString() : e.getMessage());
        }
    }

    private static final class Runtime {
        File app;
        File bin;
        File lib;
        String node;
    }

    private Runtime prepare() throws IOException {
        File files = context.getFilesDir();
        String nativeDir = context.getApplicationInfo().nativeLibraryDir;
        String abi = abiOf(nativeDir);
        JSONObject manifest;
        try {
            manifest = new JSONObject(readAsset("runtime/" + abi + ".json"));
        } catch (Exception e) {
            throw new IOException("This build of the app has no engine for this device's processor (" + abi + ").");
        }

        // Symlinks with the names the programs know: runtime/bin/node -> <native dir>/lib_bin_node.so, …
        Runtime rt = new Runtime();
        File runtime = new File(files, "runtime");
        rt.bin = new File(runtime, "bin");
        rt.lib = new File(runtime, "lib");
        deleteTree(runtime);
        if (!rt.bin.mkdirs() || !rt.lib.mkdirs()) throw new IOException("Could not create " + runtime);
        try {
            link(manifest.getJSONObject("bin"), nativeDir, rt.bin);
            link(manifest.getJSONObject("lib"), nativeDir, rt.lib);
            rt.node = new File(nativeDir, manifest.getJSONObject("bin").getString("node")).getPath();
        } catch (Exception e) {
            throw new IOException("Could not set up the engine's programs: " + e.getMessage());
        }
        // An empty OpenSSL configuration, so nothing looks for Termux's.
        writeText(new File(runtime, "openssl.cnf"), "");

        // The engine and the editor's page: unpacked again whenever the app changes.
        rt.app = new File(files, "app");
        String stamp = stamp();
        File stampFile = new File(rt.app, ".stamp");
        if (!stamp.equals(readText(stampFile))) {
            status("Unpacking the editor…");
            deleteTree(rt.app);
            copyAssets("app", rt.app);
            writeText(stampFile, stamp);
        }
        for (String dir : new String[] {"home", "OpenEdits"}) new File(files, dir).mkdirs();
        new File(context.getCacheDir(), "tmp").mkdirs();
        return rt;
    }

    private void launch(Runtime rt) throws IOException {
        File files = context.getFilesDir();
        List<String> cmd = new ArrayList<>();
        cmd.add(rt.node);
        cmd.add(new File(rt.app, "engine/cli.mjs").getPath());
        cmd.add("serve");
        cmd.add("--web");
        cmd.add("--port");
        cmd.add(String.valueOf(PORT));
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(files);
        pb.redirectErrorStream(true);
        Map<String, String> env = pb.environment();
        env.put("HOME", new File(files, "home").getPath());
        env.put("TMPDIR", new File(context.getCacheDir(), "tmp").getPath());
        env.put("PATH", rt.bin.getPath() + ":/system/bin");
        env.put("LD_LIBRARY_PATH", rt.lib.getPath());
        env.put("OPENSSL_CONF", new File(rt.bin.getParentFile(), "openssl.cnf").getPath());
        env.put("SSL_CERT_DIR", "/system/etc/security/cacerts");
        env.put("ESPEAK_DATA_PATH", rt.app.getPath());
        env.put("OPENEDITS_WORKSPACE", workspace().getPath());
        env.put("OPENEDITS_WEB_ROOT", new File(rt.app, "web").getPath());
        env.put("OPENEDITS_FFMPEG", new File(rt.bin, "ffmpeg").getPath());
        env.put("OPENEDITS_FFPROBE", new File(rt.bin, "ffprobe").getPath());
        // The compositor runs in this app's WebView (MainActivity), not in an Electron window.
        env.put("OPENEDITS_RENDER_HOST", "web");
        // The compositor page's errors and each render request go to the log (logcat: OpenEdits/engine).
        env.put("OPENEDITS_RENDER_DEBUG", "1");
        env.put("NODE_OPTIONS", "--max-old-space-size=" + heapMegabytes());

        final Process p = pb.start();
        synchronized (this) {
            process = p;
        }
        Thread reader = new Thread(() -> readOutput(p), "openedits-engine-output");
        reader.start();
        Thread waiter = new Thread(() -> {
            int code;
            try {
                code = p.waitFor();
            } catch (InterruptedException e) {
                return;
            }
            boolean current;
            synchronized (Engine.this) {
                current = process == p;
                if (current) {
                    process = null;
                    token = null;
                }
            }
            Log.w(TAG, "engine exited with code " + code);
            if (current) fail("The engine stopped (exit code " + code + ").");
        }, "openedits-engine-wait");
        waiter.start();
    }

    private void readOutput(Process p) {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) {
                Log.i(TAG + "/engine", line);
                synchronized (this) {
                    log.addLast(line);
                    while (log.size() > LOG_LINES) log.removeFirst();
                }
                Matcher m = LINK.matcher(line);
                if (m.find()) onLink(Integer.parseInt(m.group(1)), m.group(2));
            }
        } catch (IOException e) {
            /* the process ended */
        }
    }

    private void onLink(final int p, final String t) {
        // The engine printed its address; make sure it answers before showing the editor.
        new Thread(() -> {
            for (int i = 0; i < 100; i++) {
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + p + "/health").openConnection();
                    c.setConnectTimeout(1000);
                    c.setReadTimeout(1000);
                    if (c.getResponseCode() == 200) {
                        synchronized (Engine.this) {
                            port = p;
                            token = t;
                        }
                        Log.i(TAG, "engine ready on port " + p + " token " + t);
                        main.post(() -> deliverReady(p, t));
                        return;
                    }
                } catch (IOException e) {
                    /* not yet */
                }
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                    return;
                }
            }
            fail("The engine started but does not answer on port " + p + ".");
        }, "openedits-engine-health").start();
    }

    // ---- Talking to the screen ----------------------------------------------------------------------

    private void status(final String text) {
        main.post(() -> {
            Listener l = listener;
            if (l != null) l.onStatus(text);
        });
    }

    private void fail(final String message) {
        main.post(() -> {
            Listener l = listener;
            if (l != null) l.onFailed(message);
        });
    }

    private void deliverReady(int p, String t) {
        Listener l = listener;
        if (l != null) l.onReady(p, t);
    }

    // ---- Helpers ----------------------------------------------------------------------------------

    private int heapMegabytes() {
        android.app.ActivityManager am = (android.app.ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        android.app.ActivityManager.MemoryInfo info = new android.app.ActivityManager.MemoryInfo();
        am.getMemoryInfo(info);
        long quarter = info.totalMem / (4L * 1024 * 1024);
        return (int) Math.max(512, Math.min(4096, quarter));
    }

    private static String abiOf(String nativeDir) {
        String dir = new File(nativeDir).getName();
        if (dir.equals("arm64")) return "arm64-v8a";
        if (dir.equals("arm")) return "armeabi-v7a";
        return dir; // x86_64, x86
    }

    private static void link(JSONObject names, String nativeDir, File into) throws Exception {
        Iterator<String> keys = names.keys();
        while (keys.hasNext()) {
            String name = keys.next();
            File target = new File(nativeDir, names.getString(name));
            if (!target.exists()) throw new IOException(target.getName() + " was not installed with the app");
            Os.symlink(target.getPath(), new File(into, name).getPath());
        }
    }

    private String stamp() {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return info.versionName + "/" + info.lastUpdateTime;
        } catch (Exception e) {
            return "unknown";
        }
    }

    private String readAsset(String name) throws IOException {
        try (InputStream in = context.getAssets().open(name)) {
            return new String(readAll(in), StandardCharsets.UTF_8);
        }
    }

    private void copyAssets(String path, File to) throws IOException {
        AssetManager assets = context.getAssets();
        String[] children = assets.list(path);
        if (children == null || children.length == 0) {
            to.getParentFile().mkdirs();
            try (InputStream in = assets.open(path); OutputStream out = new FileOutputStream(to)) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
            return;
        }
        to.mkdirs();
        for (String child : children) copyAssets(path + "/" + child, new File(to, child));
    }

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[1 << 16];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private static String readText(File f) {
        try (InputStream in = new FileInputStream(f)) {
            return new String(readAll(in), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    private static void writeText(File f, String text) throws IOException {
        f.getParentFile().mkdirs();
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    /** Delete a folder without following symlinks out of it. */
    private static void deleteTree(File f) {
        if (!java.nio.file.Files.isSymbolicLink(f.toPath()) && f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) for (File c : children) deleteTree(c);
        }
        f.delete();
    }
}
