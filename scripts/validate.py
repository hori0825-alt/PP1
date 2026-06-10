"""pyembroidery で PES/DST を読み戻し、整合性を確認するスモーク検証"""
import sys

from pyembroidery import read

for path in ("/tmp/smoke.pes", "/tmp/smoke.dst"):
    p = read(path)
    if p is None:
        print(f"NG: {path} を読み込めない")
        sys.exit(1)
    stitches = sum(1 for s in p.stitches if s[2] == 0)
    bounds = p.bounds()
    w = (bounds[2] - bounds[0]) / 10.0
    h = (bounds[3] - bounds[1]) / 10.0
    colors = len(p.threadlist)
    print(f"OK: {path} stitches={stitches} colors={colors} size={w:.1f}x{h:.1f}mm")
    assert stitches > 1000, "ステッチ数が少なすぎる"
    assert w <= 100 and h <= 100, "PP1 の枠を超えている"

print("validation passed")
