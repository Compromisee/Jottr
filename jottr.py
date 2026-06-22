"""
Jottr - A tabbed notepad with atomic auto-save, PIN-protected files,
a Windows-style home screen and a tiny todo list.

Entry point. Creates the pywebview window, tray icon, global hotkey,
and starts the backend bridge. 
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
ICON_PATH = os.path.join(APP_DIR, "assets", "icon.png")


def main() -> None:
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

    webview.start(debug=False, gui="edgechromium" if sys.platform == "win32" else None)


if __name__ == "__main__":
    main()
