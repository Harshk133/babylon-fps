"""Builds the game's sound effects (public/sounds/*.ogg + manifest.json) from
CC0 source packs: cuts single shots / barks / flaps out of long recordings,
layers the grenade blast, makes the fire loop seamless, mixes to mono 44.1 kHz,
evens out the loudness and writes small Vorbis files.

    python scripts/build-sounds.py <SRC>

<SRC> holds the downloaded packs, extracted (every pack is CC0, see
public/sounds/CREDITS.md for authors and links):

    kenney_impact-sounds/      https://kenney.nl/assets/impact-sounds
    kenney_rpg-audio/          https://kenney.nl/assets/rpg-audio
    kenney_sci-fi-sounds/      https://kenney.nl/assets/sci-fi-sounds
    kenney_interface-sounds/   https://kenney.nl/assets/interface-sounds
    firearms/                  https://opengameart.org/content/the-free-firearm-sound-library
    zombies/                   https://opengameart.org/content/zombies-sound-pack
    80-CC0-creature-sfx-2/     https://opengameart.org/content/80-cc0-creture-sfx-2
    dog/                       https://opengameart.org/content/dog-sounds
    wings_flap_large/          https://opengameart.org/content/large-wings-flap
    monster_roar.wav           https://opengameart.org/content/cc0-deep-monster-roar
    gunreload1.wav, assaultriflereload1_0.wav, shotguncock_0.wav
                               https://opengameart.org/content/gun-reload-sounds
    glass_breaking.wav         https://opengameart.org/content/glass-break
    fire-1.wav                 https://opengameart.org/content/fire-crackling

Every output is `<group>_<n>.ogg`; manifest.json maps group -> variant count
and Sfx picks a random variant each time.
"""

import glob
import json
import os
import sys
from fractions import Fraction

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly, butter, sosfilt

SR = 44100
SRC = sys.argv[1] if len(sys.argv) > 1 else "sound-src"
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "sounds")


def find(pattern):
    hits = sorted(glob.glob(os.path.join(SRC, "**", pattern), recursive=True))
    hits = [h for h in hits if not os.path.basename(h).startswith("._")]
    if not hits:
        raise FileNotFoundError(pattern)
    return hits[0]


def load(pattern):
    x, sr = sf.read(find(pattern), always_2d=True, dtype="float32")
    x = x.mean(axis=1)
    if sr != SR:
        f = Fraction(SR, sr).limit_denominator(1000)
        x = resample_poly(x, f.numerator, f.denominator).astype("float32")
    return x


def db(v):
    return 20 * np.log10(max(v, 1e-9))


def envelope(x, ms=3):
    n = max(1, int(SR * ms / 1000))
    a = np.abs(x)
    pad = (-len(a)) % n
    return np.pad(a, (0, pad)).reshape(-1, n).max(axis=1), n


def trim(x, rel_db=-45, pre_ms=4, post_ms=30):
    peak = np.abs(x).max()
    idx = np.where(np.abs(x) > peak * 10 ** (rel_db / 20))[0]
    if not len(idx):
        return x
    a = max(0, idx[0] - int(SR * pre_ms / 1000))
    b = min(len(x), idx[-1] + int(SR * post_ms / 1000))
    return x[a:b]


def fade(x, in_ms=3, out_frac=0.25, curve=2.0):
    x = x.copy()
    n_in = min(len(x), int(SR * in_ms / 1000))
    if n_in:
        x[:n_in] *= np.linspace(0, 1, n_in)
    n_out = int(len(x) * out_frac)
    if n_out:
        x[-n_out:] *= np.linspace(1, 0, n_out) ** curve
    return x


def onsets(x, rel=0.45, min_gap_ms=180):
    """Sample indices of sharp attacks (gunshots, footfalls)."""
    env, n = envelope(x, 2)
    peak = env.max()
    out, last = [], -10 ** 9
    gap = int(min_gap_ms / 2)
    for i in range(1, len(env)):
        if env[i] >= peak * rel and env[i - 1] < peak * rel and i - last > gap:
            # Back up to where the attack starts
            j = i
            while j > 0 and env[j - 1] > peak * rel * 0.15 and i - j < 10:
                j -= 1
            out.append(j * n)
            last = i
    return out


def segments(x, thresh_db=-30, gap_ms=120, min_ms=80):
    """Split a recording of separate sounds (barks, flaps) at its silences."""
    env, n = envelope(x, 5)
    on = env > env.max() * 10 ** (thresh_db / 20)
    segs, start, quiet = [], None, 0
    gap = int(gap_ms / 5)
    for i, v in enumerate(on):
        if v:
            if start is None:
                start = i
            quiet = 0
        elif start is not None:
            quiet += 1
            if quiet > gap:
                end = i - quiet + 1
                if (end - start) * 5 >= min_ms:
                    segs.append((start * n, end * n))
                start, quiet = None, 0
    if start is not None and (len(on) - start) * 5 >= min_ms:
        segs.append((start * n, len(on) * n))
    pad = int(SR * 0.02)
    return [x[max(0, a - pad):min(len(x), b + pad * 3)] for a, b in segs]


