# Builds the opening cinematic's Krishna artwork with Blender's Python (numpy):
#   blender -b --factory-startup --python scripts/build-krishna-intro.py
# From public/cinematic/src/krishna.jpg (the supplied devotional artwork, the
# Brahmanda Darshan: the universe in His mouth) it writes, next to it in
# public/cinematic/:
#   krishna_open.webp    the artwork as it is
#   krishna_closed.webp  the same, mouth closed in a gentle smile (lips painted
#                        over a skin fill diffused in from round the mouth)
#   krishna_mask.png     R: the mouth's inside (where the live universe goes),
#                        G: the open lips (the region the opening reveals)
# Nothing else in the picture is touched: the face, eyes and proportions stay.
import bpy, os, numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(bpy.data.filepath or __file__), ".."))
if not os.path.isdir(os.path.join(ROOT, "public")):
    ROOT = os.getcwd()
SRC = os.path.join(ROOT, "public", "cinematic", "src", "krishna.jpg")
OUT = os.path.join(ROOT, "public", "cinematic")

def load(path):
    im = bpy.data.images.load(path)
    w, h = im.size
    a = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1].copy()
    bpy.data.images.remove(im)
    return a

def save(a, path, fmt):
    h, w = a.shape[:2]
    im = bpy.data.images.new("o", w, h, alpha=True)
    im.pixels.foreach_set(np.ascontiguousarray(a[::-1], dtype=np.float32).ravel())
    sc = bpy.context.scene
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.render.image_settings.file_format = fmt
    sc.render.image_settings.color_mode = "RGB" if fmt == "WEBP" else "RGBA"
    sc.render.image_settings.quality = 90
    im.save_render(path, scene=sc)
    bpy.data.images.remove(im)

def blur(m, r):
    # separable box blur ×3 ≈ gaussian
    for _ in range(3):
        for ax in (0, 1):
            k = 2 * r + 1
            p = np.pad(m, [(r, r) if i == ax else (0, 0) for i in range(m.ndim)], mode="edge")
            c = np.cumsum(p, axis=ax, dtype=np.float64)
            c = np.concatenate([np.zeros_like(np.take(c, [0], axis=ax)), c], axis=ax)
            n = m.shape[ax]
            m = ((np.take(c, np.arange(k, k + n), axis=ax) - np.take(c, np.arange(0, n), axis=ax)) / k).astype(np.float32)
    return m

a = load(SRC)
H, W = a.shape[:2]
rgb = a[..., :3]
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)

# The open mouth (source pixels): lips' outer edge and the inside
MX, MY = 392.0, 514.0
lipsE = ((xx - MX) / 74.0) ** 2 + ((yy - MY) / 70.0) ** 2         # <1: lips and inside
r_, g_, b_ = rgb[..., 0], rgb[..., 1], rgb[..., 2]
inside = ((g_ > b_ + 0.06) & (r_ > b_ + 0.1) & (lipsE < 0.92)).astype(np.float32)   # golden, not blue skin, not red lips
inside = blur(inside, 2)
inside = np.clip((inside - 0.25) * 2.2, 0, 1)
lipsMask = np.clip((1.08 - lipsE) / 0.16, 0, 1)

# Skin fill: diffuse the colour from round the mouth inward (harmonic inpainting)
hole = lipsE < 1.3
y0, y1, x0, x1 = int(MY - 90), int(MY + 90), int(MX - 100), int(MX + 100)
sub = rgb[y0:y1, x0:x1].copy()
hs = hole[y0:y1, x0:x1]
sub[hs] = sub[~hs].mean(axis=0)
for it in range(2600):
    avg = 0.25 * (np.roll(sub, 1, 0) + np.roll(sub, -1, 0) + np.roll(sub, 1, 1) + np.roll(sub, -1, 1))
    sub[hs] = avg[hs]
# a little of the photo's grain so the fill isn't plastic
rng = np.random.default_rng(7)
grain = blur(rng.standard_normal(sub.shape[:2]).astype(np.float32), 1) * 0.012
sub[hs] += grain[hs][:, None]
closed = rgb.copy()
fill = closed[y0:y1, x0:x1]
fe = np.clip((1.3 - lipsE[y0:y1, x0:x1]) / 0.12, 0, 1)[..., None]
closed[y0:y1, x0:x1] = fill * (1 - fe) + sub * fe

# The jaw closes: the chin comes up (the shader eases it back down as the mouth opens,
# with the same field: JAW below). closed(x, y) = filled(x, y + d(x, y))
JAW = dict(D=24.0, x0=238.0, x1=548.0, ya=468.0, yb=556.0, yc=612.0, yd=700.0)
def jaw(x, y):
    J = JAW
    sx = np.clip((x - J["x0"]) / (J["x1"] - J["x0"]), 0, 1)
    bx = np.abs(np.sin(np.pi * sx)) ** 1.5
    up = np.clip((y - J["ya"]) / (J["yb"] - J["ya"]), 0, 1)
    dn = np.clip((J["yd"] - y) / (J["yd"] - J["yc"]), 0, 1)
    sm = lambda t: t * t * (3 - 2 * t)
    return J["D"] * bx * sm(up) * sm(dn)
