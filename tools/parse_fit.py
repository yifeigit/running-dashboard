# -*- coding: utf-8 -*-
"""Parse all .fit files in a directory with fitdecode (tolerant of developer fields)."""
import sys, os, json, warnings
from datetime import datetime, timezone

import fitdecode

# COROS FIT files contain developer fields whose definition sizes trigger
# harmless "invalid field size" warnings in fitdecode; silence them.
warnings.filterwarnings("ignore")


def utc_str(dt):
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def norm_value(v):
    if isinstance(v, datetime):
        return utc_str(v)
    if isinstance(v, (int, float, bool, str)) or v is None:
        return v
    return str(v)


def parse_fit(path):
    result = {
        "file": os.path.basename(path),
        "session": {},
        "records": 0,
        "first_record_time": None,
        "last_record_time": None,
        "heart_rate_values": [],
        "sport": None,
    }
    session_fields = [
        "start_time", "timestamp", "sport", "sub_sport",
        "total_elapsed_time", "total_timer_time", "total_distance",
        "avg_speed", "max_speed", "avg_heart_rate", "max_heart_rate",
        "total_calories", "avg_cadence", "max_cadence", "total_ascent",
        "total_descent", "avg_power", "max_power",
    ]
    with fitdecode.FitReader(path) as fit:
        for frame in fit:
            if frame.frame_type != fitdecode.FIT_FRAME_DATA:
                continue
            name = frame.name
            values = {fd.name: norm_value(fd.value) for fd in frame.fields}
            if name == "session":
                for f in session_fields:
                    if f in values:
                        result["session"][f] = values[f]
                if "sport" in values:
                    result["sport"] = str(values["sport"])
            elif name == "record":
                result["records"] += 1
                ts = values.get("timestamp")
                if isinstance(ts, str):
                    if result["first_record_time"] is None:
                        result["first_record_time"] = ts
                    result["last_record_time"] = ts
                hr = values.get("heart_rate")
                if isinstance(hr, (int, float)):
                    result["heart_rate_values"].append(hr)
    if result["heart_rate_values"]:
        hrs = result["heart_rate_values"]
        result["heart_rate_stats"] = {
            "count": len(hrs),
            "min": min(hrs),
            "max": max(hrs),
            "avg": round(sum(hrs) / len(hrs), 1),
        }
    del result["heart_rate_values"]
    return result


def main():
    fit_dir = sys.argv[1]
    out_file = sys.argv[2]
    files = sorted(f for f in os.listdir(fit_dir) if f.lower().endswith(".fit"))
    parsed = []
    errors = []
    for f in files:
        try:
            parsed.append(parse_fit(os.path.join(fit_dir, f)))
        except Exception as e:  # noqa: BLE001
            errors.append({"file": f, "error": str(e)})
    out = {"count": len(parsed), "activities": parsed, "errors": errors}
    with open(out_file, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    print(f"parsed {len(parsed)} fit files, {len(errors)} errors -> {out_file}")


if __name__ == "__main__":
    main()