def loud(x):
    """Ranks clips: RMS of the loudest 300 ms."""
    w = int(SR * 0.3)
    if len(x) <= w:
        return np.sqrt((x ** 2).mean())
    c = np.convolve(x ** 2, np.ones(w) / w, mode="valid")
    return np.sqrt(c.max())


def level(x, target_db):
    """Loudest 300 ms at target_db RMS, peaks kept under -1 dBFS."""
    x = x * 10 ** ((target_db - db(loud(x))) / 20)
    peak = np.abs(x).max()
    if peak > 0.89:
        x *= 0.89 / peak
    return x.astype("float32")


def lowpass(x, hz):
    return sosfilt(butter(2, hz, "low", fs=SR, output="sos"), x).astype("float32")


def highpass(x, hz):
    return sosfilt(butter(2, hz, "high", fs=SR, output="sos"), x).astype("float32")


def pitch(x, factor):
    """Slower and lower (factor < 1) by resampling."""
    f = Fraction(1 / factor).limit_denominator(200)
    return resample_poly(x, f.numerator, f.denominator).astype("float32")


def mix(*parts):
    """parts: (clip, gain, offset seconds)."""
    n = max(len(c) + int(o * SR) for c, g, o in parts)
    out = np.zeros(n, "float32")
    for c, g, o in parts:
        s = int(o * SR)
        out[s:s + len(c)] += c * g
    return out


def seamless(x, xf_ms=400):
    """Loop: crossfade the tail into the head."""
    n = int(SR * xf_ms / 1000)
    head, body, tail = x[:n], x[n:-n], x[-n:]
    t = np.linspace(0, 1, n)
    return np.concatenate([body, tail * (1 - t) + head * t]).astype("float32")


manifest = {}


def write(group, clips, target_db):
    os.makedirs(OUT, exist_ok=True)
    for i, c in enumerate(clips):
        # Below 35 Hz is only DC and mic thump (phones can't play it anyway)
        c = highpass(c, 35)
        sf.write(os.path.join(OUT, f"{group}_{i}.ogg"), level(c, target_db), SR,
                 format="OGG", subtype="VORBIS", compression_level=0.6)
    manifest[group] = len(clips)


def punch(x, drive):
    """Soft saturation: fattens the body of a shot without raising its peak."""
    x = x / (np.abs(x).max() + 1e-9)
    return (np.tanh(drive * x) / np.tanh(drive)).astype("float32")


def shots(pattern, count, length, rel=0.45, gap_ms=250, drive=3.5):
    """Single gunshots from a recording of several, each `length` s with its tail."""
    x = load(pattern)
    out = []
    for o in onsets(x, rel, gap_ms)[:count * 3]:
        c = x[o:o + int(SR * length)]
        if len(c) < SR * length * 0.6:
            continue
        out.append(fade(punch(c, drive), 1, 0.55, 2.5))
    out.sort(key=loud, reverse=True)
    return out[:count]


# ── Guns: one clip per shot (the game fires shot by shot) ────────────────────
write("gun_pistol", shots("X_39P.wav", 3, 0.75) or shots("A_42P.wav", 3, 0.75), -9)
write("gun_smg", shots("G_31P.wav", 3, 0.45), -9)
write("gun_rifle", shots("C_28P.wav", 3, 0.8), -8)
write("gun_shotgun", shots("O_21P.wav", 3, 1.1), -7)
write("gun_sniper", shots("W_29P.wav", 2, 1.6) + shots("M_21P.wav", 1, 1.6), -7)

# ── Gun handling ─────────────────────────────────────────────────────────────
write("reload_pistol", [trim(load("gunreload1.wav"))], -18)
write("reload_rifle", [trim(load("assaultriflereload1_0.wav"))], -18)
write("pump", [trim(load("shotguncock_0.wav"))], -16)
write("dryfire", [fade(trim(load("metalClick.ogg"))[: int(SR * 0.12)], 1, 0.4)], -20)
write("equip", [trim(load("metalLatch.ogg")), trim(load("beltHandle1.ogg"))], -22)
write("pin", [trim(load("metalClick.ogg"))], -24)

# ── Footsteps ────────────────────────────────────────────────────────────────
for surf in ["grass", "wood", "concrete"]:
    write(f"step_{surf}", [trim(load(f"footstep_{surf}_00{i}.ogg")) for i in range(5)], -22)
write("step_dirt", [trim(load(f"footstep0{i}.ogg")) for i in range(0, 10, 2)], -22)

# ── Grenade, molotov, smoke ──────────────────────────────────────────────────
boom = [load("lowFrequency_explosion_000.ogg"), load("lowFrequency_explosion_001.ogg")]
crunch = [load(f"explosionCrunch_00{i}.ogg") for i in range(5)]
write("explosion", [fade(trim(mix((boom[i % 2], 1.0, 0), (crunch[i], 0.8, 0.0), (lowpass(crunch[(i + 2) % 5], 900), 0.5, 0.08))), 2, 0.4)
                    for i in range(3)], -6)
