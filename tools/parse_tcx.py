# -*- coding: utf-8 -*-
"""Parse all .tcx files (Xiaomi Mi Fitness export) into per-activity metadata JSON."""
import sys, os, json
import xml.etree.ElementTree as ET
from datetime import datetime

NS = "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"


def q(tag):
    return f"{{{NS}}}{tag}"


def parse_time(s):
    if not s:
        return None
    s = s.strip()
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).isoformat()
    except ValueError:
        return s


def parse_tcx(path):
    tree = ET.parse(path)
    root = tree.getroot()
    result = {
        "file": os.path.basename(path),
        "creator": root.attrib.get("creator", ""),
        "activities": [],
    }
    activities = root.find(f".//{q('Activities')}")
    if activities is None:
        return result
    for act in activities.findall(q("Activity")):
        sport = act.attrib.get("Sport", "")
        act_id = parse_time(act.findtext(q("Id")))
        laps = act.findall(q("Lap"))
        total_time = 0.0
        total_dist = 0.0
        total_cal = 0
        heart_rates = []
        steps = 0
        trackpoints = 0
        first_tp = None
        last_tp = None
        for lap in laps:
            tts = lap.findtext(q("TotalTimeSeconds"))
            dm = lap.findtext(q("DistanceMeters"))
            cal = lap.findtext(q("Calories"))
            hr = lap.findtext(q("HeartRateBpm"))
            st = lap.findtext(q("Steps"))
            if tts:
                total_time += float(tts)
            if dm:
                total_dist += float(dm)
            if cal:
                total_cal += int(float(cal))
            if hr:
                heart_rates.append(int(float(hr)))
            if st:
                steps += int(float(st))
            track = lap.find(q("Track"))
            if track is not None:
                for tp in track.findall(q("Trackpoint")):
                    trackpoints += 1
                    t = parse_time(tp.findtext(q("Time")))
                    if t:
                        if first_tp is None:
                            first_tp = t
                        last_tp = t
        result["activities"].append({
            "sport": sport,
            "id": act_id,
            "startTime": act_id or first_tp,
            "endTime": last_tp,
            "durationSeconds": round(total_time, 1),
            "distanceMeters": round(total_dist, 1),
            "calories": total_cal,
            "avgHeartRate": (round(sum(heart_rates) / len(heart_rates), 1)
                             if heart_rates else None),
            "steps": steps,
            "trackpoints": trackpoints,
            "laps": len(laps),
        })
    return result


def main():
    tcx_dir = sys.argv[1]
    out_file = sys.argv[2]
    files = sorted(f for f in os.listdir(tcx_dir) if f.lower().endswith(".tcx"))
    parsed = []
    errors = []
    for f in files:
        try:
            parsed.append(parse_tcx(os.path.join(tcx_dir, f)))
        except Exception as e:  # noqa: BLE001
            errors.append({"file": f, "error": str(e)})
    out = {"count": len(parsed), "activities": parsed, "errors": errors}
    with open(out_file, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    print(f"parsed {len(parsed)} tcx files, {len(errors)} errors -> {out_file}")


if __name__ == "__main__":
    main()
