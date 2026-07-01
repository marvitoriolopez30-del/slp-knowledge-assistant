# Android WebView APK

This Android app does not contain the SLP database. It opens the Windows-hosted SLP Knowledge Assistant over the local network.

Default URL:

```text
http://192.168.50.77:3001
```

Change the default in `app/src/main/res/values/strings.xml`, or enter a new server URL in the offline screen on the phone.

Build with Android Studio or a local Gradle installation:

```powershell
cd android-webview
gradle assembleDebug
```

The APK output will be under `app/build/outputs/apk/debug/`.
