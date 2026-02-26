"""
inject_old_humidity.py
Injects old WROOM humidity CSV data into merged_data.js.

The parser in perth_wroom.html already supports a dual-channel format:
  window.THINGSPEAK_DATA = { channel: {...}, tempFeeds: [...], humFeeds: [...] }
handled by parseThingSpeakMerge() which merges them by timestamp.

This script converts merged_data.js from:
  { channel, feeds: [...] }
to:
  { channel, tempFeeds: [...old feeds...], humFeeds: [...from humidity CSV...] }

The humFeeds entries use the ThingSpeak CSV field format:
  field1=rh1, field2=rh2, field3=rh3, field4=rh4, field5=rh5
matching field1..field5 from "WROOM - Humidity Data.csv".
"""

import csv, json, re, os, shutil
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
HUM_CSV   = os.path.join(BASE, "data", "WROOM - Humidity Data.csv")
MERGED_JS = os.path.join(BASE, "data", "data_WROOM_PTT", "merged_data.js")

print(f"Reading humidity CSV: {HUM_CSV}")
hum_feeds = []
with open(HUM_CSV, newline='', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        ts_str = row['created_at'].strip()
        # Normalise to Z suffix (remove +00:00 offset)
        ts_str = ts_str.replace('+00:00', 'Z').replace('Z', '+00:00')
        try:
            ts = datetime.fromisoformat(ts_str)
        except ValueError:
            # Fallback: strip timezone and assume UTC
            ts_str_bare = re.sub(r'[+\-]\d{2}:\d{2}$', '', ts_str).replace('Z', '')
            ts = datetime.fromisoformat(ts_str_bare).replace(tzinfo=timezone.utc)

        # Format back to ISO-Z for output
        ts_out = ts.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

        entry = {
            "created_at": ts_out,
            "entry_id": int(row.get('entry_id', 0) or 0),
        }
        for i, field in enumerate(['field1','field2','field3','field4','field5'],1):
            v = row.get(field, '').strip()
            entry[field] = v if v else None
        hum_feeds.append(entry)

print(f"  Loaded {len(hum_feeds)} humidity entries "
      f"({hum_feeds[0]['created_at']} to {hum_feeds[-1]['created_at']})")

# -- Read merged_data.js ----------------------------------------------
print(f"Reading merged_data.js: {MERGED_JS}")
with open(MERGED_JS, 'r', encoding='utf-8') as f:
    content = f.read()

# Preserve header comment lines
header_lines = []
for line in content.splitlines():
    if line.startswith('//'):
        header_lines.append(line)
    else:
        break
header = '\n'.join(header_lines)

# Extract the JSON object
m = re.search(r'window\.THINGSPEAK_DATA\s*=\s*(\{.*\})\s*;?\s*$', content, re.DOTALL)
if not m:
    raise ValueError("Could not find window.THINGSPEAK_DATA in merged_data.js")

ts_data = json.loads(m.group(1))

# Determine existing feeds
if 'feeds' in ts_data:
    temp_feeds = ts_data.pop('feeds')
    print(f"  Found {len(temp_feeds)} entries in 'feeds' (single-channel format)")
elif 'tempFeeds' in ts_data:
    temp_feeds = ts_data['tempFeeds']
    print(f"  Found {len(temp_feeds)} entries in 'tempFeeds' (already dual format)")
else:
    raise ValueError("merged_data.js has neither 'feeds' nor 'tempFeeds'")

print(f"  Temp feed range: {temp_feeds[0]['created_at']} -> {temp_feeds[-1]['created_at']}")

# -- Build output -----------------------------------------------------
ts_data['tempFeeds'] = temp_feeds
ts_data['humFeeds']  = hum_feeds

# Backup original
backup = MERGED_JS + '.bak'
shutil.copy2(MERGED_JS, backup)
print(f"Backed up original to {backup}")

# Write new merged_data.js
json_str = json.dumps(ts_data, separators=(',', ':'))
out = (header + '\n' if header else '') + \
      f'window.THINGSPEAK_DATA = {json_str};'

with open(MERGED_JS, 'w', encoding='utf-8', newline='\n') as f:
    f.write(out)

file_kb = os.path.getsize(MERGED_JS) / 1024
print(f"\n✓ Written {MERGED_JS}")
print(f"  tempFeeds: {len(temp_feeds)} entries")
print(f"  humFeeds:  {len(hum_feeds)} entries")
print(f"  File size: {file_kb:.1f} KB")
print("\nDone. Reload perth_wroom.html to verify humidity data from Feb 10 onward.")
