# SLP Knowledge Assistant Packaging

This project stays local-first:

- Windows hosts the Express API, React app, SQLite database, uploads, proposal templates, and generated proposals.
- Android is a WebView client that connects to the Windows server LAN URL.
- iPhone/iPad uses Safari Add to Home Screen as a PWA first.
- Vercel/Render are not used.

## Windows EXE Installer

Production uses one port:

```text
http://localhost:3001
http://PC_IP_ADDRESS:3001
```

Build the Windows installer:

```powershell
npm install
npm run dist:win
```

Expected installer output:

```text
release/SLP Knowledge Assistant Setup.exe
```

What the installer includes:

- `dist/` frontend build
- bundled Express server from `server.ts`
- first-run seed copy of `uploads/`
- first-run seed copy of `templates/`
- first-run seed copy of `server/generated-proposals/`
- first-run seed copy of `slp-local.sqlite`

Installed mutable data is stored under the Windows app data folder for `SLP Knowledge Assistant`. This keeps SQLite, uploads, templates, and generated proposals local to the PC.

Electron starts the Express server automatically, waits for `/api/health`, then opens the app window at `http://localhost:3001`.

## LAN Access

On the Windows host:

1. Open the installed app.
2. Confirm Windows Firewall allows the app/server on private networks.
3. Find the PC IP address with:

```powershell
ipconfig
```

Other devices on the same LAN can open:

```text
http://PC_IP_ADDRESS:3001
```

## Android WebView APK

Android does not duplicate the database. It connects to the Windows server.

Default URL:

```text
http://192.168.50.77:3001
```

Change it in:

```text
android-webview/app/src/main/res/values/strings.xml
```

Or enter a new URL from the Android offline screen.

Build with Android Studio, or with a local Gradle installation:

```powershell
cd android-webview
gradle assembleDebug
```

The Android manifest allows HTTP cleartext traffic for LAN access.

## iPhone/iPad PWA

Native iOS is intentionally not built yet. Use Safari:

1. Open `http://PC_IP_ADDRESS:3001`.
2. Tap Share.
3. Tap Add to Home Screen.

PWA support is provided by:

- `public/manifest.json`
- `public/icons/icon-192.png`
- `public/icons/icon-512.png`
- `public/icons/apple-touch-icon.png`
- iOS web app meta tags in `index.html`

Native iOS can be considered later when a Mac, Xcode, and Apple Developer account are available.
