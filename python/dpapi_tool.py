#!/usr/bin/env python3
"""DPAPI protect/unprotect helper.

Reads bytes from stdin, writes base64 ciphertext/plaintext to stdout.
Uses the Windows Data Protection API for the current user; no custom crypto.

Usage:
  python dpapi_tool.py protect   < plaintext > base64blob
  python dpapi_tool.py unprotect < base64blob > plaintext
"""
from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes as wt
import sys

CRYPTPROTECT_UI_FORBIDDEN = 0x01


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _crypt32():
    if sys.platform != "win32":
        raise RuntimeError("DPAPI is only available on Windows")
    return ctypes.windll.crypt32


def _kernel32():
    return ctypes.windll.kernel32


def _to_blob(data: bytes) -> DATA_BLOB:
    buf = ctypes.create_string_buffer(data, len(data))
    return DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))


def _blob_bytes(blob: DATA_BLOB) -> bytes:
    return ctypes.string_at(blob.pbData, blob.cbData)


def protect(data: bytes) -> bytes:
    in_blob = _to_blob(data)
    out_blob = DATA_BLOB()
    ok = _crypt32().CryptProtectData(
        ctypes.byref(in_blob), None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out_blob)
    )
    if not ok:
        raise ctypes.WinError()
    try:
        return _blob_bytes(out_blob)
    finally:
        _kernel32().LocalFree(out_blob.pbData)


def unprotect(data: bytes) -> bytes:
    in_blob = _to_blob(data)
    out_blob = DATA_BLOB()
    ok = _crypt32().CryptUnprotectData(
        ctypes.byref(in_blob), None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out_blob)
    )
    if not ok:
        raise ctypes.WinError()
    try:
        return _blob_bytes(out_blob)
    finally:
        _kernel32().LocalFree(out_blob.pbData)


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] not in ("protect", "unprotect"):
        print("usage: dpapi_tool.py protect|unprotect < input > output", file=sys.stderr)
        return 2
    raw = sys.stdin.buffer.read()
    if argv[1] == "protect":
        sys.stdout.buffer.write(base64.b64encode(protect(raw)))
    else:
        sys.stdout.buffer.write(unprotect(base64.b64decode(raw)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
