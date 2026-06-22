"""
Backend bridge for Jottr. Exposed to JavaScript through
`webview.create_window(js_api=api)`. Every method must be
JSON-serializable in its return value and tolerant of bad input.

Features wired here:
- Notes folder, file IO with atomic writes (tmp + rename)
- PIN hashing (sha-256), per-file or app-wide PIN
- Recent files + stats (streak, minutes today)
- Tray icon (pystray) and global hotkey (keyboard)
- Startup-on-boot toggle (Windows registry)
- Explorer "Open with Jottr" context menu (Windows registry)
- Theme persistence and settings store
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

# Optional dependencies - gracefully degrade if missing.
try:
    import pystray  # type: ignore
    from pystray import MenuItem as _MI  # type: ignore
    from PIL import Image  # type: ignore
    HAS_TRAY = True
except Exception:
    HAS_TRAY = False

try:
    import keyboard  # type: ignore
    HAS_KEYBOARD = True
except Exception:
    HAS_KEYBOARD = False


# ---------- Atomic file helpers ---------------------------------------------

def _atomic_write(path: Path, data: str) -> None:
    """Write to a sibling .tmp, fsync, then rename. Survives crashes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _safe_read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""
    except Exception:
        return ""


# ---------- Jottr API --------------------------------------------------------

