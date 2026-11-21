"""Build the reverse VIN index (year/make/model -> VIN patterns) from NHTSA vPIC.

Input: vpic.lite.db (the SQLite build of vPIC shipped in the @cardog/corgi npm package).
Output: data/makes.json and data/index/<make>.json, read by src/resolver.js.

Usage: python3 -I tools/build_index.py /path/to/vpic.lite.db data
"""
import json
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict

MIN_YEAR = 1981
MAX_YEAR = 2027
VEHICLE_TYPES = (1, 2, 3, 7)  # motorcycle, passenger car, truck, MPV
# model, series, trim, drive type, displacement, body class, doors, fuel, cylinders, electrification
ELEMENTS = {28: "M", 34: "S", 38: "T", 15: "D", 13: "L", 5: "B", 14: "N", 24: "F", 9: "C", 126: "E"}
DRIVE_LABELS = {1: "FWD", 2: "4WD", 3: "AWD", 4: "RWD", 7: "2WD", 24: "2WD/4WD"}
FUEL_LABELS = {1: "Diesel", 2: "Electric", 6: "CNG", 8: "Hydrogen"}  # gasoline/flex: the default, not stored
ELECTRIFICATION_LABELS = {1: "Hybrid", 2: "Hybrid", 9: "Hybrid", 3: "Plug-in Hybrid", 4: "Electric", 5: "Fuel Cell"}


def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def tokens(key):
    """Split a vPIC key into per-position tokens: 'B[EF]*L' -> ['B', '[EF]', '*', 'L']."""
    return re.findall(r"\[[^\]]*\]|.", key)