write("bounce", [trim(load(f"impactMetal_light_00{i}.ogg")) for i in range(3)], -24)
write("glass", [trim(load("glass_breaking.wav")), trim(load("impactGlass_heavy_000.ogg"))], -12)
fire = load("fire-1.wav")
write("fire_loop", [seamless(highpass(fire, 120))], -20)
write("ignite", [fade(trim(lowpass(load("thrusterFire_001.ogg"), 2500)), 5, 0.6)], -14)
write("smoke_hiss", [fade(trim(highpass(load("thrusterFire_000.ogg"), 1800)), 20, 0.5)], -18)

# ── Doors, lights, rickshaw ──────────────────────────────────────────────────
write("door_open", [trim(load("doorOpen_1.ogg")), trim(load("doorOpen_2.ogg"))], -16)
write("door_close", [trim(load(f"doorClose_{i}.ogg")) for i in range(1, 5)], -14)
write("door_bang", [trim(load(f"impactWood_heavy_00{i}.ogg")) for i in range(4)], -12)
write("switch", [trim(load("switch_002.ogg")), trim(load("switch_004.ogg"))], -20)
write("can_cap", [trim(load("metalPot1.ogg")), trim(load("handleSmallLeather.ogg"))], -22)

# ── Zombies (walkers, runners, listeners, gunners share the human-ish pack) ──
z = {i: trim(load(f"zombie-{i}.wav")) for i in range(1, 25)}
write("z_groan", [z[i] for i in (16, 17, 18, 21, 20, 1)], -16)
write("z_alert", [z[i] for i in (4, 7, 10, 14, 15)], -13)
write("z_attack", [z[i] for i in (11, 12, 13, 24, 2)], -14)
write("z_pain", [z[i] for i in (3, 5, 6, 22, 23)], -15)
write("z_death", [z[i] for i in (19, 8, 9)] + [trim(load("die_03.ogg"))], -14)

# Brute and the Warlord: big roars and grunts, heavy stomps
write("brute_roar", [trim(load(f"roar_0{i}.ogg")) for i in (4, 5, 6)], -11)
write("brute_grunt", [trim(load(f"grunt_0{i}.ogg")) for i in (7, 8, 9)], -14)
write("stomp", [trim(load("stomp_01.ogg")), trim(lowpass(load("impactSoft_heavy_000.ogg"), 600))], -16)
roar = trim(load("monster_roar.wav"))
write("boss_roar", [fade(roar[: int(SR * 3.5)], 5, 0.35)], -9)

# Hellhound: real dog growls / barks / whimpers, pitched down a little at runtime
growl_src = segments(load("Dog 2.wav"), -28, 150, 300)
growl_src.sort(key=loud, reverse=True)
write("hound_growl", [fade(g[: int(SR * 1.6)], 10, 0.3) for g in growl_src[:3]], -14)
barks = segments(load("Dog Bark.wav"), -24, 80, 90) + [trim(load(f"Dog Bark {i}.wav")) for i in (1, 2)]
barks.sort(key=loud, reverse=True)
write("hound_bark", [lowpass(b, 3800) for b in barks[:5]], -11)
whine = segments(load("Sad Dog.wav"), -26, 120, 200)
whine.sort(key=loud, reverse=True)
write("hound_yelp", [fade(w[: int(SR * 0.9)], 5, 0.4) for w in whine[:2]], -14)
write("hound_snarl", [trim(load("monster_09.ogg")), trim(load("monster_12.ogg"))], -13)
write("paw", [trim(highpass(load(f"footstep_snow_00{i}.ogg"), 300)) for i in range(4)], -26)

# Gold Dragon: the deep roar, single wing beats, fire breath, the crash
write("dragon_roar", [fade(roar, 5, 0.25), fade(pitch(trim(load("roar_04.ogg")), 0.62), 5, 0.3)], -8)
flaps = segments(load("wings_flap_large.ogg"), -26, 90, 120)
flaps.sort(key=loud, reverse=True)
write("wing", flaps[:3], -14)
write("dragon_fire", [fade(trim(lowpass(load("thrusterFire_002.ogg"), 3000)), 5, 0.5), fade(trim(lowpass(load("thrusterFire_003.ogg"), 3000)), 5, 0.5)], -10)
write("crash", [trim(mix((load("lowFrequency_explosion_001.ogg"), 0.9, 0), (load("impactSoft_heavy_001.ogg"), 1.0, 0)))], -8)

with open(os.path.join(OUT, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=1)
total = sum(os.path.getsize(p) for p in glob.glob(os.path.join(OUT, "*.ogg")))
print(f"{sum(manifest.values())} clips in {len(manifest)} groups, {total / 1024:.0f} KB")
