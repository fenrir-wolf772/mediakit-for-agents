#!/bin/sh
# Test stub standing in for the whisper.cpp CLI (whisper-cli): writes
# the canned -ojf JSON for the JFK fixture to <output-base>.json and
# prints the segment line, ignoring the audio entirely. Used by
# test/mcp-test.mjs so the whisper.cpp engine path (binary discovery,
# JSON parsing, .srt writing) is exercised without a real binary or
# model — the real engine is covered by the MEDIAKIT_TEST_WHISPER_CPP
# gated block instead.
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-of" ]; then out="$a"; fi
  prev="$a"
done
if [ -z "$out" ]; then echo "stub: no -of given" >&2; exit 2; fi
cat > "$out.json" <<'JSON'
{"result": {"language": "en"}, "transcription": [{"timestamps": {"from": "00:00:00,000", "to": "00:00:10,500"}, "offsets": {"from": 0, "to": 10500}, "text": " And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country."}]}
JSON
echo "[00:00:00.000 --> 00:00:10.500]   And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country."
