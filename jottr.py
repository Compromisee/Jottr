"""
Jottr - A tabbed notepad with atomic auto-save, PIN-protected files,
a Windows-style home screen and a tiny todo list.

Entry point. Creates the pywebview window, sets the taskbar / window
icon on Windows, starts the tray icon, global hotkey, and the
backend bridge.
"""
from __future__ import annotations

import os
import sys
import threading
import webview

from backend import JottrAPI


APP_NAME = "Jottr"
APP_DIR = os.path.dirname(os.path.abspath(__file__))
UI_DIR = os.path.join(APP_DIR, "ui")
ICON_PNG = os.path.join(APP_DIR, "assets", "icon.png")
ICON_ICO = os.path.join(APP_DIR, "assets", "icon.ico")


def pick_icon() -> str | None:
    """Pick the right icon file for the current OS. Windows prefers
    .ico, others can use the .png."""
    if sys.platform == "win32" and os.path.isfile(ICON_ICO):
        return ICON_ICO
    if os.path.isfile(ICON_PNG):
        return ICON_PNG
    return None


def set_windows_taskbar_identity() -> None:
    """On Windows, register an explicit AppUserModelID so the taskbar
    can group and identify Jottr's windows correctly. pywebview will
    still need a proper icon to display one in the taskbar."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
            "jottr.notepad.app")
    except Exception:
        pass


def main() -> None:
    set_windows_taskbar_identity()

    api = JottrAPI(app_name=APP_NAME, app_dir=APP_DIR)

    window = webview.create_window(
        title=APP_NAME,
        url=os.path.join(UI_DIR, "index.html"),
        width=1280,
        height=820,
        min_size=(900, 600),
        background_color="#0b0b14",
        text_select=True,
        js_api=api,
        confirm_close=False,
        easy_drag=False,
    )
    api.bind_window(window)

    # Tray + global hotkey live in background threads so the UI
    # never blocks even if they take a moment to spin up.
    threading.Thread(target=api.start_tray, args=(window,), daemon=True).start()
    threading.Thread(target=api.start_global_hotkey, args=(window,), daemon=True).start()

    # Pass the icon to webview.start so the window gets the proper
    # taskbar / Alt-Tab icon on every supported OS.
    webview.start(
        debug=False,
        gui="edgechromium" if sys.platform == "win32" else None,
        icon=pick_icon(),
    )


if __name__ == "__main__":
    main()
