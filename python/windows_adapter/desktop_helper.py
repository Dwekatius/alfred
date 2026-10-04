#!/usr/bin/env python3
"""Small Windows capability helper for the Telegram Pi agent.

One-shot JSON CLI: reads a JSON request on stdin, writes a JSON response to
stdout. Diagnostics go to stderr. Covers capabilities missing from the pinned
Windows-MCP build:

  session_state        locked/unlocked interactive session
  monitors             monitor bounds (virtual-desktop physical px) + DPI scale
  foreground_window    foreground window identity and rectangle
  key_hold             press keys, hold, release in a finally path
  release_keys         release only the given keys

This is infrastructure, not an agent.
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json
import sys
import time

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
shcore = None
try:
    shcore = ctypes.windll.shcore
except OSError:
    shcore = None

try:
    # PER_MONITOR_AWARE_V2
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    try:
        shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass


def _read_request():
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def session_state() -> dict:
    """Return locked state and session info using the input desktop name."""
    result: dict = {"locked": None, "desktop": None, "error": None}
    try:
        h_desk = user32.OpenInputDesktop(0, False, 0x0100)  # DESKTOP_READOBJECTS
        if not h_desk:
            # Opening the input desktop usually fails while the lock screen owns it.
            result["locked"] = True
        else:
            try:
                needed = wt.DWORD(0)
                user32.GetUserObjectInformationW(h_desk, 2, None, 0, ctypes.byref(needed))
                buf = ctypes.create_unicode_buffer(max(needed.value // 2, 2))
                if user32.GetUserObjectInformationW(h_desk, 2, buf, ctypes.sizeof(buf), ctypes.byref(needed)):
                    result["desktop"] = buf.value
                    result["locked"] = buf.value.lower() != "default"
                else:
                    result["locked"] = None
            finally:
                user32.CloseDesktop(h_desk)
    except Exception as exc:  # pragma: no cover - defensive
        result["error"] = str(exc)
    return result


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


MONITORINFOF_PRIMARY = 0x1


class MONITORINFOEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wt.DWORD),
        ("rcMonitor", RECT),
        ("rcWork", RECT),
        ("dwFlags", wt.DWORD),
        ("szDevice", ctypes.c_wchar * 32),
    ]


def monitors() -> dict:
    result = []
    monitor_enum_proc = ctypes.WINFUNCTYPE(
        ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(RECT), ctypes.c_void_p
    )

    def _callback(hmonitor, hdc, lprect, lparam):
        info = MONITORINFOEXW()
        info.cbSize = ctypes.sizeof(MONITORINFOEXW)
        if user32.GetMonitorInfoW(hmonitor, ctypes.byref(info)):
            dpi_x = dpi_y = 96
            if shcore is not None:
                try:
                    dx = wt.UINT(96)
                    dy = wt.UINT(96)
                    shcore.GetDpiForMonitor(hmonitor, 0, ctypes.byref(dx), ctypes.byref(dy))
                    dpi_x, dpi_y = dx.value, dy.value
                except Exception:
                    pass
            result.append(
                {
                    "device": info.szDevice,
                    "left": info.rcMonitor.left,
                    "top": info.rcMonitor.top,
                    "right": info.rcMonitor.right,
                    "bottom": info.rcMonitor.bottom,
                    "width": info.rcMonitor.right - info.rcMonitor.left,
                    "height": info.rcMonitor.bottom - info.rcMonitor.top,
                    "primary": bool(info.dwFlags & MONITORINFOF_PRIMARY),
                    "dpi": dpi_x,
                    "scale": round(dpi_x / 96.0, 4),
                }
            )
        return 1

    user32.EnumDisplayMonitors(None, None, monitor_enum_proc(_callback), None)
    return {"monitors": result}


def foreground_window() -> dict:
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return {"handle": None}
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    pid = wt.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    rect = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return {
        "handle": hex(hwnd),
        "title": buf.value,
        "pid": pid.value,
        "rect": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom, "width": rect.right - rect.left, "height": rect.bottom - rect.top},
    }


VK_NAMES = {
    "ctrl": 0x11,
    "control": 0x11,
    "alt": 0x12,
    "shift": 0x10,
    "win": 0x5B,
    "enter": 0x0D,
    "return": 0x0D,
    "esc": 0x1B,
    "escape": 0x1B,
    "tab": 0x09,
    "space": 0x20,
    "backspace": 0x08,
    "delete": 0x2E,
    "del": 0x2E,
    "up": 0x26,
    "down": 0x28,
    "left": 0x25,
    "right": 0x27,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "pagedown": 0x22,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
    "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004


def _parse_keys(spec: str) -> list[int]:
    vks: list[int] = []
    for part in spec.replace(" ", "").split("+"):
        if not part:
            continue
        lowered = part.lower()
        if lowered in VK_NAMES:
            vks.append(VK_NAMES[lowered])
        elif len(lowered) == 1:
            vks.append(user32.VkKeyScanW(ord(lowered)) & 0xFF)
        elif lowered.startswith("0x"):
            vks.append(int(lowered, 16))
        else:
            raise ValueError(f"Unknown key: {part}")
    if not vks:
        raise ValueError("No keys provided")
    return vks


def _send_vk(vk: int, keyup: bool) -> None:
    flags = KEYEVENTF_KEYUP if keyup else 0
    user32.keybd_event(vk, 0, flags, 0)


def key_hold(keys: str, ms: int) -> dict:
    vks = _parse_keys(keys)
    pressed: list[int] = []
    try:
        for vk in vks:
            _send_vk(vk, False)
            pressed.append(vk)
        time.sleep(max(0, ms) / 1000.0)
    finally:
        for vk in reversed(pressed):
            _send_vk(vk, True)
    return {"keys": keys, "holdMs": max(0, ms), "released": [hex(vk) for vk in reversed(pressed)]}


def release_keys(keys: list[str]) -> dict:
    released = []
    for spec in keys:
        for vk in _parse_keys(spec):
            _send_vk(vk, True)
            released.append(hex(vk))
    return {"released": released}


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wt.WORD),
        ("wScan", wt.WORD),
        ("dwFlags", wt.DWORD),
        ("time", wt.DWORD),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wt.LONG),
        ("dy", wt.LONG),
        ("mouseData", wt.DWORD),
        ("dwFlags", wt.DWORD),
        ("time", wt.DWORD),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wt.DWORD), ("wParamL", wt.WORD), ("wParamH", wt.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("u", _INPUTUNION)]


INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004


def type_text(text: str) -> dict:
    """Type Unicode text into the currently focused control (no click)."""
    user32.SendInput.restype = wt.UINT
    user32.SendInput.argtypes = [wt.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
    units: list[int] = []
    for char in text:
        encoded = char.encode("utf-16-le")
        for index in range(0, len(encoded), 2):
            units.append(int.from_bytes(encoded[index : index + 2], "little"))
    # Include newlines/tabs as real key presses where possible.
    inputs: list[INPUT] = []
    for unit in units:
        if unit == 0x0A:
            vk = 0x0D
            inputs.append(INPUT(type=INPUT_KEYBOARD, u=_INPUTUNION(ki=KEYBDINPUT(vk, 0, 0, 0, None))))
            inputs.append(INPUT(type=INPUT_KEYBOARD, u=_INPUTUNION(ki=KEYBDINPUT(vk, 0, KEYEVENTF_KEYUP, 0, None))))
            continue
        if unit == 0x09:
            vk = 0x09
            inputs.append(INPUT(type=INPUT_KEYBOARD, u=_INPUTUNION(ki=KEYBDINPUT(vk, 0, 0, 0, None))))
            inputs.append(INPUT(type=INPUT_KEYBOARD, u=_INPUTUNION(ki=KEYBDINPUT(vk, 0, KEYEVENTF_KEYUP, 0, None))))
            continue
        inputs.append(INPUT(type=INPUT_KEYBOARD, u=_INPUTUNION(ki=KEYBDINPUT(0, unit, KEYEVENTF_UNICODE, 0, None))))
        inputs.append(INPUT(type=INPUT_KEYBOARD, u=_INPUTUNION(ki=KEYBDINPUT(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, None))))
    if not inputs:
        return {"typed": 0}
    array = (INPUT * len(inputs))(*inputs)
    sent = user32.SendInput(len(inputs), array, ctypes.sizeof(INPUT))
    if sent != len(inputs):
        raise RuntimeError(f"SendInput sent {sent} of {len(inputs)} events (error {ctypes.get_last_error()})")
    return {"typed": len(text), "units": len(units)}


def hotkey_check(keys: str) -> dict:
    user32.PeekMessageW(ctypes.byref(wt.MSG()), None, 0, 0, 0)
    parts = [part.strip().lower() for part in str(keys).replace(" ", "").split("+") if part.strip()]
    mods = 0
    vk = 0
    for part in parts:
        if part in ("ctrl", "control"):
            mods |= 0x0002
        elif part == "alt":
            mods |= 0x0001
        elif part == "shift":
            mods |= 0x0004
        elif part == "win":
            mods |= 0x0008
        elif part in VK_NAMES:
            vk = VK_NAMES[part]
        elif len(part) == 1:
            vk = user32.VkKeyScanW(ord(part)) & 0xFF
        elif part.startswith("0x"):
            vk = int(part, 16)
    if vk == 0:
        return {"available": False, "error": f"could not parse hotkey: {keys}"}
    ok = bool(user32.RegisterHotKey(None, 1, mods, vk))
    if ok:
        user32.UnregisterHotKey(None, 1)
    return {"available": ok, "hotkey": keys}


def window_at(x: int, y: int) -> dict:
    point = wt.POINT(int(x), int(y))
    hwnd = user32.WindowFromPoint(point)
    if not hwnd:
        return {"handle": None, "title": None}
    root = user32.GetAncestor(hwnd, 2)  # GA_ROOT
    target = root or hwnd
    length = user32.GetWindowTextLengthW(target)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(target, buf, length + 1)
    pid = wt.DWORD(0)
    user32.GetWindowThreadProcessId(target, ctypes.byref(pid))
    return {"handle": hex(target), "title": buf.value, "pid": pid.value}


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: desktop_helper.py <command> < request.json > response.json", file=sys.stderr)
        return 2
    command = argv[1]
    try:
        request = _read_request()
        if command == "session_state":
            response = session_state()
        elif command == "monitors":
            response = monitors()
        elif command == "foreground_window":
            response = foreground_window()
        elif command == "key_hold":
            response = key_hold(str(request.get("keys", "")), int(request.get("ms", 100)))
        elif command == "release_keys":
            response = release_keys(list(request.get("keys", [])))
        elif command == "hotkey_check":
            response = hotkey_check(str(request.get("hotkey", "Ctrl+Alt+F12")))
        elif command == "type_text":
            response = type_text(str(request.get("text", "")))
        elif command == "window_at":
            response = window_at(int(request.get("x", 0)), int(request.get("y", 0)))
        else:
            print(f"unknown command: {command}", file=sys.stderr)
            return 2
        sys.stdout.write(json.dumps(response))
        return 0
    except Exception as exc:  # pragma: no cover - defensive
        sys.stdout.write(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
