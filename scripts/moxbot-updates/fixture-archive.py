"""Synthetic arm64 archive for release-policy tests; never an installable application."""
import io
import plistlib
import struct
import sys
import tarfile

archive, version, variant = sys.argv[1:]
with tarfile.open(archive, "w:gz") as tar:
    def add(name, payload, mode=0o644):
        item = tarfile.TarInfo(name)
        item.size, item.mode = len(payload), mode
        tar.addfile(item, io.BytesIO(payload))
    plist = {"CFBundleIdentifier": "com.moxbot.app" if variant != "wrong-brand" else "com.myagents.app",
             "CFBundleShortVersionString": version, "CFBundleExecutable": "MoXBots"}
    add("MoXBots.app/Contents/Info.plist", plistlib.dumps(plist))
    add("MoXBots.app/Contents/MacOS/MoXBots", struct.pack("<II", 0xFEEDFACF,
        0x01000007 if variant == "wrong-arch" else 0x0100000C) + variant.encode(), 0o755)
    if variant == "traversal":
        add("MoXBots.app/../../outside", b"unsafe")
    if variant == "escape-link":
        entry = tarfile.TarInfo("MoXBots.app/Contents/escape")
        entry.type, entry.linkname = tarfile.SYMTYPE, "../../../outside"
        tar.addfile(entry)
    if variant in ("chain-escape", "cycle"):
        for name, target in ([('foo', '../lib'), ('escape', 'foo/../../outside')]
                             if variant == 'chain-escape' else [('foo', 'bar'), ('bar', 'foo')]):
            entry = tarfile.TarInfo("MoXBots.app/Contents/" + name)
            entry.type, entry.linkname = tarfile.SYMTYPE, target
            tar.addfile(entry)
    if variant == "duplicate":
        add("MoXBots.app/Contents/Info.plist", plistlib.dumps(plist))
    if variant == "under-link":
        entry = tarfile.TarInfo("MoXBots.app/Contents/foo")
        entry.type, entry.linkname = tarfile.SYMTYPE, '../lib'
        tar.addfile(entry)
        add("MoXBots.app/Contents/foo/nested", b"nested")
