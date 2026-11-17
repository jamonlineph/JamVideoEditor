#!/usr/bin/env bash
# Checks the launcher app on a running Android emulator against the installed .deb's `openedits-web`:
# the emulator's localhost:PORT is pointed at this machine's, which is what a Googlebook does for its
# Linux Terminal.
#
#   apps/android/emulator-test.sh path/to/app.apk [screenshot-dir]
set -euo pipefail
apk="$1"
shots="${2:-.}"
tmp="${RUNNER_TEMP:-/tmp}"
log="$tmp/web-apk.log"
app=app.openedits.studio

OPENEDITS_WORKSPACE="$tmp/web-ws" openedits-web >"$log" 2>&1 &
for _ in $(seq 1 30); do grep -q "token=" "$log" && break; sleep 1; done
link="$(grep -o "http://localhost:[0-9]*/?token=[0-9a-f]*" "$log")"
port="$(echo "$link" | sed -E 's|http://localhost:([0-9]+)/.*|\1|')"
echo "editor on port $port"

wait_for_log() { # pattern, seconds
  for _ in $(seq 1 "$2"); do
    if adb logcat -d -s OpenEdits:I | grep -F -q "$1"; then return 0; fi
    sleep 1
  done
  echo "Timed out waiting for: $1" >&2
  adb logcat -d -s OpenEdits:I chromium:I AndroidRuntime:E | tail -40 >&2
  adb exec-out screencap -p >"$shots/android-failure.png" || true
  return 1
}

adb reverse "tcp:$port" "tcp:$port"
adb install -r "$apk"
adb logcat -c

# First start: the editor is up but this app has never been given the link.
adb shell am start -W -n "$app/.MainActivity"
wait_for_log "editor answered 401" 60
adb exec-out screencap -p >"$shots/android-1-sign-in.png"

# Opening the Terminal's link signs the app in and shows the editor, connected to the engine.
adb shell am start -W -a android.intent.action.VIEW -d "'$link'" -n "$app/.MainActivity"
wait_for_log 'connected\":true' 120
sleep 3
adb exec-out screencap -p >"$shots/android-2-editor.png"

# A restart needs no link: the sign-in was remembered.
adb shell am force-stop "$app"
adb logcat -c
adb shell am start -W -n "$app/.MainActivity"
wait_for_log 'connected\":true' 120
adb logcat -d -s OpenEdits:I | tail -5
echo "launcher app OK"
