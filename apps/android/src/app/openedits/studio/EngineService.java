package app.openedits.studio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;

/**
 * Keeps the app in the foreground while the editor is open, so Android neither freezes nor stops
 * the engine (and a long export) when the window is in the background. It shows one quiet
 * notification; tapping it brings the editor back.
 */
public class EngineService extends Service {
    private static final String CHANNEL = "engine";
    private static final int ID = 1;

    static void start(Context context) {
        try {
            context.startForegroundService(new Intent(context, EngineService.class));
        } catch (RuntimeException e) {
            // Not allowed right now (the app is in the background): the editor still works while it is open.
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, EngineService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Editor engine", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setContentTitle("OpenEdits Studio")
                .setContentText("The editor is running. Exports keep going in the background.")
                .setSmallIcon(R.drawable.ic_notification)
                .setContentIntent(open)
                .setOngoing(true)
                .build();
        try {
            startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } catch (RuntimeException e) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
