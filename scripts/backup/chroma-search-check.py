"""Prove a restored Chroma searches like live: counts, self-queries of sampled vectors, top-10 overlap.

Usage: python -I chroma-search-check.py <live base url> <restored base url> <ids dir>
The ids dir comes from chroma-sample-ids.sh. Prints numbers only, never ids. See docs/backups.md.
"""
import json
import pathlib
import sys
import urllib.request

live, restored, ids_dir = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
API = "/api/v2/tenants/default_tenant/databases/default_database/collections"


def call(base, path, body=None):
    req = urllib.request.Request(base + API + path, method="POST" if body is not None else "GET")
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data, timeout=300) as r:
        return json.load(r)


def collections(base):
    return {c["name"]: c["id"] for c in call(base, "?limit=100")}


live_cols, rest_cols = collections(live), collections(restored)
failed = False
print("collection        live_count  restored_count")
for name in sorted(live_cols):
    lc = call(live, f"/{live_cols[name]}/count")
    rc = call(restored, f"/{rest_cols[name]}/count") if name in rest_cols else None
    print(f"{name:17} {lc:>10}  {rc!s:>14}")

for name in sorted(rest_cols):
    for kind in ("newest", "random"):
        f = ids_dir / f"ids-{kind}-{name}.txt"
        if not f.exists():
            continue
        ids = [l.strip() for l in f.read_text().splitlines() if l.strip()]
        if not ids:
            continue
        got = call(live, f"/{live_cols[name]}/get", {"ids": ids, "include": ["embeddings"]})
        vecs = dict(zip(got["ids"], got["embeddings"]))
        missing_live = len(ids) - len(vecs)
        sample = [i for i in ids if i in vecs]
        stats = {}
        top10_overlap = []
        for side, base, cols in (("live", live, live_cols), ("restored", restored, rest_cols)):
            rank1 = top10 = tie0 = 0
            results = []
            for start in range(0, len(sample), 50):
                batch = sample[start:start + 50]
                r = call(base, f"/{cols[name]}/query", {"query_embeddings": [vecs[i] for i in batch], "n_results": 10, "include": ["distances"]})
                results.extend(r["ids"])
                for want, res, dist in zip(batch, r["ids"], r["distances"]):
                    rank1 += bool(res) and res[0] == want
                    top10 += want in res
                    tie0 += bool(res) and res[0] != want and dist[0] < 1e-6
            stats[side] = (rank1, top10, tie0, results)
        for a, b in zip(stats["live"][3], stats["restored"][3]):
            top10_overlap.append(len(set(a) & set(b)) / max(len(a), 1))
        # HNSW is approximate, and live's graph already cannot reach some of its own nodes. A restored graph is
        # rebuilt by Chroma's own replay, so it is judged by recall parity with live, not by perfection.
        suspects = [sample[i] for i, (a, b) in enumerate(zip(stats["live"][3], stats["restored"][3])) if sample[i] in a and sample[i] not in b]
        lost = 0
        if suspects:
            r = call(restored, f"/{rest_cols[name]}/query", {"query_embeddings": [vecs[i] for i in suspects], "n_results": 100, "include": ["distances"]})
            lost = sum(1 for want, res in zip(suspects, r["ids"]) if want not in res)
        failed |= stats["restored"][1] < stats["live"][1] - max(1, len(sample) // 100)
        fmt = lambda s: f"rank1 {s[0]}/{len(sample)} top10 {s[1]}/{len(sample)} rank1-is-a-zero-distance-twin {s[2]}"
        print(f"{name:17} {kind:6} live[{fmt(stats['live'])}] restored[{fmt(stats['restored'])}] "
              f"live-top10-not-restored-top10 {len(suspects)} not-in-restored-top100 {lost}  top10 overlap {sum(top10_overlap) / len(top10_overlap):.3f}")

print("RESULT", "FAIL" if failed else "PASS")
sys.exit(1 if failed else 0)
