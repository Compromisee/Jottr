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
import re
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
            "version": 2,
            "app_version": "2.1.3",
            "theme": "midnight",
            "accent_color": "",
            "app_pin_hash": "",
            "pin_scope": "app",
            "startup": False,
            "global_hotkey": "ctrl+alt+j",
            "minimize_to_tray": True,
            "show_home": True,
            "recent": [],
            "pinned": [],
            "tags": {"notes": {}, "folders": {}},
            "pins": {},
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
            "plugins": {},
            "sidebar_collapsed": {},
            "sidebar_hidden": False,
        }

    def _save_config(self) -> None:
        _atomic_write(self.config_path, json.dumps(self.config, indent=2))

    # -- helpers used from JS ---------------------------------------------
    def get_config(self) -> dict:
        return self.config

    def update_settings(self, patch: dict) -> dict:
        # Whitelist updatable keys.
        allowed = {
            "theme", "accent_color", "app_pin_hash", "pin_scope", "startup",
            "global_hotkey", "minimize_to_tray", "show_home",
            "explorer_context_menu", "font_size", "show_line_numbers",
            "word_wrap", "pinned", "preview_default",
            "tags", "pins", "plugins", "sidebar_collapsed", "sidebar_hidden",
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

    # -- Color tags --------------------------------------------------------
    def set_tag(self, name: str, color: str, kind: str = "note") -> dict:
        """Set or clear the color tag for a note or folder.
        color = "" clears the tag."""
        try:
            self._safe_resolve(name)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        tags = self.config.setdefault("tags", {"notes": {}, "folders": {}})
        bucket = tags.get(kind + "s")
        if bucket is None:
            return {"ok": False, "error": "invalid kind"}
        key = name if kind == "note" else (name if name else "")
        if not color:
            bucket.pop(key, None)
        else:
            bucket[key] = color
        self._save_config()
        return {"ok": True, "name": name, "kind": kind, "color": color}

    def get_tags(self) -> dict:
        return self.config.get("tags", {"notes": {}, "folders": {}})

    # -- Per-file / per-folder PIN (stored in config, not the file) ------
    def set_pin(self, name: str, pin: str, kind: str = "note") -> dict:
        """Set or clear a per-file / per-folder PIN. Stored as a hash
        in config.json, NOT as a comment in the file itself."""
        try:
            self._safe_resolve(name)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        pins = self.config.setdefault("pins", {})
        key = name if kind == "note" else (name if name else "")
        if not pin:
            pins.pop(key, None)
        else:
            if len(pin) < 3:
                return {"ok": False, "error": "PIN must be at least 3 characters."}
            pins[key] = self._hash_pin(pin)
        self._save_config()
        return {"ok": True, "name": name, "kind": kind}

    def check_pin(self, name: str, pin: str, kind: str = "note") -> dict:
        """Returns whether the supplied pin unlocks name.
        Checks the entry itself AND any parent folder (folder pins
        apply to everything inside)."""
        pins = self.config.get("pins", {}) or {}
        # Check folder inheritance - if a parent folder has a pin, that
        # pin is required before opening anything inside.
        key = name if kind == "note" else (name if name else "")
        # Walk up the path looking for folder pins.
        if kind == "note" and name:
            parts = name.replace("\\", "/").split("/")
            # parts = ["work", "sub", "ideas.md"] - check ["work", "work/sub"]
            for i in range(len(parts) - 1, 0, -1):
                folder_key = "/".join(parts[:i])
                if folder_key in pins:
                    if not pin:
                        return {"ok": False, "required": True,
                                "scope": "folder", "folder": folder_key}
                    try:
                        algo, salt, want = pins[folder_key].split("$", 2)
                    except ValueError:
                        return {"ok": False, "error": "corrupt pin"}
                    got = hashlib.sha256((salt + pin).encode("utf-8")).hexdigest()
                    if not secrets.compare_digest(want, got):
                        return {"ok": False, "scope": "folder",
                                "folder": folder_key}
                    pin = None  # Folder pin consumed; continue to file pin.
        stored = pins.get(key)
        if not stored:
            return {"ok": True, "required": False}
        if not pin:
            return {"ok": False, "required": True, "scope": "file" if kind == "note" else "folder"}
        try:
            algo, salt, want = stored.split("$", 2)
        except ValueError:
            return {"ok": False, "error": "corrupt pin"}
        got = hashlib.sha256((salt + pin).encode("utf-8")).hexdigest()
        return {"ok": secrets.compare_digest(want, got), "scope": "file"}

    # -- Plugins -----------------------------------------------------------
    def list_plugins(self) -> dict:
        """Scan app_dir for *.plugg files, parse their manifest and
        return the list of plugins Jottr found."""
        plugins = []
        try:
            for p in sorted(self.app_dir.glob("*.plugg")):
                try:
                    txt = _safe_read(p)
                except Exception:
                    continue
                meta = self._parse_plugg(txt)
                if not meta:
                    continue
                meta["file"] = p.name
                meta["enabled"] = bool(
                    self.config.get("plugins", {}).get(meta["id"], {}).get("enabled", False))
                plugins.append(meta)
        except Exception:
            pass
        return {"ok": True, "plugins": plugins}

    def _parse_plugg(self, text: str) -> dict:
        """Parse the simple .plugg manifest format (see syntax.plugg).

        Sections delimited by `=name=` headers. The =meta= section
        is flattened into the top-level dict (id, name, version,
        author, description). =runtime=, =features=, =hooks= and
        =tags= are kept under their own keys.
        """
        meta = {}
        cur_section = None
        # For the meta section, accumulate continuation lines for
        # the same key (e.g. multi-line description).
        cur_key = None
        cur_value = []
        for raw in text.splitlines():
            line = raw.rstrip()
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if line.startswith("=") and line.endswith("="):
                # flush any pending meta key before switching.
                if cur_section == "meta" and cur_key is not None:
                    if cur_key in meta:
                        meta[cur_key] = str(meta[cur_key]) + "\n" + "\n".join(cur_value).strip()
                    else:
                        meta[cur_key] = "\n".join(cur_value).strip()
                    cur_key = None
                    cur_value = []
                cur_section = line.strip("=").strip().lower()
                continue
            if cur_section == "meta":
                # In the meta section, only a whitelist of well-known
                # keys starts a new key. Anything else is a continuation
                # line for the previous key (e.g. multi-line
                # description). The first non-blank line after a key
                # declaration becomes the value, subsequent lines
                # are appended until another key is seen.
                META_KEYS = {
                    "id", "name", "version", "author", "description",
                    "icon", "homepage", "license", "min_app_version",
                    "tags",
                }
                stripped = line.strip()
                is_key_line = False
                key_name = None
                key_value = ""
                m = re.match(r"^([a-z][a-z0-9_-]{1,30})(\s+(.*))?$", stripped)
                if m and m.group(1).lower() in META_KEYS:
                    is_key_line = True
                    key_name = m.group(1).lower()
                    key_value = (m.group(3) or "").strip()
                if is_key_line:
                    if cur_key is not None:
                        if cur_key in meta:
                            meta[cur_key] = str(meta[cur_key]) + "\n" + "\n".join(cur_value).strip()
                        else:
                            meta[cur_key] = "\n".join(cur_value).strip()
                    cur_key = key_name
                    cur_value = [key_value]
                elif cur_key is not None:
                    cur_value.append(stripped)
            elif cur_section == "runtime":
                m = re.match(r"^(\S+)\s+(.*)$", line)
                if m:
                    meta.setdefault("runtime", {})[m.group(1).lower()] = m.group(2).strip()
            elif cur_section == "features":
                if line.startswith("feature "):
                    meta.setdefault("features", []).append(line[len("feature "):].strip())
            elif cur_section == "hooks":
                if line.startswith("hook "):
                    meta.setdefault("hooks", []).append(line[len("hook "):].strip())
            elif cur_section == "tags":
                for tag in line.split(","):
                    tag = tag.strip()
                    if tag:
                        meta.setdefault("tags", []).append(tag)
        # Final flush for the last meta key.
        if cur_section == "meta" and cur_key is not None:
            if cur_key in meta:
                meta[cur_key] = str(meta[cur_key]) + "\n" + "\n".join(cur_value).strip()
            else:
                meta[cur_key] = "\n".join(cur_value).strip()
        if not meta.get("id") or not meta.get("name"):
            return {}
        return meta

    def set_plugin_enabled(self, plugin_id: str, enabled: bool) -> dict:
        plugins = self.config.setdefault("plugins", {})
        entry = plugins.setdefault(plugin_id, {})
        entry["enabled"] = bool(enabled)
        self._save_config()
        return {"ok": True, "id": plugin_id, "enabled": bool(enabled)}

    def encrypt_file(self, name: str, password: str) -> dict:
        """Encrypt a single note file using the bundled encryptor
        plugin (XOR + base64). The password MUST match any existing
        per-file PIN (we don't re-encrypt protected files silently)."""
        from plugins import encrypt_decrypt  # lazy import
        try:
            self._safe_resolve(name)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        path = (self.notes_dir / name)
        if not path.is_file():
            return {"ok": False, "error": "not a note"}
        try:
            txt = _safe_read(path)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        try:
            out = encrypt_decrypt.encrypt(txt, password)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        _atomic_write(path, out)
        return {"ok": True, "name": name, "size": len(out)}

    def decrypt_file(self, name: str, password: str) -> dict:
        from plugins import encrypt_decrypt
        try:
            self._safe_resolve(name)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        path = (self.notes_dir / name)
        if not path.is_file():
            return {"ok": False, "error": "not a note"}
        try:
            txt = _safe_read(path)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        try:
            out = encrypt_decrypt.decrypt(txt, password)
        except Exception as e:
            return {"ok": False, "error": "decryption failed (wrong password?)"}
        _atomic_write(path, out)
        return {"ok": True, "name": name, "size": len(out)}

    # -- Search -------------------------------------------------------------
    def search_notes(self, term, limit=20) -> dict:
        """Case-insensitive substring search across all notes.
        Returns a list of {name, snippet, kind} hits ordered by
        recent mtime."""
        if not term or not term.strip():
            return {"ok": True, "results": []}
        needle = term.strip().lower()
        out = []
        # Walk recursively so notes in folders are searchable too.
        paths = []
        def walk(d: Path):
            try:
                for p in sorted(d.iterdir(), key=lambda x: x.name.lower()):
                    if p.name.startswith("."):
                        continue
                    if p.is_dir():
                        walk(p)
                    elif self._note_ext_ok(p.name):
                        paths.append(p)
            except Exception:
                pass
        walk(self.notes_dir)
        paths.sort(key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
        for p in paths:
            try:
                txt = _safe_read(p)
            except Exception:
                continue
            low = txt.lower()
            i = low.find(needle)
            if i < 0:
                continue
            start = max(0, i - 30)
            end = min(len(txt), i + len(needle) + 40)
            snippet = txt[start:end].replace("\n", " ")
            if start > 0:
                snippet = "..." + snippet
            if end < len(txt):
                snippet = snippet + "..."
            try:
                full_name = str(p.relative_to(self.notes_dir.resolve())).replace("\\", "/")
            except ValueError:
                full_name = p.name
            out.append({
                "name": full_name,
                "snippet": snippet,
                "kind": "todo" if txt.lstrip().startswith("**todolist**") else "note",
                "mtime": p.stat().st_mtime,
            })
            if len(out) >= int(limit or 20):
                break
        return {"ok": True, "results": out}

    # -- Notes: list / read / save / delete --------------------------------
    def _safe_resolve(self, name: str) -> Path:
        """Resolve a possibly-folder-qualified name to a path inside
        notes_dir. Rejects absolute paths, '..' traversal, dotfiles,
        and any other escape attempts. Always returns an absolute path
        (which may not yet exist)."""
        if not name or not isinstance(name, str):
            raise ValueError("invalid name")
        clean = name.replace("\\", "/").strip("/")
        if not clean or clean.startswith("/") or "\x00" in clean:
            raise ValueError("invalid name")
        parts = [p for p in clean.split("/") if p]
        if not parts or any(p in (".", "..") or p.startswith(".") for p in parts):
            raise ValueError("invalid name")
        path = (self.notes_dir / clean).resolve()
        notes_resolved = self.notes_dir.resolve()
        if notes_resolved not in path.parents and path != notes_resolved:
            raise ValueError("path escapes notes dir")
        return path

    @staticmethod
    def _note_ext_ok(name: str) -> bool:
        return name.lower().endswith((".md", ".txt", ".jot"))

    def _split_note_name(self, full: str) -> tuple:
        """Split 'work/sub/ideas.md' -> ('work/sub', 'ideas.md')."""
        full = (full or "").replace("\\", "/").strip("/")
        if "/" in full:
            folder, base = full.rsplit("/", 1)
            return folder, base
        return "", full

    def list_notes(self, folder: str = "") -> dict:
        """List notes + immediate subfolders of `folder` ("" = root).
        Returns ok, folder, notes[{name,size,modified}], folders[]."""
        try:
            base = self._safe_resolve(folder) if folder else self.notes_dir
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        if not base.exists() or not base.is_dir():
            return {"ok": False, "error": "folder not found"}
        notes = []
        folders = []
        try:
            children = sorted(base.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except Exception:
            children = []
        for p in children:
            if p.name.startswith("."):
                continue
            try:
                rel = p.relative_to(self.notes_dir.resolve())
                full_name = str(rel).replace("\\", "/")
            except ValueError:
                full_name = p.name
            if p.is_dir():
                folders.append(full_name)
            elif self._note_ext_ok(p.name):
                st = p.stat()
                notes.append({
                    "name": full_name,
                    "size": st.st_size,
                    "modified": st.st_mtime,
                })
        rel = str(base.relative_to(self.notes_dir.resolve())).replace("\\", "/")
        return {
            "ok": True,
            "folder": rel if rel != "." else "",
            "notes": notes,
            "folders": folders,
        }

    def list_tree(self) -> dict:
        """Recursive listing. Returns ok, tree[{name,folders,notes}].
        Top-level result has name=''."""
        def walk(base: Path):
            try:
                children = sorted(base.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
            except Exception:
                return []
            out = []
            for p in children:
                if p.name.startswith("."):
                    continue
                try:
                    rel = p.relative_to(self.notes_dir.resolve())
                    full = str(rel).replace("\\", "/")
                except ValueError:
                    full = p.name
                if p.is_dir():
                    out.append({
                        "name": full,
                        "kind": "folder",
                        "children": walk(p),
                    })
                elif self._note_ext_ok(p.name):
                    out.append({
                        "name": full,
                        "kind": "note",
                        "size": p.stat().st_size,
                        "modified": p.stat().st_mtime,
                    })
            return out
        return {"ok": True, "tree": walk(self.notes_dir)}

    def read_note(self, name: str) -> dict:
        try:
            path = self._safe_resolve(name)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        if not path.exists():
            return {"ok": True, "content": "", "created": True, "name": name}
        return {"ok": True, "content": _safe_read(path), "mtime": path.stat().st_mtime,
                "name": name}

    def save_note(self, name: str, content: str) -> dict:
        try:
            path = self._safe_resolve(name)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        # Auto-add .md if user omitted extension - but warn via flag.
        ext_added = False
        if not self._note_ext_ok(path.name):
            path = path.with_name(path.name + ".md")
            ext_added = True
        # Atomic write -> never truncates even if interrupted.
        _atomic_write(path, content)
        actual = str(path.relative_to(self.notes_dir.resolve())).replace("\\", "/")
        self._push_recent(actual)
        words = len([w for w in content.split() if w])
        self._bump_stats(words_added=words)
        return {
            "ok": True,
            "mtime": path.stat().st_mtime,
            "size": len(content),
            "name": actual,
            "extension_added": ext_added,
        }

    def delete_note(self, name: str) -> dict:
        try:
            path = self._safe_resolve(name)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        if not path.is_file():
            return {"ok": True, "existed": False}
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return {"ok": True}

    def new_note(self, name: str | None = None, kind: str = "note",
                 folder: str = "") -> dict:
        """Create a blank note or a todolist stub.

        Returns {ok, name, folder, extension_added}.
        `extension_added` is True when the user-supplied name lacked
        .md/.txt and Jottr auto-appended .md (so the UI can warn)."""
        ext = ".md"
        base = (name or "").strip()
        ext_added = False
        if not base:
            ts = datetime.now().strftime("%Y-%m-%d-%H%M%S")
            base = "note" if kind == "note" else "todo"
            file_name = f"{base}-{ts}{ext}"
        else:
            if not self._note_ext_ok(base):
                file_name = base + ext
                ext_added = True
            else:
                file_name = base
        folder = (folder or "").replace("\\", "/").strip("/")
        if folder:
            full_name = folder + "/" + file_name
        else:
            full_name = file_name
        try:
            path = self._safe_resolve(full_name)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        if path.exists():
            i = 2
            while True:
                cand = path.with_name(path.stem + f"-{i}" + path.suffix)
                if not cand.exists():
                    actual_name = str(cand.relative_to(self.notes_dir.resolve())).replace("\\", "/")
                    path = cand
                    break
                i += 1
            full_name = actual_name
        else:
            full_name = str(path.relative_to(self.notes_dir.resolve())).replace("\\", "/")
        path.parent.mkdir(parents=True, exist_ok=True)
        content = "**todolist**\n\n- [ ] " if kind == "todo" else ""
        _atomic_write(path, content)
        self._push_recent(full_name)
        return {
            "ok": True,
            "name": full_name,
            "folder": folder,
            "extension_added": ext_added,
        }

    # -- Folders -----------------------------------------------------------
    def create_folder(self, name: str, parent: str = "") -> dict:
        """Create a new folder. `name` may be a nested path like
        'projects/2024' - intermediate folders are created on the fly."""
        if not name or not isinstance(name, str):
            return {"ok": False, "error": "invalid folder name"}
        clean = name.replace("\\", "/").strip("/")
        if not clean:
            return {"ok": False, "error": "invalid folder name"}
        for seg in clean.split("/"):
            if not seg or seg in (".", "..") or seg.startswith("."):
                return {"ok": False, "error": "invalid folder name"}
        parent = (parent or "").replace("\\", "/").strip("/")
        full = (parent + "/" if parent else "") + clean
        try:
            path = self._safe_resolve(full)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        if path.exists():
            return {"ok": False, "error": "already exists"}
        try:
            path.mkdir(parents=True)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "name": full}

    def delete_folder(self, name: str, parent: str = "") -> dict:
        name = (name or "").strip().strip("/")
        if not name:
            return {"ok": False, "error": "invalid folder name"}
        parent = (parent or "").replace("\\", "/").strip("/")
        full = (parent + "/" if parent else "") + name
        try:
            path = self._safe_resolve(full)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        if not path.is_dir():
            return {"ok": False, "error": "not a folder"}
        visible = [c for c in path.iterdir() if not c.name.startswith(".")]
        if visible:
            return {"ok": False, "error": "folder is not empty"}
        try:
            path.rmdir()
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "name": full}

    def rename_folder(self, old: str, new_name: str, parent: str = "") -> dict:
        new_name = (new_name or "").strip().strip("/")
        if not new_name or "/" in new_name or "\\" in new_name \
                or new_name in (".", "..") or new_name.startswith("."):
            return {"ok": False, "error": "invalid folder name"}
        parent = (parent or "").replace("\\", "/").strip("/")
        old_full = (parent + "/" if parent else "") + old
        new_full = (parent + "/" if parent else "") + new_name
        try:
            old_path = self._safe_resolve(old_full)
            new_path = self._safe_resolve(new_full)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        if not old_path.is_dir():
            return {"ok": False, "error": "not a folder"}
        if new_path.exists():
            return {"ok": False, "error": "destination exists"}
        try:
            old_path.rename(new_path)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "name": new_full}

    def move_note(self, name: str, new_folder: str) -> dict:
        """Move a note into a different folder (or "" = root)."""
        try:
            src = self._safe_resolve(name)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        if not src.is_file():
            return {"ok": False, "error": "not a note"}
        new_folder = (new_folder or "").replace("\\", "/").strip("/")
        new_full = (new_folder + "/" if new_folder else "") + src.name
        try:
            dst = self._safe_resolve(new_full)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        if dst.exists():
            return {"ok": False, "error": "destination exists"}
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            src.rename(dst)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "name": new_full}

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
        # Build 7-day series from recent file mtimes (walks folders).
        series = []
        for i in range(6, -1, -1):
            d = datetime.now() - timedelta(days=i)
            key = d.strftime("%Y-%m-%d")
            series.append({"date": key, "label": d.strftime("%a"), "count": 0})
        def walk(d: Path):
            try:
                for p in d.iterdir():
                    if p.name.startswith("."):
                        continue
                    if p.is_dir():
                        walk(p)
                        continue
                    try:
                        st = p.stat()
                        key = datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d")
                        for slot in series:
                            if slot["date"] == key:
                                slot["count"] += 1
                                break
                    except Exception:
                        continue
            except Exception:
                pass
        walk(self.notes_dir)
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
