"""encrypt_decrypt - Jottr's first bundled plugin.

Encrypts note files with a password so you can stash them on a USB
stick or in cloud storage without worrying about casual snooping.
Uses XOR + base64 so it has zero external dependencies. Not
cryptographically strong (XOR cipher) but plenty for at-rest
personal notes - Jottr is not a password manager.

Usage from the UI:
  - Right-click a note -> "Encrypt with password..."
  - Right-click an encrypted note -> "Decrypt..."

The plugin works file-by-file. The password is NOT stored; Jottr
just transforms the bytes. To decrypt, you need the same password.
"""
import base64


# ---------- Public API ---------------------------------------------------

PLUGIN_META = {
    "id": "encrypt_decrypt",
    "name": "Note Encryptor",
    "version": "1.0.0",
    "description": "Encrypt individual note files with a password so "
                   "you can keep them on USB sticks or cloud storage "
                   "without exposing your text.",
    "author": "Jottr",
    "icon": "lock",
    "features": [
        "encrypt_note",
        "decrypt_note",
        "encrypt_all",
    ],
    "hooks": ["context_menu_file", "context_menu_folder"],
}


def register():
    """Called by Jottr when scanning plugins."""
    return PLUGIN_META


def activate(api):
    pass


def deactivate():
    pass


# ---------- Crypto -------------------------------------------------------

_MAGIC = b"JOTTR\x01"
_SENTINEL_OK = b"X\x01X"


def _xor(data, key):
    if not key:
        raise ValueError("empty key")
    out = bytearray(len(data))
    klen = len(key)
    for i, b in enumerate(data):
        out[i] = b ^ key[i % klen]
    return bytes(out)


def encrypt(plaintext, password):
    """Encrypt `plaintext` with `password`. Returns a tagged,
    base64-encoded blob."""
    if not password:
        raise ValueError("password is empty")
    body = plaintext.encode("utf-8")
    body_with_sentinel = body + _SENTINEL_OK
    key = password.encode("utf-8")
    cipher = _xor(body_with_sentinel, key)
    blob = _MAGIC + cipher
    return base64.b64encode(blob).decode("ascii")


def decrypt(blob_b64, password):
    """Reverse of encrypt(). Raises ValueError on wrong password."""
    blob = base64.b64decode(blob_b64.encode("ascii"))
    if not blob.startswith(_MAGIC):
        raise ValueError("not a Jottr-encrypted file")
    cipher = blob[len(_MAGIC):]
    key = password.encode("utf-8")
    plain_with_sentinel = _xor(cipher, key)
    if not plain_with_sentinel.endswith(_SENTINEL_OK):
        raise ValueError("wrong password")
    return plain_with_sentinel[: -len(_SENTINEL_OK)].decode("utf-8")


def is_encrypted(text):
    """Returns True if the file looks like a Jottr-encrypted note."""
    if not text:
        return False
    try:
        head = base64.b64decode(text[:32].encode("ascii"), validate=False)
    except Exception:
        return False
    return head.startswith(_MAGIC)
