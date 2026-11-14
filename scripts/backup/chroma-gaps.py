"""Print every collection whose copied HNSW index cannot be completed by replay.

Usage: python3 -I chroma-gaps.py <chroma data dir>   (prints nothing when the copy is whole)

Chroma keeps each HNSW segment's replay point (max_seq_id) in sqlite and the index in
files; on start it replays the queue past that point into the index. A copy whose
sqlite replay point is ahead of its index files restores with every count right and
the vectors in the gap unsearchable. So every id the metadata holds must be in the
index file's id map or in a queued add or upsert past the replay point.
"""
import pathlib
import pickle
import sqlite3
import sys

ADD, UPSERT = 0, 2  # chroma's embeddings_queue.operation codes


class DataOnly(pickle.Unpickler):
    # The id map is plain dicts, lists, strings and ints. Refusing every global means
    # a crafted file cannot run code here.
    def find_class(self, module, name):
        raise pickle.UnpicklingError(f"refusing {module}.{name}")


def indexed_ids(segment_dir: pathlib.Path) -> set:
    f = segment_dir / "index_metadata.pickle"
    if not f.exists():
        return set()
    with f.open("rb") as fh:
        return set(DataOnly(fh).load()["id_to_label"])


root = pathlib.Path(sys.argv[1])
db = sqlite3.connect(f"file:{root / 'chroma.sqlite3'}?mode=ro", uri=True)
segments = db.execute(
    "select v.id, v.collection, m.id from segments v join segments m"
    " on m.collection = v.collection and m.scope = 'METADATA' where v.scope = 'VECTOR'"
).fetchall()
for vector_seg, collection, metadata_seg in segments:
    replay_from = db.execute("select coalesce(max(seq_id), 0) from max_seq_id where segment_id = ?", (vector_seg,)).fetchone()[0]
    queued = {
        r[0]
        for r in db.execute(
            "select id from embeddings_queue where topic like ? and seq_id > ? and operation in (?, ?)",
            (f"%/{collection}", replay_from, ADD, UPSERT),
        )
    }
    covered = indexed_ids(root / vector_seg) | queued
    missing = sum(1 for (i,) in db.execute("select embedding_id from embeddings where segment_id = ?", (metadata_seg,)) if i not in covered)
    if missing:
        print(f"collection {collection}: {missing} ids in neither the index nor the replay queue")