d = jaw(xx, yy)
sy = np.clip(yy + d, 0, H - 1)
i0 = np.floor(sy).astype(int); i1 = np.minimum(i0 + 1, H - 1); f = (sy - i0)[..., None]
xi = xx.astype(int)
closed = closed[i0, xi] * (1 - f) + closed[i1, xi] * f
print("JAW", JAW)

# Lip colour from the picture's own lips (red, not the inside, not skin)
lipPx = rgb[(lipsE < 1.0) & (inside < 0.1) & (r_ > g_ + 0.25) & (r_ > b_ + 0.2)]
lip = lipPx.mean(axis=0) if len(lipPx) else np.array([0.8, 0.32, 0.3], np.float32)
print("LIP", lip, len(lipPx))

# Closed lips in a gentle smile: the seam rises toward the corners
CX, CY, HW = MX, 493.0, 52.0
u = (xx - CX) / HW
seam = CY - 6.5 * u ** 2 + 1.2 * np.exp(-(u / 0.18) ** 2)          # corners up, a soft dip mid
upper = 13.0 * np.clip(1 - u ** 2, 0, 1) ** 0.55 - 2.6 * np.exp(-(u / 0.13) ** 2) + 1.6 * np.exp(-((np.abs(u) - 0.3) / 0.14) ** 2)
lower = 17.5 * np.clip(1 - u ** 2, 0, 1) ** 0.7
d_up = (seam - yy) / np.maximum(upper, 0.01)                         # 0 at the seam, 1 at the top edge
d_lo = (yy - seam) / np.maximum(lower, 0.01)
inU = np.clip((1 - d_up) * 3, 0, 1) * (d_up >= -0.05)
inL = np.clip((1 - d_lo) * 3, 0, 1) * (d_lo >= -0.05)
inX = np.clip((1 - np.abs(u)) * 5, 0, 1)
aU = blur((inU * inX).astype(np.float32), 2)
aL = blur((inL * inX).astype(np.float32), 2)
lipU = lip * np.array([0.86, 0.7, 0.72], np.float32)
lipL = lip * np.array([1.1, 0.92, 0.95], np.float32)
# shading: lower lip lit from above with a soft highlight, upper lip a touch darker
hl = np.exp(-((d_lo - 0.4) / 0.22) ** 2) * np.exp(-(u / 0.45) ** 2) * 0.22
col = closed.copy()
col = col * (1 - aU[..., None]) + (lipU[None, None, :] * (0.92 + 0.12 * np.clip(d_up, 0, 1))[..., None]) * aU[..., None]
col = col * (1 - aL[..., None]) + (lipL[None, None, :] * (1.0 - 0.18 * np.clip(d_lo, 0, 1))[..., None] + hl[..., None]) * aL[..., None]
# the seam line, darker at the corners (the smile's dimples)
seamLine = np.exp(-((yy - seam) / 1.3) ** 2) * inX * (np.abs(u) < 1.12)
dimple = np.exp(-(((np.abs(xx - CX) - HW * 1.02) / 2.6) ** 2 + ((yy - (seam - 3.0)) / 6.5) ** 2))
shade = blur((seamLine * 0.5 + dimple * 0.16).astype(np.float32), 2)
col *= (1 - shade[..., None])
# a soft shadow under the lower lip, and the smile lifting the cheeks a little
under = np.exp(-(((yy - (seam + lower + 5)) / 4.5) ** 2)) * np.clip(1 - u ** 2, 0, 1)
col *= (1 - 0.16 * blur(under.astype(np.float32), 3)[..., None])
# the smile lifts the cheeks: a soft highlight above each corner
for sgn in (-1, 1):
    ch = np.exp(-(((xx - (CX + sgn * HW * 1.25)) / 16.0) ** 2 + ((yy - (seam - 14)) / 11.0) ** 2))
    col = col * (1 + 0.05 * ch[..., None])
closed = np.clip(col, 0, 1)

out_open = np.dstack([rgb, np.ones((H, W), np.float32)])
out_closed = np.dstack([closed, np.ones((H, W), np.float32)])
mask = np.dstack([inside, lipsMask, np.zeros((H, W), np.float32), np.ones((H, W), np.float32)])
save(out_open, os.path.join(OUT, "krishna_open.webp"), "WEBP")
save(out_closed, os.path.join(OUT, "krishna_closed.webp"), "WEBP")
save(mask, os.path.join(OUT, "krishna_mask.png"), "PNG")
# A close look at the mouth, for checking
crop = np.concatenate([out_open[420:610, 290:500], out_closed[420:610, 290:500]], axis=1)
crop = np.repeat(np.repeat(crop, 3, 0), 3, 1)
save(crop, os.path.join(OUT, "src", "mouth_check.png"), "PNG")
print("DONE", W, H)
