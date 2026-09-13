import glob
import json
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "assets", "raw")
OUT = os.path.join(ROOT, "assets", "pet")
ASSETS = os.path.join(ROOT, "assets")

SOFT = 16
HARD = 55
PAD = 10
MAX_H = 640

os.makedirs(OUT, exist_ok=True)


def key_green(img: Image.Image) -> Image.Image:
    a = np.asarray(img.convert("RGB")).astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    greenness = g - np.maximum(r, b)
    t = np.clip((greenness - SOFT) / (HARD - SOFT), 0, 1)
    alpha = ((1 - t) * 255).astype(np.uint8)
    spill = greenness > 4
    g2 = g.copy()
    g2[spill] = np.maximum(r, b)[spill]
    rgb = np.stack([r, g2, b], axis=-1).astype(np.uint8)
    rgba = np.dstack([rgb, alpha])
    return Image.fromarray(rgba, "RGBA")


def crop_content(img: Image.Image, pad: int = PAD) -> Image.Image:
    alpha = np.asarray(img)[:, :, 3]
    ys, xs = np.where(alpha > 8)
    if len(ys) == 0:
        return img
    y0, y1 = max(ys.min() - pad, 0), min(ys.max() + pad, alpha.shape[0] - 1)
    x0, x1 = max(xs.min() - pad, 0), min(xs.max() + pad, alpha.shape[1] - 1)
    return img.crop((x0, y0, x1 + 1, y1 + 1))


manifest = {}
for path in sorted(glob.glob(os.path.join(RAW, "*.jpg"))):
    name = os.path.splitext(os.path.basename(path))[0]
    img = Image.open(path)
    img = key_green(img)
    img = crop_content(img)
    raw_w, raw_h = img.size
    if img.height > MAX_H:
        w = round(img.width * MAX_H / img.height)
        img = img.resize((w, MAX_H), Image.LANCZOS)
    out_path = os.path.join(OUT, name + ".png")
    img.save(out_path)
    manifest[name] = {"w": img.width, "h": img.height, "rawW": raw_w, "rawH": raw_h}
    print(f"{name}: {img.width}x{img.height} (raw {raw_w}x{raw_h})")

with open(os.path.join(ASSETS, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)

# tray icon & app icon: face crop from canonical
canon = Image.open(os.path.join(OUT, "idle-a1.png"))
w, h = canon.size
face = canon.crop((0, 0, w, int(h * 0.42)))
fw, fh = face.size
side = min(fw, fh)
left = (fw - side) // 2
face_sq = face.crop((left, 0, left + side, side)).resize((256, 256), Image.LANCZOS)
face_sq.save(os.path.join(ASSETS, "icon.png"))
face_sq.resize((32, 32), Image.LANCZOS).save(os.path.join(ASSETS, "tray.png"))
face_sq.save(
    os.path.join(ASSETS, "icon.ico"),
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("icons done")
