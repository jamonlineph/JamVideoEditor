#!/usr/bin/env bash
# Builds the Googlebook/Android launcher app with the Android SDK's own tools (no Gradle, no
# libraries: it is one activity).
#
#   ANDROID_HOME=/path/to/sdk apps/android/build.sh [output.apk]
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

tools="$(ls -d "$sdk"/build-tools/*/ | sort -V | tail -1)"
platform=""
for level in 36 35 34; do
  if [ -f "$sdk/platforms/android-$level/android.jar" ]; then platform="$sdk/platforms/android-$level/android.jar"; break; fi
done
[ -n "$platform" ] || { echo "No Android platform 34-36 in $sdk/platforms" >&2; exit 1; }
echo "build-tools: $tools"
echo "platform:    $platform"

work="$here/build"
rm -rf "$work"
mkdir -p "$work/gen" "$work/classes" "$work/dex" "$(dirname "$out")"

# versionCode from the version: 1.2.3 -> 10203
IFS=. read -r major minor patch <<<"${version%%-*}"
code=$((major * 10000 + minor * 100 + patch))
[ "$code" -gt 0 ] || code=1

"$tools/aapt2" compile --dir "$here/res" -o "$work/res.zip"
"$tools/aapt2" link -o "$work/unsigned.apk" -I "$platform" --manifest "$here/AndroidManifest.xml" --java "$work/gen" \
  --min-sdk-version 29 --target-sdk-version 34 --version-code "$code" --version-name "$version" "$work/res.zip"
javac -nowarn --release 11 -classpath "$platform" -d "$work/classes" $(find "$here/src" "$work/gen" -name '*.java')
"$tools/d8" --release --lib "$platform" --min-api 29 --output "$work/dex" $(find "$work/classes" -name '*.class')
(cd "$work/dex" && zip -q -j ../unsigned.apk classes.dex)
"$tools/zipalign" -f 4 "$work/unsigned.apk" "$work/aligned.apk"

keystore="${ANDROID_KEYSTORE:-}"
password="${ANDROID_KEYSTORE_PASSWORD:-openedits}"
alias="${ANDROID_KEY_ALIAS:-openedits}"
if [ -z "$keystore" ]; then
  keystore="$work/throwaway.keystore"
  keytool -genkeypair -keystore "$keystore" -storepass "$password" -keypass "$password" -alias "$alias" \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=OpenEdits Studio" >/dev/null 2>&1
  echo "signing with a throwaway key (set ANDROID_KEYSTORE to use your own)"
fi
"$tools/apksigner" sign --ks "$keystore" --ks-pass "pass:$password" --key-pass "pass:$password" --ks-key-alias "$alias" --out "$out" "$work/aligned.apk"
"$tools/apksigner" verify "$out"
rm -f "$out.idsig"
echo "built $out ($(du -h "$out" | cut -f1))"
