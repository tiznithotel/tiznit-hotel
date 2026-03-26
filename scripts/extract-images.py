"""
scripts/extract-images.py
─────────────────────────
Extracts every base64-embedded image from public/index.html,
converts each unique image to an optimised WebP file (target ≤100 KB),
saves them to public/images/, and rewrites index.html with proper
file-path references.

Works for all three embedding contexts found in this file:
  • <img src="data:image/jpeg;base64,…">
  • style="background-image:url('data:image/jpeg;base64,…')"
  • JavaScript array entries  'data:image/jpeg;base64,…'

Run:
  python scripts/extract-images.py
"""

import base64
import hashlib
import io
import os
import re
import sys

from PIL import Image

# ── Paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
ROOT        = os.path.dirname(SCRIPT_DIR)
HTML_SRC    = os.path.join(ROOT, "public", "index.html")
HTML_DST    = os.path.join(ROOT, "public", "index.html")   # overwrite in place
IMG_DIR     = os.path.join(ROOT, "public", "images")
IMG_WEB_DIR = "/images"   # web-root-relative path used inside HTML

# ── Quality settings ────────────────────────────────────────────────────────
WEBP_QUALITY_START = 78   # start here, step down if still >100 KB
WEBP_QUALITY_MIN   = 45   # never go below this
WEBP_QUALITY_STEP  = 5
TARGET_KB          = 100

# ── Regex: captures the full  data:mime;base64,<payload>  token ─────────────
B64_RE = re.compile(
    r'data:(image/[a-zA-Z+]+);base64,([A-Za-z0-9+/=]+)',
    re.DOTALL
)

# ─────────────────────────────────────────────────────────────────────────────

def encode_webp(raw_bytes: bytes, mime: str, quality: int) -> bytes:
    """Decode raw image bytes and re-encode as WebP at *quality*."""
    img = Image.open(io.BytesIO(raw_bytes))
    # Preserve transparency for PNG/WebP; JPEG has no alpha
    if img.mode in ("RGBA", "LA"):
        pass                         # keep alpha
    elif img.mode != "RGB":
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality, method=6)
    return buf.getvalue()


def optimise(raw_bytes: bytes, mime: str) -> tuple[bytes, int]:
    """Return (webp_bytes, quality_used) sized ≤ TARGET_KB if possible."""
    q = WEBP_QUALITY_START
    while q >= WEBP_QUALITY_MIN:
        webp = encode_webp(raw_bytes, mime, q)
        if len(webp) <= TARGET_KB * 1024:
            return webp, q
        q -= WEBP_QUALITY_STEP
    # Return best attempt at minimum quality rather than failing
    return encode_webp(raw_bytes, mime, WEBP_QUALITY_MIN), WEBP_QUALITY_MIN


def sha8(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:8].upper()


# ─────────────────────────────────────────────────────────────────────────────

