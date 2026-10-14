#!/usr/bin/env python3
"""Inspect a signed Tauri archive without extracting or executing its contents."""
import json
import plistlib
import posixpath
import struct
import sys
import tarfile


def inspect(archive):
    entries = {}
    with tarfile.open(archive, "r:gz") as bundle:
        for entry in bundle:
            name = entry.name
            if name.startswith("./"):
                name = name[2:]
            if (not name or name.startswith("/") or "\\" in name or
                    any(part in ("", ".", "..") for part in name.rstrip("/").split("/"))):
                raise ValueError("unsafe archive path")
            name = name.rstrip("/")
            if name != "MoXBots.app" and not name.startswith("MoXBots.app/"):
                raise ValueError("archive must contain only MoXBots.app")
            if name in entries:
                raise ValueError("duplicate archive entry")
            if not (entry.isfile() or entry.isdir() or entry.issym() or entry.islnk()):
                raise ValueError("unsupported archive entry type")
            entries[name] = entry
        def resolve_link(name, entry):
            pending = ((posixpath.dirname(name) + "/" + entry.linkname)
                       if entry.issym() else entry.linkname).split("/")
            resolved, hops = [], 0
            while pending:
                part = pending.pop(0)
                if part in ("", "."):
                    continue
                if part == "..":
                    if len(resolved) <= 1:
                        raise ValueError("archive link escapes application")
                    resolved.pop()
                    continue
                resolved.append(part)
                if resolved[0] != "MoXBots.app":
                    raise ValueError("archive link escapes application")
                linked = entries.get("/".join(resolved))
                if linked and linked.issym():
                    hops += 1
                    if hops > 64:
                        raise ValueError("cyclic or excessive archive links")
                    resolved.pop()
                    pending = linked.linkname.split("/") + pending
            if len(resolved) <= 1:
                raise ValueError("archive link resolves outside application contents")
            return "/".join(resolved)

        for name, entry in entries.items():
            parent = posixpath.dirname(name)
            while parent:
                if parent in entries and not entries[parent].isdir():
                    raise ValueError("archive entry below a link or non-directory")
                parent = posixpath.dirname(parent)
            if entry.issym() or entry.islnk():
                if entry.linkname.startswith("/") or "\\" in entry.linkname:
                    raise ValueError("absolute or malformed archive link")
                target = resolve_link(name, entry)
                if entry.islnk() and (target not in entries or not entries[target].isfile()):
                    raise ValueError("hardlink must target a regular application file")
        plist_entry = entries.get("MoXBots.app/Contents/Info.plist")
        if plist_entry is None or not plist_entry.isfile() or plist_entry.size > 1048576:
            raise ValueError("missing or invalid application Info.plist")
        plist = plistlib.loads(bundle.extractfile(plist_entry).read())
        if plist.get("CFBundleIdentifier") != "com.moxbot.app":
            raise ValueError("incorrect application identifier")
        executable = plist.get("CFBundleExecutable", "")
        if not executable or "/" in executable or "\\" in executable or executable in (".", ".."):
            raise ValueError("invalid executable name")
        binary = entries.get("MoXBots.app/Contents/MacOS/" + executable)
        if binary is None or not binary.isfile() or not binary.mode & 0o111:
            raise ValueError("missing executable")
        header = bundle.extractfile(binary).read(8)
        # An arm64 release must have an arm64 executable, not a mislabeled x86_64 archive.
        if len(header) != 8 or struct.unpack("<II", header) != (0xFEEDFACF, 0x0100000C):
            raise ValueError("executable is not thin macOS arm64 Mach-O")
        version = plist.get("CFBundleShortVersionString")
        return {"version": version, "identifier": plist["CFBundleIdentifier"],
                "app": "MoXBots.app", "architecture": "aarch64", "entries": len(entries)}


if __name__ == "__main__":
    try:
        print(json.dumps(inspect(sys.argv[1])))
    except Exception as error:
        print("Archive rejected: " + str(error), file=sys.stderr)
        sys.exit(1)