class JottrAPI:
    """The single Python object handed to the JS layer."""

    def __init__(self, app_name: str, app_dir: str) -> None:
        self.app_name = app_name
        self.app_dir = Path(app_dir)
        self.notes_dir = self.app_dir / "notes"
        self.notes_dir.mkdir(parents=True, exist_ok=True)
        self.config_path = self.app_dir / "config.json"
        self.config = self._load_config()
        self._window = None
        self._tray_icon = None
        self._hotkey_handle = None
        self._lock = threading.Lock()

    # -- window binding (called from main after create_window) -------------
    def bind_window(self, window) -> None:
        self._window = window

    # -- config ------------------------------------------------------------
    def _load_config(self) -> dict:
        if self.config_path.exists():
            try:
                return json.loads(self.config_path.read_text(encoding="utf-8"))
            except Exception:
                pass
        return self._default_config()

    def _default_config(self) -> dict:
        return {
            "version": 1,
            "theme": "midnight",
            "app_pin_hash": "",
            "pin_scope": "app",            # "app" or "per_file"
            "startup": False,
            "global_hotkey": "ctrl+alt+j",
            "minimize_to_tray": True,
            "show_home": True,
            "recent": [],
            "pinned": [],
            "stats": {
                "streak": 0,
                "last_open_date": "",
                "minutes_today": 0,
                "minutes_today_date": "",
                "total_words": 0,
            },
            "explorer_context_menu": False,
            "font_size": 14,
            "show_line_numbers": True,
            "word_wrap": False,
            "preview_default": False,
        }

    def _save_config(self) -> None:
        _atomic_write(self.config_path, json.dumps(self.config, indent=2))

    # -- helpers used from JS ---------------------------------------------
    def get_config(self) -> dict:
        return self.config

    def update_settings(self, patch: dict) -> dict:
        # Whitelist updatable keys.
        allowed = {
            "theme", "app_pin_hash", "pin_scope", "startup", "global_hotkey",
            "minimize_to_tray", "show_home", "explorer_context_menu",
            "font_size", "show_line_numbers", "word_wrap",
            "pinned", "preview_default",
        }
        with self._lock:
            for k, v in patch.items():
                if k in allowed:
                    self.config[k] = v
            self._save_config()
            # Side-effects
            if "startup" in patch:
                self._apply_startup(self.config["startup"])
            if "global_hotkey" in patch:
                self._apply_hotkey(self.config["global_hotkey"])
            if "explorer_context_menu" in patch:
                self._apply_context_menu(self.config["explorer_context_menu"])
        return {"ok": True, "config": self.config}

    # -- PIN ---------------------------------------------------------------
    @staticmethod
    def _hash_pin(pin: str, salt: str | None = None) -> str:
        salt = salt or secrets.token_hex(8)
        h = hashlib.sha256((salt + pin).encode("utf-8")).hexdigest()
        return f"sha256${salt}${h}"

    def set_app_pin(self, pin: str) -> dict:
        if not pin or len(pin) < 3:
            return {"ok": False, "error": "PIN must be at least 3 characters."}
        with self._lock:
            self.config["app_pin_hash"] = self._hash_pin(pin)
            self._save_config()
        return {"ok": True}

    def verify_app_pin(self, pin: str) -> dict:
        stored = self.config.get("app_pin_hash", "")
        if not stored:
            return {"ok": True, "required": False}
        if not pin:
            return {"ok": False, "required": True}
        try:
            algo, salt, want = stored.split("$", 2)
        except ValueError:
            return {"ok": False, "error": "corrupt pin"}
        got = hashlib.sha256((salt + pin).encode("utf-8")).hexdigest()
        return {"ok": secrets.compare_digest(want, got), "required": True}

    def has_app_pin(self) -> dict:
        return {"required": bool(self.config.get("app_pin_hash"))}

    # -- Notes: list / read / save / delete --------------------------------
    def list_notes(self) -> dict:
        files = []
        for p in sorted(self.notes_dir.glob("*")):
            if p.is_file() and p.suffix.lower() in (".md", ".txt", ".jot"):
                st = p.stat()
                files.append({
                    "name": p.name,
                    "path": str(p),
                    "size": st.st_size,
                    "modified": st.st_mtime,
                })
        return {"ok": True, "files": files, "dir": str(self.notes_dir)}

    def read_note(self, name: str) -> dict:
        # Reject traversal / absolute paths.
        if not name or "/" in name or "\\" in name or name.startswith("."):
            return {"ok": False, "error": "invalid name"}
        path = (self.notes_dir / name).resolve()
        if self.notes_dir.resolve() not in path.parents and path != self.notes_dir.resolve():
            return {"ok": False, "error": "invalid path"}
        if not path.exists():
            return {"ok": True, "content": "", "created": True}
        return {"ok": True, "content": _safe_read(path), "mtime": path.stat().st_mtime}

    def save_note(self, name: str, content: str) -> dict:
        if not name or "/" in name or "\\" in name or name.startswith("."):
            return {"ok": False, "error": "invalid name"}
        path = (self.notes_dir / name).resolve()
        if self.notes_dir.resolve() not in path.parents and path != self.notes_dir.resolve():
            return {"ok": False, "error": "invalid path"}
        # Atomic write -> never truncates even if interrupted.
        _atomic_write(path, content)
        # Update recent list.
        self._push_recent(name)
        # Stats: count words, accumulate minutes.
        words = len([w for w in content.split() if w])
        self._bump_stats(words_added=words)
        return {"ok": True, "mtime": path.stat().st_mtime, "size": len(content)}

    def delete_note(self, name: str) -> dict:
        if not name or "/" in name or "\\" in name or name.startswith("."):
            return {"ok": False, "error": "invalid name"}
        path = (self.notes_dir / name).resolve()
        if self.notes_dir.resolve() not in path.parents and path != self.notes_dir.resolve():
            return {"ok": False, "error": "invalid path"}
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return {"ok": True}

    def new_note(self, name: str | None, kind: str = "note") -> dict:
        """Create a blank note or a todolist stub."""
        ext = ".md"
        base = (name or "").strip()
        if not base:
            ts = datetime.now().strftime("%Y-%m-%d-%H%M%S")
            base = "note" if kind == "note" else "todo"
            name = f"{base}-{ts}{ext}"
        else:
            if not (base.endswith(".md") or base.endswith(".txt")):
                name = base + ext
        path = self.notes_dir / name
        if path.exists():
            # Don't clobber - append suffix.
            i = 2
            while True:
                candidate = path.with_stem(path.stem + f"-{i}")
                if not candidate.exists():
                    name = candidate.name
                    path = candidate
                    break
                i += 1
        content = "**todolist**\n\n- [ ] " if kind == "todo" else ""
        _atomic_write(path, content)
        self._push_recent(name)
        return {"ok": True, "name": name}

    def open_external(self, suggested_name: str = "imported.md") -> dict:
        """Show a native file-open dialog, read the chosen file, import it."""
        if not self._window:
            return {"ok": False, "error": "no window"}
        try:
            dlg_type = getattr(webview, "FileDialog", None)
            open_const = (
                dlg_type.OPEN if dlg_type and hasattr(dlg_type, "OPEN")
                else getattr(webview, "OPEN_DIALOG", 10)
            )
            result = self._window.create_file_dialog(
                dialog_type=open_const,
                directory=str(self.notes_dir),
                allow_multiple=False,
                file_types=("Markdown (*.md)", "Text (*.txt)", "All files (*.*)"),
            )
        except Exception as e:
            return {"ok": False, "error": str(e)}
        if not result:
            return {"ok": False, "cancelled": True}
        first = result if isinstance(result, (str, Path)) else result[0]
        src = Path(first)
        name = suggested_name or src.name
        if not (name.endswith(".md") or name.endswith(".txt")):
            name += ".md"
        dest = self.notes_dir / name
        if dest.exists():
            i = 2
            while True:
                cand = dest.with_stem(dest.stem + f"-{i}")
                if not cand.exists():
                    dest = cand
                    name = dest.name
                    break
                i += 1
        try:
            shutil.copy2(src, dest)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        self._push_recent(name)
        return {"ok": True, "name": name}

    # -- Recent + stats ----------------------------------------------------
    def _push_recent(self, name: str) -> None:
        recent = [r for r in self.config.get("recent", []) if r != name]
        recent.insert(0, name)
        self.config["recent"] = recent[:15]
        self._save_config()

    def _bump_stats(self, words_added: int = 0) -> None:
        today = datetime.now().strftime("%Y-%m-%d")
        stats = self.config.setdefault("stats", {})
        # Streak
        last = stats.get("last_open_date", "")
        if last != today:
            try:
                last_d = datetime.strptime(last, "%Y-%m-%d") if last else None
                if last_d and (datetime.strptime(today, "%Y-%m-%d") - last_d).days == 1:
                    stats["streak"] = int(stats.get("streak", 0)) + 1
                else:
                    stats["streak"] = 1
            except Exception:
                stats["streak"] = 1
            stats["last_open_date"] = today
        # Minutes (very rough - bumps on every save batch)
        if stats.get("minutes_today_date") != today:
            stats["minutes_today"] = 0
            stats["minutes_today_date"] = today
        stats["minutes_today"] = int(stats.get("minutes_today", 0)) + 1
        stats["total_words"] = int(stats.get("total_words", 0)) + max(0, words_added)
        self._save_config()

    def get_stats(self) -> dict:
        today = datetime.now().strftime("%Y-%m-%d")
        stats = dict(self.config.get("stats", {}))
        # Reset minutes if a new day
        if stats.get("minutes_today_date") != today:
            stats["minutes_today"] = 0
            stats["minutes_today_date"] = today
        # Build 7-day series from recent file mtimes.
        series = []
        for i in range(6, -1, -1):
            d = datetime.now() - timedelta(days=i)
            key = d.strftime("%Y-%m-%d")
            series.append({"date": key, "label": d.strftime("%a"), "count": 0})
        for p in self.notes_dir.glob("*"):
            try:
                st = p.stat()
                key = datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d")
                for slot in series:
                    if slot["date"] == key:
                        slot["count"] += 1
                        break
            except Exception:
                continue
        return {"ok": True, "stats": stats, "series": series}

    # -- Window actions ----------------------------------------------------
    def minimize(self) -> None:
        if self._window:
            try:
                self._window.minimize()
            except Exception:
                pass

    def hide_to_tray(self) -> None:
        if self._window:
            try:
                self._window.hide()
            except Exception:
                pass

    def show(self) -> None:
        if self._window:
            try:
                self._window.show()
            except Exception:
                pass

    def lock(self) -> None:
        """Force PIN prompt again on next focus."""
        if self._window:
            try:
                self._window.evaluate_js("window.__jottr && window.__jottr.lock && window.__jottr.lock()")
            except Exception:
                pass

    def quit_app(self) -> None:
        # Stop tray first so the icon doesn't linger.
        try:
            if self._tray_icon:
                self._tray_icon.stop()
        except Exception:
            pass
        try:
            if self._hotkey_handle:
                keyboard.unhook(self._hotkey_handle)  # type: ignore
        except Exception:
            pass
        os._exit(0)

    # -- Tray icon ---------------------------------------------------------
    def start_tray(self, window) -> None:
        if not HAS_TRAY:
            return
        if self._tray_icon:
            return
        try:
            icon_img = self._make_tray_image()
            menu = pystray.Menu(
                _MI("Show Jottr", lambda: self.show()),
                _MI("New Note", lambda: (self.show(), self._eval("__jottr.newNote()"))),
                _MI("Lock", lambda: (self.show(), self.lock())),
                pystray.Menu.SEPARATOR,
                _MI("Quit", lambda: self.quit_app()),
            )
            self._tray_icon = pystray.Icon("jottr", icon_img, "Jottr", menu)
            self._tray_icon.run_detached()
        except Exception:
            self._tray_icon = None

    def _make_tray_image(self):
        # Simple 64x64 purple square with a glyph - no external asset needed.
        from PIL import Image, ImageDraw
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.rounded_rectangle((6, 6, 58, 58), radius=12, fill=(124, 92, 255, 255))
        d.rectangle((16, 20, 48, 24), fill=(255, 255, 255, 230))
        d.rectangle((16, 30, 48, 34), fill=(255, 255, 255, 200))
        d.rectangle((16, 40, 38, 44), fill=(255, 255, 255, 170))
        return img

    # -- Global hotkey -----------------------------------------------------
    def start_global_hotkey(self, window) -> None:
        if not HAS_KEYBOARD:
            return
        hk = self.config.get("global_hotkey") or "ctrl+alt+j"
        self._apply_hotkey(hk)

    def _apply_hotkey(self, hk: str) -> None:
        if not HAS_KEYBOARD:
            return
        try:
            if self._hotkey_handle:
                keyboard.unhook(self._hotkey_handle)  # type: ignore
                self._hotkey_handle = None
            if hk:
                self._hotkey_handle = keyboard.add_hotkey(  # type: ignore
                    hk, lambda: (self.show(), self._eval("__jottr.focusQuickNew()")),
                    suppress=False,
                )
        except Exception:
            self._hotkey_handle = None

    def _eval(self, expr: str) -> None:
        if self._window:
            try:
                self._window.evaluate_js(f"window.{expr} && window.{expr}()")
            except Exception:
                pass

    # -- Startup on boot (Windows) ----------------------------------------
    def _apply_startup(self, enable: bool) -> None:
        if sys.platform != "win32":
            return
        try:
            import winreg  # type: ignore
            key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
            exe = sys.executable if getattr(sys, "frozen", False) else sys.executable
            if getattr(sys, "frozen", False):
                cmd = f'"{exe}"'
            else:
                main_py = os.path.join(self.app_dir, "jottr.py")
                cmd = f'"{exe}" "{main_py}"'
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE) as k:
                if enable:
                    winreg.SetValueEx(k, "Jottr", 0, winreg.REG_SZ, cmd)
                else:
                    try:
                        winreg.DeleteValue(k, "Jottr")
                    except FileNotFoundError:
                        pass
        except Exception:
            pass

    # -- Explorer "Open with Jottr" context menu (Windows) ----------------
    def _apply_context_menu(self, enable: bool) -> None:
        if sys.platform != "win32":
            return
        try:
            import winreg  # type: ignore
            base = r"Software\Classes\*\shell\OpenWithJottr"
            if enable:
                exe = sys.executable if getattr(sys, "frozen", False) else sys.executable
                if getattr(sys, "frozen", False):
                    cmd = f'"{exe}" "%1"'
                else:
                    main_py = os.path.join(self.app_dir, "jottr.py")
                    cmd = f'"{exe}" "{main_py}" "%1"'
                with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base) as k:
                    winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "Open with Jottr")
                    winreg.SetValueEx(k, "Icon", 0, winreg.REG_SZ, exe)
                with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\command") as k:
                    winreg.SetValueEx(k, "", 0, winreg.REG_SZ, cmd)
            else:
                # Best-effort delete. winreg can't recurse-delete cleanly, so
                # we just clear the default value which disables it.
                try:
                    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, base, 0, winreg.KEY_SET_VALUE) as k:
                        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "")
                except FileNotFoundError:
                    pass
        except Exception:
            pass

    # -- Reveal in Explorer ------------------------------------------------
    def reveal_in_explorer(self, name: str) -> dict:
        if not name or "/" in name or "\\" in name or name.startswith("."):
            return {"ok": False, "error": "invalid name"}
        path = self.notes_dir / name
        if not path.exists():
            return {"ok": False, "error": "not found"}
        try:
            if sys.platform == "win32":
                subprocess.run(["explorer", "/select,", str(path)])
            elif sys.platform == "darwin":
                subprocess.run(["open", "-R", str(path)])
            else:
                subprocess.run(["xdg-open", str(str(path.parent))])
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True}

    # -- Diagnostics -------------------------------------------------------
    def ping(self) -> dict:
        return {"ok": True, "platform": platform.platform(), "py": sys.version.split()[0]}


# Allow `python jottr.py path\to\file.md` to open a file from the
# Explorer context menu.
def _cli_open() -> None:
    if len(sys.argv) < 2:
        main()
        return
    target = Path(sys.argv[1])
    if target.exists() and target.is_file():
        # Copy into notes dir then launch UI normally.
        app_dir = Path(os.path.dirname(os.path.abspath(__file__)))
        notes = app_dir / "notes"
        notes.mkdir(parents=True, exist_ok=True)
        dest = notes / target.name
        try:
            shutil.copy2(target, dest)
        except Exception:
            pass
    main()


if __name__ == "__main__":
    _cli_open()
