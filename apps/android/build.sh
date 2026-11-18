#!/usr/bin/env bash
# Builds OpenEdits Studio for Android and Googlebooks: one .apk with the whole editor (engine,
# FFmpeg, UI), for 64-bit ARM and Intel/AMD devices. Uses the Android SDK's own tools (no Gradle,
# no libraries).
#
#   ANDROID_HOME=/path/to/sdk apps/android/build.sh [output.apk]
#
# Steps: stage-app.mjs builds the engine and the UI into build/stage/assets; fetch-runtime.mjs puts
# Android builds of Node.js, FFmpeg and eSpeak NG (from Termux's packages) into build/stage/lib (it
# is skipped when that folder exists: delete it to fetch again). ANDROID_ABIS limits the processors
# (default: arm64-v8a,x86_64).
#
# Signing: set ANDROID_KEYSTORE (file), ANDROID_KEYSTORE_PASSWORD and ANDROID_KEY_ALIAS to sign with
# your own key, so later versions install over earlier ones. Without them a throwaway key is made,
# and installing a newer build means uninstalling the old one first.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:?Set ANDROID_HOME to the Android SDK}}"
version="$(node -p "require('$root/package.json').version")"
out="${1:-$root/release/dist/OpenEdits-Studio-$version-android.apk}"
stage="$here/build/stage"
abis="${ANDROID_ABIS:-arm64-v8a,x86_64}"

tools="$(ls -d "$sdk"/build-tools/*/ | sort -V | tail -1)"
platform=""
for level in 36 35 34; do
  if [ -f "$sdk/platforms/android-$level/android.jar" ]; then platform="$sdk/platforms/android-$level/android.jar"; break; fi
done
[ -n "$platform" ] || { echo "No Android platform 34-36 in $sdk/platforms" >&2; exit 1; }
echo "build-tools: $tools"
echo "platform:    $platform"

node "$here/stage-app.mjs" "$stage"
if [ ! -d "$stage/lib" ]; then node "$here/fetch-runtime.mjs" "$stage" --abi "$abis"; fi
for abi in ${abis//,/ }; do
  [ -f "$stage/assets/runtime/$abi.json" ] || { echo "No runtime for $abi in $stage (delete $stage/lib and run again)" >&2; exit 1; }
done

work="$here/build/apk"
rm -rf "$work"
mkdir -p "$work/gen" "$work/classes" "$work/dex" "$(dirname "$out")"

# versionCode from the version: 1.2.3 -> 10203
IFS=. read -r major minor patch <<<"${version%%-*}"
code=$((major * 10000 + minor * 100 + patch))
[ "$code" -gt 0 ] || code=1

"$tools/aapt2" compile --dir "$here/res" -o "$work/res.zip"
"$tools/aapt2" link -o "$work/unsigned.apk" -I "$platform" --manifest "$here/AndroidManifest.xml" --java "$work/gen" \
  --min-sdk-version 29 --target-sdk-version 34 --version-code "$code" --version-name "$version" \
  -A "$stage/assets" "$work/res.zip"
javac -nowarn --release 11 -classpath "$platform" -d "$work/classes" $(find "$here/src" "$work/gen" -name '*.java')
"$tools/d8" --release --lib "$platform" --min-api 29 --output "$work/dex" $(find "$work/classes" -name '*.class')
(cd "$work/dex" && zip -q -j ../unsigned.apk classes.dex)
# The engine's programs and libraries, one folder per processor.
mkdir -p "$work/native/lib"
for abi in ${abis//,/ }; do cp -r "$stage/lib/$abi" "$work/native/lib/"; done
(cd "$work/native" && zip -q -r -9 ../unsigned.apk lib)
"$tools/zipalign" -f -p 4 "$work/unsigned.apk" "$work/aligned.apk"

keystore="${ANDROID_KEYSTORE:-}"
password="${ANDROID_KEYSTORE_PASSWORD:-openedits}"
alias="${ANDROID_KEY_ALIAS:-openedits}"
if [ -z "$keystore" ]; then
  keystore="$here/build/throwaway.keystore"
  if [ ! -f "$keystore" ]; then
    keytool -genkeypair -keystore "$keystore" -storepass "$password" -keypass "$password" -alias "$alias" \
      -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=OpenEdits Studio" >/dev/null 2>&1
  fi
  echo "signing with a throwaway key (set ANDROID_KEYSTORE to use your own)"
fi
"$tools/apksigner" sign --ks "$keystore" --ks-pass "pass:$password" --key-pass "pass:$password" --ks-key-alias "$alias" --out "$out" "$work/aligned.apk"
"$tools/apksigner" verify "$out"
rm -f "$out.idsig"
echo "built $out ($(du -h "$out" | cut -f1))"
