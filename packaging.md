# Packaging Jottr

This document covers how to build a redistributable Windows installer,
a portable executable, and how to produce builds for macOS / Linux.

Jottr is a pywebview application: a tiny Python process owns the window,
tray icon, hotkey and filesystem, while the UI is a static HTML/CSS/JS
bundle served from disk.

---

## 1. Prerequisites

```powershell
# Windows (PowerShell)
py -3.11 -m venv .venv
.venv\Scripts\activate
pip install --upgrade pip
pip install pywebview pystray pillow keyboard pyinstaller
```

Optional, only on Windows for signing / installer:

```powershell
pip install pyinstaller-hooks-contrib
# Inno Setup 6:  https://jrsoftware.org/isinfo.php
```

> `pywebview` on Windows uses the **Edge WebView2** runtime, which is
> pre-installed on Windows 10/11. If a user is on an unusually old
> system, WebView2 can be bootstrapped silently via the Evergreen
> bootstrapper (`MicrosoftEdgeWebview2Setup.exe`).

---

## 2. Repository layout

```
jottr/
├── jottr.py            # entry point
├── backend.py          # pywebview JS API
├── ui/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── assets/
│   └── icon.png        # 256x256 application + tray icon
├── website/            # github-pages site
├── packaging.md
└── README.md
```

Keep `assets/icon.png` at exactly 256x256 RGBA. The same file is
re-used by `pyinstaller`, the Inno Setup script and the tray icon
generator in `backend.py`.

---

## 3. Portable single-file build (PyInstaller)

```powershell
pyinstaller --noconfirm ^
  --name Jottr ^
  --windowed ^
  --onefile ^
  --icon assets\icon.png ^
  --add-data "ui;ui" ^
  --add-data "assets;assets" ^
  --collect-all pystray ^
  --collect-all pywebview ^
  --hidden-import keyboard ^
  jottr.py
```

Output: `dist\Jottr.exe` (~30 MB). Drop it anywhere; no install needed.

### Why these flags?

| Flag | Purpose |
|---|---|
| `--windowed` | No console window on Windows. |
| `--onefile` | Single `.exe`; PyInstaller extracts to `%TEMP%` at launch. |
| `--add-data "ui;ui"` | Bundle the static UI directory. |
| `--collect-all pywebview` | Pulls the edgechromium backend shim. |
| `--hidden-import keyboard` | `keyboard` ships native hooks that PyInstaller can't auto-detect. |

If the bundle complains about `clr_loader` / `winreg`, add
`--hidden-import clr_loader` and `--hidden-import winreg`.

---

## 4. Windows installer (Inno Setup)

Save as `build\inno\jottr.iss`:

```iss
[Setup]
AppName=Jottr
AppVersion=1.0.0
AppPublisher=Your Name
DefaultDirName={autopf}\Jottr
DefaultGroupName=Jottr
OutputDir=build\inno\out
OutputBaseFilename=Jottr-Setup-1.0.0
Compression=lzma2
SolidCompression=yes
SetupIconFile=assets\icon.png
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

[Files]
Source: "dist\Jottr.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs
Source: "ui\*"; DestDir: "{app}\ui"; Flags: ignoreversion recursesubdirs

[Icons]
Name: "{group}\Jottr"; Filename: "{app}\Jottr.exe"; IconFilename: "{app}\assets\icon.png"
Name: "{autodesktop}\Jottr"; Filename: "{app}\Jottr.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create desktop shortcut"; GroupDescription: "Additional shortcuts"
Name: "startup";     Description: "Launch Jottr at Windows startup";   GroupDescription: "Additional shortcuts"
Name: "context";     Description: "Add 'Open with Jottr' to right-click menu"; GroupDescription: "Integration"

[Run]
Filename: "{app}\Jottr.exe"; Description: "Launch Jottr"; Flags: nowait postinstall skipifsilent
```