def main():
    print(f"[extract-images] Reading {HTML_SRC}")
    with open(HTML_SRC, "r", encoding="utf-8") as fh:
        html = fh.read()

    os.makedirs(IMG_DIR, exist_ok=True)

    # ── Pass 1: collect unique images in document order ───────────────────
    seen_hash  = {}     # sha256_full → filename (no extension)
    ordered    = []     # list of (sha8, mime, raw_bytes) in first-occurrence order

    for m in B64_RE.finditer(html):
        mime   = m.group(1)
        b64str = m.group(2)
        try:
            raw = base64.b64decode(b64str)
        except Exception as e:
            print(f"  [WARN] base64 decode failed: {e}")
            continue

        full_hash = hashlib.sha256(raw).hexdigest()
        if full_hash not in seen_hash:
            seen_hash[full_hash] = None          # placeholder
            ordered.append((full_hash, mime, raw, b64str))

    print(f"[extract-images] {len(B64_RE.findall(html))} total occurrences -> "
          f"{len(ordered)} unique images")

    # ── Pass 2: convert & save, build replacement table ───────────────────
    # replacement_map: original_data_uri_prefix → web path
    replacement_map = {}   # "data:mime;base64,BASE64" → "/images/imageNN.webp"

    report_rows = []

    for idx, (full_hash, mime, raw, b64str) in enumerate(ordered, start=1):
        filename  = f"image{idx:02d}.webp"
        filepath  = os.path.join(IMG_DIR, filename)
        web_path  = f"{IMG_WEB_DIR}/{filename}"

        raw_kb = len(raw) / 1024

        # Convert to WebP
        try:
            webp_bytes, q_used = optimise(raw, mime)
        except Exception as e:
            print(f"  [ERROR] image{idx:02d}: conversion failed — {e}")
            # fall back: save as JPEG
            filename  = f"image{idx:02d}.jpg"
            filepath  = os.path.join(IMG_DIR, filename)
            web_path  = f"{IMG_WEB_DIR}/{filename}"
            webp_bytes = raw
            q_used    = -1

        webp_kb = len(webp_bytes) / 1024

        # Write file
        with open(filepath, "wb") as fh:
            fh.write(webp_bytes)

        # Store replacement key: the full data URI token
        data_uri_token = f"data:{mime};base64,{b64str}"
        replacement_map[data_uri_token] = web_path

        seen_hash[full_hash] = web_path

        report_rows.append({
            "idx":       idx,
            "filename":  filename,
            "web_path":  web_path,
            "raw_kb":    raw_kb,
            "webp_kb":   webp_kb,
            "quality":   q_used,
            "saved_pct": (1 - webp_kb / raw_kb) * 100 if raw_kb else 0,
        })

        flag = "! >100KB" if webp_kb > TARGET_KB else "OK"
        print(f"  [{idx:02d}] {filename:18s}  "
              f"{raw_kb:7.1f} KB -> {webp_kb:6.1f} KB  q={q_used:3}  {flag}")

    # ── Pass 3: replace all occurrences in HTML ────────────────────────────
    # We replace the full  data:mime;base64,PAYLOAD  token with the web path.
    # This works for all three contexts (src=, background-image:url(), JS string).
    new_html = html
    for data_uri_token, web_path in replacement_map.items():
        new_html = new_html.replace(data_uri_token, web_path)

    # Verify no base64 image remains
    remaining = len(B64_RE.findall(new_html))
    if remaining > 0:
        print(f"\n[WARN] {remaining} base64 image(s) still in HTML after replacement!")
    else:
        print(f"\n[extract-images] All base64 images replaced successfully.")

    # ── Write updated HTML ─────────────────────────────────────────────────
    with open(HTML_DST, "w", encoding="utf-8") as fh:
        fh.write(new_html)

    old_kb  = len(html.encode("utf-8")) / 1024
    new_kb  = len(new_html.encode("utf-8")) / 1024
    print(f"[extract-images] index.html: {old_kb:,.0f} KB -> {new_kb:,.0f} KB  "
          f"(saved {old_kb - new_kb:,.0f} KB)")

    # ── Print summary table ────────────────────────────────────────────────
    print()
    print("=" * 72)
    print(f"{'#':>3}  {'Filename':<20} {'Original':>9}  {'WebP':>7}  {'Saved':>6}  {'Q':>3}")
    print("-" * 72)
    total_raw  = 0
    total_webp = 0
    for r in report_rows:
        total_raw  += r["raw_kb"]
        total_webp += r["webp_kb"]
        print(f"{r['idx']:>3}  {r['filename']:<20} "
              f"{r['raw_kb']:>8.1f}K  {r['webp_kb']:>6.1f}K  "
              f"{r['saved_pct']:>5.1f}%  {r['quality']:>3}")
    print("-" * 72)
    overall_saving = (1 - total_webp / total_raw) * 100 if total_raw else 0
    print(f"{'TOTAL':<25} {total_raw:>8.1f}K  {total_webp:>6.1f}K  "
          f"{overall_saving:>5.1f}%")
    print("=" * 72)
    print()
    print(f"Images saved to: {IMG_DIR}")
    print(f"HTML updated:    {HTML_DST}")


if __name__ == "__main__":
    main()
