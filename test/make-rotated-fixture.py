#!/usr/bin/env python3
"""Make a rotation-metadata fixture from a plain MP4.

Phone videos carry rotation in the tkhd display matrix, not in pixels:
ffmpeg's mov muxer does not write a `rotate` tag from `-metadata`
(verified 2026-11-16 on ffmpeg 8.1.2 — the tag is silently dropped),
so this script patches the tkhd box directly. The matrix + width/height
swap are exactly what a phone file looks like; ffprobe then reports
`side_data_list: [{side_data_type: "Display Matrix", rotation: -90}]`
for 90 deg clockwise, and ffmpeg decodes the file autorotated
(720x1280 out of a 1280x720 coded stream).

Usage: make-rotated-fixture.py <rotation 90|180|270> <in.mp4> <out.mp4>
"""
import struct
import sys

MATRICES = {
    # 16.16 fixed-point, row-major [a b 0 / c d 0 / 0 0 1]; rotation is
    # clockwise as a viewer sees it; ffprobe reports the opposite sign.
    90: [0, 65536, 0, -65536, 0, 0, 0, 0, 1073741824],
    180: [-65536, 0, 0, 0, -65536, 0, 0, 0, 1073741824],
    270: [0, -65536, 0, 65536, 0, 0, 0, 0, 1073741824],
}


def boxes(buf, start, end):
    i = start
    while i + 8 <= end:
        size = struct.unpack(">I", buf[i:i + 4])[0]
        typ = bytes(buf[i + 4:i + 8]).decode("latin1")
        if size == 1:
            size = struct.unpack(">Q", buf[i + 8:i + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - i
            hdr = 8
        else:
            hdr = 8
        yield typ, i, size, hdr
        i += size


def find(buf, path):
    start, end = 0, len(buf)
    for want in path:
        found = None
        for typ, off, size, hdr in boxes(buf, start, end):
            if typ == want:
                found = (off + hdr, off + size)
                break
        if not found:
            raise SystemExit(f"box {want} not found")
        start, end = found
    return start, end


def main():
    rotation, src, dst = int(sys.argv[1]), sys.argv[2], sys.argv[3]
    if rotation not in MATRICES:
        raise SystemExit("rotation must be 90, 180 or 270")
    data = bytearray(open(src, "rb").read())
    c0, c1 = find(data, ["moov", "trak", "tkhd"])
    # tkhd v0 layout: version/flags 4, creation 4, modification 4,
    # trackID 4, reserved 4, duration 4, reserved 8, layer 2, alt 2,
    # volume 2, reserved 2, matrix 36 (offset 40), width 4 (76),
    # height 4 (80). v1 differs (creation/modification/duration are
    # 8 bytes) — refuse rather than patch at the wrong offset.
    if data[c0] != 0 or c1 - c0 < 84:
        raise SystemExit(f"unsupported tkhd (version {data[c0]}, len {c1 - c0})")
    for j, v in enumerate(MATRICES[rotation]):
        struct.pack_into(">i", data, c0 + 40 + j * 4, v)
    if rotation in (90, 270):
        w = struct.unpack(">I", data[c0 + 76:c0 + 80])[0]
        h = struct.unpack(">I", data[c0 + 80:c0 + 84])[0]
        struct.pack_into(">I", data, c0 + 76, h)
        struct.pack_into(">I", data, c0 + 80, w)
    open(dst, "wb").write(bytes(data))
    print(f"wrote {dst} (rotation {rotation} CW)")


if __name__ == "__main__":
    main()
