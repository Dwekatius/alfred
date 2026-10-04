#!/usr/bin/env python3
"""Local watchdog: physical-input detection + emergency stop hotkey.

- Low-level keyboard/mouse hooks record only timestamps of *non-injected*
  (physical) input to an activity file. No key content is ever recorded.
- A global hotkey writes a stop marker file that the supervisor consumes.

Usage:
  input_watch.py --activity-file PATH --stop-file PATH --hotkey Ctrl+Alt+F12
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json
import sys
import time

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

user32.SetWindowsHookExW.restype = ctypes.c_void_p
user32.SetWindowsHookExW.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, wt.DWORD]
user32.UnhookWindowsHookEx.argtypes = [ctypes.c_void_p]
user32.CallNextHookEx.restype = ctypes.c_long
user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, wt.WPARAM, wt.LPARAM]
user32.RegisterHotKey.restype = wt.BOOL
user32.RegisterHotKey.argtypes = [ctypes.c_void_p, ctypes.c_int, wt.UINT, wt.UINT]
user32.UnregisterHotKey.argtypes = [ctypes.c_void_p, ctypes.c_int]
user32.GetMessageW.restype = ctypes.c_int
user32.GetMessageW.argtypes = [ctypes.POINTER(wt.MSG), ctypes.c_void_p, wt.UINT, wt.UINT]
user32.PeekMessageW.restype = wt.BOOL
user32.PeekMessageW.argtypes = [ctypes.POINTER(wt.MSG), ctypes.c_void_p, wt.UINT, wt.UINT, wt.UINT]

WH_KEYBOARD_LL = 13
WH_MOUSE_LL = 14
WM_HOTKEY = 0x0312
WM_QUIT = 0x0012

LLKHF_INJECTED = 0x00000010
LLMHF_INJECTED = 0x00000001
LLMHF_LOWER_IL_INJECTED = 0x00000002

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008

VK_NAMES = {
    "ctrl": 0x11, "control": 0x11, "alt": 0x12, "shift": 0x10, "win": 0x5B,
    "enter": 0x0D, "esc": 0x1B, "escape": 0x1B, "tab": 0x09, "space": 0x20,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
    "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("vkCode", wt.DWORD),
        ("scanCode", wt.DWORD),
        ("flags", wt.DWORD),
        ("time", wt.DWORD),
        ("dwExtraInfo", ctypes.c_void_p),
    ]


class MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("pt", wt.POINT),
        ("mouseData", wt.DWORD),
        ("flags", wt.DWORD),
        ("time", wt.DWORD),
        ("dwExtraInfo", ctypes.c_void_p),
    ]


class Watcher:
    def __init__(self, activity_file: str, stop_file: str, hotkey: str, verbose: bool = False):
        self.activity_file = activity_file
        self.stop_file = stop_file
        self.hotkey = hotkey
        self.verbose = verbose
        self.last_activity_write = 0.0
        self.keyboard_proc = None
        self.mouse_proc = None

    def log(self, message: str) -> None:
        if self.verbose:
            print(message, file=sys.stderr, flush=True)

    def _write_activity(self, kind: str) -> None:
        now = time.time()
        # Throttle to at most 5 records per second.
        if now - self.last_activity_write < 0.2:
            return
        self.last_activity_write = now
        try:
            with open(self.activity_file, "a", encoding="utf-8") as handle:
                handle.write(json.dumps({"timestamp": now, "kind": kind}) + "\n")
        except OSError as exc:
            self.log(f"activity write failed: {exc}")

    def _keyboard_callback(self, n_code, w_param, l_param):
        if n_code >= 0:
            try:
                info = ctypes.cast(l_param, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
                if not (info.flags & LLKHF_INJECTED):
                    self._write_activity("keyboard")
            except Exception:
                pass
        return user32.CallNextHookEx(None, n_code, w_param, l_param)

    def _mouse_callback(self, n_code, w_param, l_param):
        if n_code >= 0:
            try:
                info = ctypes.cast(l_param, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
                if not (info.flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED)):
                    self._write_activity("mouse")
            except Exception:
                pass
        return user32.CallNextHookEx(None, n_code, w_param, l_param)

    def _register_hotkey(self) -> bool:
        if not self.hotkey:
            return False
        # RegisterHotKey requires a message queue for the calling thread.
        message = wt.MSG()
        user32.PeekMessageW(ctypes.byref(message), None, 0, 0, 0)
        parts = [part.strip().lower() for part in self.hotkey.replace(" ", "").split("+") if part.strip()]
        mods = 0
        vk = 0
        for part in parts:
            if part in ("ctrl", "control"):
                mods |= MOD_CONTROL
            elif part == "alt":
                mods |= MOD_ALT
            elif part == "shift":
                mods |= MOD_SHIFT
            elif part == "win":
                mods |= MOD_WIN
            elif part in VK_NAMES:
                vk = VK_NAMES[part]
            elif len(part) == 1:
                vk = user32.VkKeyScanW(ord(part)) & 0xFF
            elif part.startswith("0x"):
                vk = int(part, 16)
        if vk == 0:
            self.log(f"could not parse hotkey: {self.hotkey}")
            return False
        if not user32.RegisterHotKey(None, 1, mods, vk):
            self.log(f"RegisterHotKey failed for {self.hotkey} (error {ctypes.get_last_error()})")
            return False
        return True

    def run(self) -> int:
        keyboard_type = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_int, wt.WPARAM, wt.LPARAM)
        self.keyboard_proc = keyboard_type(self._keyboard_callback)
        self.mouse_proc = keyboard_type(self._mouse_callback)
        h_keyboard = user32.SetWindowsHookExW(WH_KEYBOARD_LL, ctypes.cast(self.keyboard_proc, ctypes.c_void_p), None, 0)
        h_mouse = user32.SetWindowsHookExW(WH_MOUSE_LL, ctypes.cast(self.mouse_proc, ctypes.c_void_p), None, 0)
        if not h_keyboard:
            self.log("keyboard hook failed")
        if not h_mouse:
            self.log("mouse hook failed")
        hotkey_ok = self._register_hotkey()
        print(json.dumps({"ready": True, "keyboardHook": bool(h_keyboard), "mouseHook": bool(h_mouse), "hotkey": hotkey_ok}), flush=True)
        message = wt.MSG()
        try:
            while user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
                if message.message == WM_HOTKEY and message.wParam == 1:
                    try:
                        with open(self.stop_file, "w", encoding="utf-8") as handle:
                            handle.write(json.dumps({"timestamp": time.time(), "source": "hotkey"}))
                    except OSError as exc:
                        self.log(f"stop marker write failed: {exc}")
        except KeyboardInterrupt:
            pass
        finally:
            if h_keyboard:
                user32.UnhookWindowsHookEx(h_keyboard)
            if h_mouse:
                user32.UnhookWindowsHookEx(h_mouse)
            if hotkey_ok:
                user32.UnregisterHotKey(None, 1)
        return 0


def main(argv: list[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--activity-file", required=True)
    parser.add_argument("--stop-file", required=True)
    parser.add_argument("--hotkey", default="Ctrl+Alt+F12")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv[1:])
    return Watcher(args.activity_file, args.stop_file, args.hotkey, args.verbose).run()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