Build:

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" build\inno\jottr.iss
```

The installer writes per-user registry keys (no admin needed) and
honours the optional tasks. The actual toggle for the "Open with
Jottr" context-menu lives inside the app (Settings -> Integration);
the Inno task simply runs the app once with `--register-context`
if you wire that flag up.

---

## 5. Code-signing (optional but recommended)

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ^
  /a dist\Jottr.exe
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ^
  /a build\inno\out\Jottr-Setup-1.0.0.exe
```

Use an EV certificate to skip SmartScreen warnings entirely.

---

## 6. macOS build (py2app)

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt py2app

python -m py2app.build_app --setup setup.py --dist build/macos
# or:
python setup.py py2app
```

`setup.py`:

```python
from setuptools import setup
APP = ["jottr.py"]
DATA_FILES = [("ui", ["ui/index.html", "ui/style.css", "ui/app.js"]),
              ("assets", ["assets/icon.png"])]
OPTIONS = {"argv_emulation": False, "iconfile": "assets/icon.icns"}
setup(app=APP, name="Jottr", data_files=DATA_FILES, options={"py2app": OPTIONS},
      setup_requires=["py2app"])
```

`pystray` works on macOS using the system status bar; `keyboard`
isn't available, so the global hotkey is registered via a small
AppleScript / `MASShortcut` shim instead. Treat the global hotkey
as best-effort on macOS.

---

## 7. Linux build (AppImage)

```bash
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt pyinstaller
pyinstaller --noconfirm --windowed --onefile \
  --add-data "ui:ui" --add-data "assets:assets" \
  --icon assets/icon.png jottr.py

# Wrap with appimage-builder
appimage-builder --recipe build/appimage.yml
```

`build/appimage.yml` is a standard `appimage-builder` recipe: copy
the PyInstaller binary into `AppDir/usr/bin/jottr`, add a `.desktop`
file with `Icon=jottr`, copy `assets/icon.png` as `.DirIcon`, and
declare `python3` plus `webkit2gtk-4.1` as runtime deps.

---

## 8. Auto-update (optional)

The simplest path:

1. Host `latest.json` next to the binaries on GitHub Releases:

   ```json
   { "version": "1.0.1",
     "windows":   "https://github.com/you/jottr/releases/download/v1.0.1/Jottr-Setup-1.0.1.exe",
     "portable":  "https://github.com/you/jottr/releases/download/v1.0.1/Jottr.exe",
     "notes":     "Bug fixes." }
   ```

2. In `backend.py`, add a `check_for_update()` method that does a
   `urllib.request.urlopen("https://you/jottr/latest.json")`,
   compares `version` to the bundled one, and reports back to JS.

3. In the UI, the settings panel shows an "Update available" banner
   with a button that opens the release URL.

This sidesteps the complexity of `pyupdater`/`sparkle` while still
giving users a one-click update.

---

## 9. Continuous builds (GitHub Actions)

`.github/workflows/release.yml`:

```yaml
name: Release
on: { push: { tags: ["v*"] } }
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11" }
      - run: pip install pywebview pystray pillow keyboard pyinstaller
      - run: pyinstaller --noconfirm --windowed --onefile ^
              --add-data "ui;ui" --add-data "assets;assets" ^
              --icon assets/icon.png jottr.py
      - run: |
          $env:ISCC = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
          & $ISCC build\inno\jottr.iss
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            dist/Jottr.exe
            build/inno/out/Jottr-Setup-*.exe
```

---

## 10. Smoke-testing the build

Before shipping, verify on a clean VM:

- [ ] App launches without a console window.
- [ ] PIN gate works (set, remove, relock).
- [ ] Tray icon appears and "Quit" actually exits.
- [ ] Global hotkey toggles the window.
- [ ] Explorer "Open with Jottr" round-trips a real `.md` file.
- [ ] Auto-save does **not** reset cursor position mid-typing.
- [ ] Typing `**todolist**` in a blank note flips it to todo mode.
- [ ] Settings -> "Add to startup" toggles `HKCU\...\Run\Jottr`.
- [ ] Uninstall removes the registry entries and the app folder.

That's it - ship it.