def main(db_path, out_dir):
    db = sqlite3.connect(db_path)
    q = db.execute

    links = q(f"""
        select w.Id, w.Wmi, ws.VinSchemaId, ws.YearFrom, coalesce(ws.YearTo, {MAX_YEAR})
        from Wmi_VinSchema ws join Wmi w on w.Id = ws.WmiId
        where w.VehicleTypeId in ({",".join(map(str, VEHICLE_TYPES))})
          and coalesce(ws.YearTo, {MAX_YEAR}) >= {MIN_YEAR}
    """).fetchall()
    schema_links = defaultdict(list)
    for _wid, wmi, sid, y0, y1 in links:
        schema_links[sid].append((wmi, max(y0, MIN_YEAR), min(y1, MAX_YEAR)))
    wmi_links = defaultdict(set)
    for sid, ls in schema_links.items():
        for (w, y0, y1) in ls:
            wmi_links[w].add((sid, y0, y1))

    model_make = {}
    for model_id, model_name, make_name in q("""
        select mo.Id, mo.Name, m.Name from Model mo
        join Make_Model mm on mm.ModelId = mo.Id join Make m on m.Id = mm.MakeId
    """):
        model_make[model_id] = (model_name, make_name)

    body_styles = {i: n for i, n in q("select Id, Name from BodyStyle")}

    schema_ids = list(schema_links)
    attrs = defaultdict(list)  # schema -> [[key, code, value]]
    makes = defaultdict(lambda: {"models": defaultdict(list), "schemas": set(), "wmis": set()})
    chunk = 900
    for i in range(0, len(schema_ids), chunk):
        part = schema_ids[i:i + chunk]
        rows = q(f"""
            select VinSchemaId, Keys, ElementId, AttributeId from Pattern
            where ElementId in ({",".join(map(str, ELEMENTS))})
              and VinSchemaId in ({",".join(map(str, part))})
        """).fetchall()
        for sid, key, el, attr in rows:
            code = ELEMENTS[el]
            if code == "M":
                try:
                    model_name, make_name = model_make[int(attr)]
                except (KeyError, ValueError):
                    continue
                mk = makes[make_name]
                for wmi, y0, y1 in schema_links[sid]:
                    mk["models"][model_name].append([wmi, y0, y1, sid, key])
                    mk["wmis"].add(wmi)
                mk["schemas"].add(sid)
            else:
                value = attr
                lookup = {"D": DRIVE_LABELS, "F": FUEL_LABELS, "E": ELECTRIFICATION_LABELS, "B": body_styles}.get(code)
                if lookup is not None:
                    value = lookup.get(int(attr)) if attr.isdigit() else None
                    if not value:
                        continue
                if not value or value.strip() in ("", "-"):
                    continue
                attrs[sid].append([key, code, value.strip()])

    # Character frequencies per WMI and VIN position, used to fill wildcard positions.
    wmi_freq = defaultdict(lambda: [Counter() for _ in range(6)])  # positions 4..8 and 11
    for i in range(0, len(schema_ids), chunk):
        part = schema_ids[i:i + chunk]
        for sid, key in q(f"""
            select distinct VinSchemaId, Keys from Pattern where VinSchemaId in ({",".join(map(str, part))})
        """):
            head, _, tail = key.partition("|")
            toks = tokens(head)
            tail_toks = tokens(tail)
            for wmi, _y0, _y1 in schema_links[sid]:
                f = wmi_freq[wmi]
                for p, t in enumerate(toks[:5]):
                    if len(t) == 1 and t.isalnum():
                        f[p][t] += 1
                if len(tail_toks) > 1 and len(tail_toks[1]) == 1 and tail_toks[1].isalnum():
                    f[5][tail_toks[1]] += 1

    # Literal characters per schema at VIN positions 4-8 and 11 (all elements, airbags included),
    # so open positions can be filled with what schemas of the target years use.
    schema_chars = defaultdict(lambda: [Counter() for _ in range(6)])
    for i in range(0, len(schema_ids), chunk):
        part = schema_ids[i:i + chunk]
        for sid, key in q(f"""
            select VinSchemaId, Keys from Pattern where VinSchemaId in ({",".join(map(str, part))})
        """):
            head, _, tail = key.partition("|")
            f = schema_chars[sid]
            for p_, t in enumerate(tokens(head)[:5]):
                if len(t) == 1 and t.isalnum():
                    f[p_][t] += 1
            tt = tokens(tail)
            if len(tt) > 1 and len(tt[1]) == 1 and tt[1].isalnum():
                f[5][tt[1]] += 1

    os.makedirs(os.path.join(out_dir, "index"), exist_ok=True)
    manifest = {}
    total = 0
    for make_name, mk in sorted(makes.items()):
        if not mk["models"]:
            continue
        file_key = norm(make_name)
        if not file_key:
            continue
        models = {}
        for model_name, entries in mk["models"].items():
            seen = set()
            uniq = []
            for e in entries:
                t = tuple(e)
                if t not in seen:
                    seen.add(t)
                    uniq.append(e)
            models[model_name] = uniq
        schemas = {}
        for sid in mk["schemas"]:
            rows = attrs.get(sid)
            if rows:
                dedup = sorted({tuple(r) for r in rows})
                schemas[str(sid)] = [list(r) for r in dedup]
        wmis = {
            w: ["".join(c for c, _ in f.most_common()) for f in wmi_freq[w]]
            for w in sorted(mk["wmis"])
        }
        wschemas = {}
        pchars = {}
        for w in sorted(mk["wmis"]):
            rows = sorted(wmi_links[w])
            wschemas[w] = [list(r) for r in rows]
            for sid, _y0, _y1 in rows:
                if str(sid) not in pchars and sid in schema_chars:
                    pchars[str(sid)] = [[c, n] for f in schema_chars[sid] for c, n in [("".join(ch for ch, _ in f.most_common()), ",".join(str(k) for _, k in f.most_common()))]]
        doc = {"make": make_name, "models": models, "schemas": schemas, "wmis": wmis, "wschemas": wschemas, "pchars": pchars}
        path = os.path.join(out_dir, "index", f"{file_key}.json")
        with open(path, "w") as fh:
            json.dump(doc, fh, separators=(",", ":"))
        total += os.path.getsize(path)
        manifest.setdefault(file_key, []).append(make_name)

    with open(os.path.join(out_dir, "makes.json"), "w") as fh:
        json.dump(manifest, fh, separators=(",", ":"), sort_keys=True)
    print(f"makes: {len(manifest)}  index bytes: {total}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
