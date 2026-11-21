"""Add real VIN prefixes from NHTSA consumer complaints to the per-make index.

The complaints file (https://static.nhtsa.gov/odi/ffdd/cmpl/FLAT_CMPL.zip) has the first 11 VIN
characters of each complained-about vehicle, with its make, model and model year. SPV matches on
VIN positions 1-8 and 10, so each distinct prefix is a VIN SPV is very likely to know, and its
count says how common that build is.

Usage: python3 -I tools/build_real.py FLAT_CMPL.zip data
Adds `real: {year: [[prefix9, count, "MODEL|OTHER NAME"], ...]}` (prefix9 = VIN positions 1-8 + 10)
to data/index/<make>.json. Run after build_index.py.
"""
import collections
import io
import json
import os
import re
import sys
import zipfile

YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789"
VIN_CHARS = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789"
VALID = re.compile(r"^[A-HJ-NPR-Z0-9]{10,}$")


def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def year_char(y):
    return YEAR_CODES[(y - 1980) % 30]


def read_complaints(path):
    # make key -> year -> prefix -> Counter(model name)
    agg = collections.defaultdict(lambda: collections.defaultdict(lambda: collections.defaultdict(collections.Counter)))
    with zipfile.ZipFile(path) as z:
        name = next(n for n in z.namelist() if n.upper().endswith(".TXT"))
        with z.open(name) as raw:
            for line in io.TextIOWrapper(raw, encoding="latin-1", newline=""):
                f = line.rstrip("\r\n").split("\t")
                if len(f) < 15:
                    continue
                make, model, year, vin = f[3].strip(), f[4].strip().upper(), f[5].strip(), f[14].strip().upper()
                if not vin or not year.isdigit() or not model:
                    continue
                y = int(year)
                if y < 1981 or y > 2030 or not VALID.match(vin) or vin[9] != year_char(y):
                    continue
                agg[norm(make)][y][vin[:8] + vin[9]][model] += 1
    return agg


def drop_typos(prefixes):
    """Single sightings one character away from a common prefix are most likely typos."""
    counts = {p: sum(c.values()) for p, c in prefixes.items()}
    keep = {}
    for p, names in prefixes.items():
        n = counts[p]
        if n == 1:
            near = max((counts.get(p[:i] + ch + p[i + 1:], 0) for i in range(3, 9) for ch in VIN_CHARS if ch != p[i]), default=0)
            if near >= 5:
                continue
        keep[p] = names
    return keep


def main(zip_path, out_dir):
    agg = read_complaints(zip_path)
    index_dir = os.path.join(out_dir, "index")
    added = files = 0
    for fname in sorted(os.listdir(index_dir)):
        key = fname[:-5]
        if key not in agg:
            continue
        path = os.path.join(index_dir, fname)
        with open(path) as fh:
            doc = json.load(fh)
        wmis = set(doc.get("wmis", {}))
        real = {}
        for y, prefixes in sorted(agg[key].items()):
            prefixes = {p: c for p, c in prefixes.items() if p[:3] in wmis}
            rows = [
                [p, sum(names.values()), "|".join(n for n, _ in names.most_common(3))]
                for p, names in drop_typos(prefixes).items()
            ]
            if rows:
                rows.sort(key=lambda r: -r[1])
                real[str(y)] = rows
                added += len(rows)
        doc["real"] = real
        with open(path, "w") as fh:
            json.dump(doc, fh, separators=(",", ":"))
        files += 1
    print(f"real prefixes: {added} in {files} make files")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
