# -*- coding: utf-8 -*-
"""Extract simplified GPS tracks from all .tcx and .fit files.

Output JSON: { "tracks": { "<file>": {"source": ..., "points": [[lat, lon, hr, sec], ...]} } }
  - lat/lon in degrees (6 decimals)
  - hr = heart rate (bpm, int) or None
  - sec = elapsed seconds from the first track point (int)
Points are simplified with Douglas-Peucker (tolerance ~4m) and capped per track.
"""
import sys, os, json, warnings
from datetime import datetime
import xml.etree.ElementTree as ET

import fitdecode

warnings.filterwarnings("ignore")

S = 2 ** 31  # semicircles -> degrees


def semicircle_to_deg(v):
    return v * 180.0 / S


def douglas_peucker(points, tol):
    """Simplify a list of [lat, lon, ...] using perpendicular distance on lat/lon."""
    if len(points) <= 2:
        return points
    # find max distance
    start, end = points[0], points[-1]
    dx, dy = end[0] - start[0], end[1] - start[1]
    denom = (dx * dx + dy * dy) ** 0.5
    max_d = 0.0
    max_i = 0
    for i in range(1, len(points) - 1):
        p = points[i]
        if denom == 0:
            d = ((p[0] - start[0]) ** 2 + (p[1] - start[1]) ** 2) ** 0.5
        else:
            d = abs(dy * p[0] - dx * p[1] + end[0] * start[1] - end[1] * start[0]) / denom
        if d > max_d:
            max_d = d
            max_i = i
    if max_d > tol:
        left = douglas_peucker(points[: max_i + 1], tol)
        right = douglas_peucker(points[max_i:], tol)
        return left[:-1] + right
    return [points[0], points[-1]]


def simplify(points, tol=0.000012, cap=2500):
    if not points:
        return points
    pts = [p for p in points if p[0] is not None and p[1] is not None]
    if not pts:
        return []
    result = douglas_peucker(pts, tol)
    # iterative coarsening if still over cap
    while len(result) > cap and tol < 0.01:
        tol *= 2
        result = douglas_peucker(pts, tol)
    return result


def round_pt(p):
    lat = round(p[0], 6)
    lon = round(p[1], 6)
    hr = int(round(p[2])) if p[2] is not None else None
    sec = int(round(p[3])) if p[3] is not None else 0
    return [lat, lon, hr, sec]


def extract_tcx(path):
    tree = ET.parse(path)
    root = tree.getroot()
    ns = "{http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2}"
    points = []
    first_t = None
    for tp in root.iter(f"{ns}Trackpoint"):
        t_el = tp.find(f"{ns}Time")
        pos = tp.find(f"{ns}Position")
        if pos is None:
            continue
        lat_el = pos.find(f"{ns}LatitudeDegrees")
        lon_el = pos.find(f"{ns}LongitudeDegrees")
        if lat_el is None or lon_el is None:
            continue
        lat = float(lat_el.text)
        lon = float(lon_el.text)
        hr_el = tp.find(f"{ns}HeartRateBpm")
        hr = None
        if hr_el is not None:
            v = hr_el.find(f"{ns}Value")
            if v is not None:
                hr = float(v.text)
        sec = 0
        if t_el is not None:
            t = datetime.fromisoformat(t_el.text.replace("Z", "+00:00"))
            if first_t is None:
                first_t = t
            sec = (t - first_t).total_seconds()
        points.append([lat, lon, hr, sec])
    return simplify(points)


def extract_fit(path):
    points = []
    first_t = None
    with fitdecode.FitReader(path) as fit:
        for frame in fit:
            if frame.frame_type != fitdecode.FIT_FRAME_DATA or frame.name != "record":
                continue
            vals = {fd.name: fd.value for fd in frame.fields}
            lat = vals.get("position_lat")
            lon = vals.get("position_long")
            if lat is None or lon is None:
                continue
            lat = semicircle_to_deg(lat)
            lon = semicircle_to_deg(lon)
            hr = vals.get("heart_rate")
            sec = 0
            ts = vals.get("timestamp")
            if isinstance(ts, datetime):
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=datetime.timezone.utc)
                if first_t is None:
                    first_t = ts
                sec = (ts - first_t).total_seconds()
            points.append([lat, lon, hr, sec])
    return simplify(points)


def main():
    tcx_dir = sys.argv[1]
    fit_dir = sys.argv[2]
    out_file = sys.argv[3]

    tracks = {}
    for f in sorted(os.listdir(tcx_dir)):
        if not f.lower().endswith(".tcx"):
            continue
        try:
            pts = extract_tcx(os.path.join(tcx_dir, f))
            tracks[f] = {"source": "xiaomi", "points": [round_pt(p) for p in pts]}
            print(f"tcx {f}: {len(pts)} pts")
        except Exception as e:  # noqa: BLE001
            print(f"tcx {f}: ERROR {e}")
    for f in sorted(os.listdir(fit_dir)):
        if not f.lower().endswith(".fit"):
            continue
        try:
            pts = extract_fit(os.path.join(fit_dir, f))
            tracks[f] = {"source": "coros", "points": [round_pt(p) for p in pts]}
            print(f"fit {f}: {len(pts)} pts")
        except Exception as e:  # noqa: BLE001
            print(f"fit {f}: ERROR {e}")

    total_pts = sum(len(t["points"]) for t in tracks.values())
    with open(out_file, "w", encoding="utf-8") as fh:
        json.dump({"tracks": tracks}, fh, ensure_ascii=False)
    print(f"TOTAL: {len(tracks)} tracks, {total_pts} points -> {out_file}")


if __name__ == "__main__":
    main()
