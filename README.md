# SLP Knowledge Assistant

Local full-stack SLP Knowledge Assistant for documents, dashboards, matching, and proposal building.

## Development

Run the API and Vite dev server:

```powershell
npm install
npm run dev
```

Development URLs:

```text
API: http://localhost:3001
Web: http://localhost:5173
```

## Local Production

Production uses one port only:

```text
http://localhost:3001
```

Start local production mode:

```powershell
.\start-app.ps1
```

The script will:

- run `npm install` if `node_modules` is missing
- run `npm run build` if `dist` is missing
- start `npm start`
- open `http://localhost:3001`
- print the LAN URL for phones/other PCs

Stop local production mode:

```powershell
.\stop-app.ps1
```

Create a desktop shortcut:

```powershell
.\create-shortcut.ps1
```

## LAN Access

From another phone or PC on the same Wi-Fi/LAN:

```text
http://PC_IP_ADDRESS:3001
```

Find the Windows PC IP address:

```powershell
ipconfig
```

If Windows Firewall asks, allow Node.js or SLP Knowledge Assistant on Private networks.

## Windows Installer

Build the installer:

```powershell
npm run dist:win
```

Output:

```text
release\SLP Knowledge Assistant Setup.exe
```

The installed app starts the Express server automatically, waits for `http://localhost:3001/api/health`, then opens the desktop app window.

## Android

The Android app is a WebView client. It does not copy the SQLite database. The Windows PC remains the server.

Open the Android project in Android Studio:

```text
android-webview
```

Build APK in Android Studio:

1. Open `android-webview`.
2. Let Gradle sync.
3. Set the server URL in `app/src/main/res/values/strings.xml` if needed.
4. Choose Build > Build Bundle(s) / APK(s) > Build APK(s).

Default LAN URL:

```text
http://192.168.50.77:3001
```

## iPhone/iPad PWA

Native iOS is not built yet. Use Safari:

1. Open `http://PC_IP_ADDRESS:3001`.
2. Tap Share.
3. Tap Add to Home Screen.

PWA files:

- `public/manifest.json`
- `public/icons/icon-192.png`
- `public/icons/icon-512.png`
- `public/icons/apple-touch-icon.png`
