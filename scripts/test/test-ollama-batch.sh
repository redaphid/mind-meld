#!/bin/bash

# Generate 100 test inputs
inputs='["'
for i in {1..100}; do
    inputs+="This is test message number $i with some content to embed"
    if [ $i -lt 100 ]; then
        inputs+='","'
    fi
done
inputs+='"]'

echo "Testing Ollama with batch of 100 inputs..."
echo "Request size: $(echo "$inputs" | wc -c) bytes"

# Send request
response=$(curl -s http://localhost:11434/api/embed \
    -d "{\"model\":\"bge-m3\",\"input\":$inputs}")

# Check if response contains NaN
if echo "$response" | grep -q "NaN"; then
    echo "❌ FOUND NaN in response!"
    echo "$response" | head -100
    exit 1
fi

# Parse and check
echo "$response" | python3 -c "
import sys, json, math
try:
    data = json.load(sys.stdin)
    print(f'✅ Got {len(data[\"embeddings\"])} embeddings')

    # Check each embedding for NaN
    nan_count = 0
    for i, emb in enumerate(data['embeddings']):
        if any(math.isnan(x) for x in emb):
            nan_count += 1
            print(f'   ❌ Embedding {i} has NaN!')

    if nan_count == 0:
        print('✅ No NaN values found')
    else:
        print(f'❌ Found {nan_count} embeddings with NaN')
        sys.exit(1)
except json.JSONDecodeError as e:
    print(f'❌ Failed to parse JSON: {e}')
    sys.exit(1)
except Exception as e:
    print(f'❌ Error: {e}')
    sys.exit(1)
"
