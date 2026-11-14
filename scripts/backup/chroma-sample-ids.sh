#!/bin/sh
# Samples ids from a restored chroma.sqlite3 for chroma-search-check.py: the 200
# newest per collection (the ones a replay gap would lose) and 300 at random.
# Run inside the backup image with the restored data at /restore and a private
# output directory at /out.
set -eu
db=/restore/chroma.sqlite3
sqlite3 -readonly "$db" "select c.name, s.id from collections c join segments s on s.collection = c.id where s.scope = 'METADATA'" |
	while IFS='|' read -r name seg; do
		sqlite3 -readonly "$db" "select embedding_id from embeddings where segment_id = '$seg' order by seq_id desc limit 200" >"/out/ids-newest-$name.txt"
		sqlite3 -readonly "$db" "select embedding_id from embeddings where segment_id = '$seg' order by random() limit 300" >"/out/ids-random-$name.txt"
	done
wc -l /out/ids-*
