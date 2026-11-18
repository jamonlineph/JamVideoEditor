#!/usr/bin/env bash
# Checks the Android app on a running emulator: it starts its own engine, opens the editor, and
# edits, renders and exports a video with nothing else installed (no Linux Terminal, no .deb).
#
#   apps/android/emulator-test.sh path/to/app.apk [screenshot-dir]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
apk="$1"
shots="${2:-.}"
mkdir -p "$shots"
tmp="${RUNNER_TEMP:-/tmp}"
app=app.openedits.studio

dump() {
  adb logcat -d -s OpenEdits:V OpenEdits/engine:V OpenEdits/render:V OpenEdits/page:V chromium:W cr_AwContents:W AndroidRuntime:E DEBUG:E linker:V libc:E | tail -200 >&2 || true
  adb exec-out screencap -p >"$shots/android-failure.png" || true
}
trap 'echo "emulator test failed" >&2; dump' ERR

wait_for_log() { # pattern, seconds
  for _ in $(seq 1 "$2"); do
    if adb logcat -d -s OpenEdits:I | grep -F -q "$1"; then return 0; fi
    if adb logcat -d -s OpenEdits:W | grep -F -q "engine failed"; then echo "The engine failed to start" >&2; return 1; fi
    sleep 1
  done
  echo "Timed out waiting for: $1" >&2
  return 1
}

ffmpeg -v error -y -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=330 -t 4 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac "$tmp/clip.mp4"

adb install -r "$apk"
adb shell pm grant "$app" android.permission.POST_NOTIFICATIONS 2>/dev/null || true
adb shell pm grant "$app" android.permission.RECORD_AUDIO 2>/dev/null || true
adb logcat -c

# First start: unpacks the editor, starts the engine, opens the editor and its compositor page.
adb shell am start -W -n "$app/.MainActivity"
sleep 2
adb exec-out screencap -p >"$shots/android-1-starting.png"
wait_for_log "engine ready on port" 300
wait_for_log 'connected\":true' 180
sleep 3
adb exec-out screencap -p >"$shots/android-2-home.png"
line="$(adb logcat -d -s OpenEdits:I | grep -o 'engine ready on port [0-9]* token [0-9a-f]*' | tail -1)"
port="$(echo "$line" | awk '{print $5}')"
token="$(echo "$line" | awk '{print $7}')"
echo "engine on port $port"
adb logcat -d -s OpenEdits/engine:I | tail -20

# Edit, render and export through the app's own engine, FFmpeg and WebView compositor.
adb forward "tcp:$port" "tcp:$port"
node "$here/emulator-check.mjs" "$port" "$token" "$tmp/clip.mp4" "$shots"
sleep 3
adb exec-out screencap -p >"$shots/android-3-editor.png"

# A restart brings the editor back by itself.
adb shell am force-stop "$app"
adb logcat -c
adb shell am start -W -n "$app/.MainActivity"
wait_for_log "engine ready on port" 180
wait_for_log 'connected\":true' 120
adb logcat -d -s OpenEdits:I | tail -5
echo "android app OK"
