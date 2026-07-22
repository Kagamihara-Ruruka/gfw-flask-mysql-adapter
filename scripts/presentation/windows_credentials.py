from __future__ import annotations

import ctypes
import os
from ctypes import wintypes


CRED_TYPE_GENERIC = 1
CRED_PERSIST_LOCAL_MACHINE = 2
ERROR_NOT_FOUND = 1168


class _CREDENTIAL_ATTRIBUTEW(ctypes.Structure):
    _fields_ = [
        ("Keyword", wintypes.LPWSTR),
        ("Flags", wintypes.DWORD),
        ("ValueSize", wintypes.DWORD),
        ("Value", ctypes.POINTER(ctypes.c_ubyte)),
    ]


class _CREDENTIALW(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR),
        ("Comment", wintypes.LPWSTR),
        ("LastWritten", wintypes.FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.POINTER(_CREDENTIAL_ATTRIBUTEW)),
        ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]


class WindowsCredentialStore:
    """Store a generic secret in the current user's Windows Credential Manager."""

    def __init__(self, target: str) -> None:
        if not target.strip():
            raise ValueError("Credential target must not be empty.")
        self.target = target
        self._api: ctypes.WinDLL | None = None

    def read(self) -> tuple[str, str] | None:
        api = self._load_api()
        credential_pointer = ctypes.POINTER(_CREDENTIALW)()
        if not api.CredReadW(
            self.target,
            CRED_TYPE_GENERIC,
            0,
            ctypes.byref(credential_pointer),
        ):
            error = ctypes.get_last_error()
            if error == ERROR_NOT_FOUND:
                return None
            raise ctypes.WinError(error)

        try:
            credential = credential_pointer.contents
            blob = ctypes.string_at(
                credential.CredentialBlob,
                credential.CredentialBlobSize,
            )
            return credential.UserName or "", blob.decode("utf-16-le")
        finally:
            api.CredFree(credential_pointer)

    def write(self, username: str, password: str) -> None:
        if not password:
            raise ValueError("Password must not be empty.")
        api = self._load_api()
        encoded = password.encode("utf-16-le")
        blob = (ctypes.c_ubyte * len(encoded)).from_buffer_copy(encoded)
        credential = _CREDENTIALW()
        credential.Type = CRED_TYPE_GENERIC
        credential.TargetName = self.target
        credential.CredentialBlobSize = len(encoded)
        credential.CredentialBlob = ctypes.cast(blob, ctypes.POINTER(ctypes.c_ubyte))
        credential.Persist = CRED_PERSIST_LOCAL_MACHINE
        credential.UserName = username
        if not api.CredWriteW(ctypes.byref(credential), 0):
            raise ctypes.WinError(ctypes.get_last_error())

    def delete(self) -> None:
        api = self._load_api()
        if api.CredDeleteW(self.target, CRED_TYPE_GENERIC, 0):
            return
        error = ctypes.get_last_error()
        if error != ERROR_NOT_FOUND:
            raise ctypes.WinError(error)

    def _load_api(self) -> ctypes.WinDLL:
        if os.name != "nt":
            raise OSError("Windows Credential Manager is available only on Windows.")
        if self._api is not None:
            return self._api

        api = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
        api.CredWriteW.argtypes = [ctypes.POINTER(_CREDENTIALW), wintypes.DWORD]
        api.CredWriteW.restype = wintypes.BOOL
        api.CredReadW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.POINTER(ctypes.POINTER(_CREDENTIALW)),
        ]
        api.CredReadW.restype = wintypes.BOOL
        api.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
        api.CredDeleteW.restype = wintypes.BOOL
        api.CredFree.argtypes = [ctypes.c_void_p]
        api.CredFree.restype = None
        self._api = api
        return api
