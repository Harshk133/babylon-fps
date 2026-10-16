# Mobile app (Android) and sharing with friends

The game ships as an Android app made with [Capacitor](https://capacitorjs.com):
the same game (Solo, Co-op vs Zombies, Battle Royale) in a fullscreen,
landscape app with touch controls and gyroscope aiming.

## Controls on a phone

| Control | What it does |
|---|---|
| Left thumb, anywhere on the left | Joystick (appears under your thumb). Push to the top edge to **sprint**. Drives the auto-rickshaw too. |
| Right thumb, drag on the right | Look around |
| Big red button | Fire. Keep your thumb on it and drag to aim while shooting. |
| Small red button (left) | Fire with the left thumb |
| Crosshair button | Aim down sights (tap on / off) |
| ⬆ | Jump (handbrake while driving) |
| ↻ | Reload |
| Grenade button | Hold to aim, let go to throw. **⇄** next to it: grenade / molotov |
| ⇄ (bottom) | Next weapon (or tap a weapon in the hotbar) |
| **+** | Medkit |
| On-screen prompts | Tap them: *Pick up*, *Drive auto-rickshaw*, *Get out*, *Fill petrol*, doors, lights |
| Top row | **❚❚** pause · **BAG** inventory · **GYRO** gyroscope aiming · flashlight · **MAP** (battle royale) |
| **START** | Battle royale host: start the match |
| **MAP**, then tap the map | Pin a place: follow the yellow chevrons / marker. Tap the pin (or *Clear pin*) to remove it. Red circles are gunfire, with their distance |

**Gyroscope:** tap **GYRO**, then turn the phone left / right to look left /
right and tilt it to look up / down (like PUBG Mobile). It remembers the setting.

**Graphics:** the lobby's *Graphics* setting picks *Auto* by default (Low on
4 GB phones, Medium on most others). Choose *Low* if a phone gets hot or laggy.

## How fast is it?

The app runs the game in Android's built-in Chrome engine (WebView), which
draws with the phone's GPU through WebGL and uses its CPU and RAM directly,
the same way Chrome does. The app adds fullscreen without browser bars, a
landscape lock, a screen that stays on, and a larger memory allowance. The
biggest speed lever is the *Graphics* setting.

## 1. Build the APK in the cloud (no Android Studio needed)

The workflow `.github/workflows/android-apk.yml` builds the app on GitHub.

1. Commit and push this project to GitHub.
2. Set the multiplayer server address (needed for Co-op and Battle Royale):
   GitHub repo → **Settings → Secrets and variables → Actions → Variables →
   New repository variable**: `RELAY_URL` = `wss://<your-relay>.onrender.com/ws`
   (the same value as on Vercel, see `DEPLOY.md`).
3. If your relay on Render has `ALLOWED_ORIGINS` set, add `https://localhost`
   to it (that's the app's origin), e.g.
   `https://babylon-fps.vercel.app,https://localhost`.
4. **Actions** tab → **Android APK** → **Run workflow**. After 5–10 minutes,
   open the finished run and download **SurviveTheHorde-apk** (a zip with
   `SurviveTheHorde.apk` inside).

To get a shareable download page instead, push a version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The APK is then attached to a **Release** at
`https://github.com/<you>/babylon-fps/releases`. Send that link.

### Optional: sign with your own key (recommended once friends play)

Without a key, each cloud build is signed with a throwaway debug key, so
friends must **uninstall the old version before installing a new one**. With
your own key, updates install over the old version.

Create a key once (needs Java; Android Studio includes it, or install
Temurin JDK 21):

```bash
keytool -genkeypair -v -keystore horde.jks -alias horde -keyalg RSA -keysize 2048 -validity 10000
```

Keep `horde.jks` and its passwords safe and **don't commit it**. Then add these
repository **secrets**:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the file as base64: `base64 -w0 horde.jks` (Linux/Git Bash) or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("horde.jks"))` (PowerShell) |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `horde` |
| `ANDROID_KEY_PASSWORD` | the key password |

## 2. Or build it on your PC

1. Install [Android Studio](https://developer.android.com/studio) (it brings
   the Android SDK and Java).
2. Set the relay for this build, then build and open the Android project:

   ```bash
   # PowerShell:  $env:RELAY_URL="wss://<your-relay>.onrender.com/ws"
   npm run mobile:build      # web build → drop unused assets → copy into android/
   npm run mobile:open       # opens Android Studio
   ```

3. In Android Studio: **Build → Build App Bundle(s) / APK(s) → Build APK(s)**,
   or plug in your phone (USB debugging on) and press **Run ▶**.

Every time you change the game: `npm run mobile:build` again.

## 3. Share it with friends

**Android friends**
1. Send the APK file (WhatsApp, Telegram, Google Drive) or the Release link.
2. They open it on the phone. Android asks to allow installing apps from that
   source (Chrome / WhatsApp / Files): **Settings → Allow from this source**.
3. If Play Protect says the app is from an unknown developer: **More details →
   Install anyway**. (This happens for any app not from the Play Store.)

**iPhone friends**: iPhones can't install APKs, so they play the website:
1. Open your Vercel link in **Safari**, e.g. `https://babylon-fps.vercel.app`.
2. **Share → Add to Home Screen**: it gets an icon and opens fullscreen like an app.
3. Turn the phone sideways. Touch controls and **GYRO** work there too (iOS
   asks for motion permission the first time).

A real iPhone app needs a Mac with Xcode and an Apple Developer account
($99/year, for TestFlight). Capacitor supports it: `npx cap add ios` on a Mac.

**Playing together**: everyone picks the same mode in the lobby and types
the same **room code**. The app, phone browsers and PCs can all be in one
room.

## Google Play (optional, later)

For the Play Store you need a Google Play developer account ($25 once) and an
**app bundle** signed with your key: in Android Studio **Build → Generate
Signed Bundle / APK → Android App Bundle**, then upload it in the Play Console.
