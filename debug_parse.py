"""
Simulate the exact JavaScript parsing logic from perth_wroom.html
to find where the data gap bug is.
"""
import json, re
from datetime import datetime, timezone, timedelta

# Load data
with open('data/data_WROOM_PTT/merged_data.js', 'r') as f:
    content = f.read()

json_str = re.sub(r'^[^{]*', '', content)
json_str = re.sub(r';\s*$', '', json_str)
data = json.loads(json_str)

SENSOR_COUNT = 5
tempFeeds = data.get('tempFeeds', [])
humFeeds = data.get('humFeeds', [])

print(f"tempFeeds: {len(tempFeeds)}")
print(f"humFeeds: {len(humFeeds)}")

def num_parse(v):
    if v is None or v == '' or v == 'null' or v == 'None':
        return None
    try:
        n = float(v)
        return n
    except:
        return None

def round_min(ts):
    return round(ts.timestamp() / 60)

# Simulate parseThingSpeakMerge exactly
entries = {}

if tempFeeds:
    for f in tempFeeds:
        ts_str = f.get('created_at', '')
        try:
            ts = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
        except:
            continue
        key = round_min(ts)
        if key not in entries:
            entries[key] = {'timestamp': ts}
        e = entries[key]
        
        field2 = f.get('field2')
        # CSV detection
        if field2 and isinstance(field2, str) and ',' in field2:
            # CSV format
            tParts = field2.split(',')
            rhParts = (f.get('field3') or '').split(',')
            for s in range(1, SENSOR_COUNT + 1):
                tv = num_parse(tParts[s-1]) if (s-1 < len(tParts)) else None
                hv = num_parse(rhParts[s-1]) if (s-1 < len(rhParts)) else None
                e[f't{s}'] = tv
                e[f'rh{s}'] = hv
                if f'ok{s}' not in e:
                    e[f'ok{s}'] = 1 if (tv is not None or hv is not None) else 0
        else:
            # Old dual-channel format
            for s in range(1, min(SENSOR_COUNT, 8) + 1):
                val = num_parse(f.get(f'field{s}'))
                e[f't{s}'] = val
                if f'ok{s}' not in e:
                    e[f'ok{s}'] = 1 if (val is not None and val != 0) else 0

if humFeeds:
    for f in humFeeds:
        ts_str = f.get('created_at', '')
        try:
            ts = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
        except:
            continue
        key = round_min(ts)
        if key not in entries:
            entries[key] = {'timestamp': ts}
        e = entries[key]
        for s in range(1, min(SENSOR_COUNT, 8) + 1):
            val = num_parse(f.get(f'field{s}'))
            e[f'rh{s}'] = val
            if val is not None and val != 0:
                e[f'ok{s}'] = 1

# Fill missing keys
all_entries = []
for e in entries.values():
    for s in range(1, SENSOR_COUNT + 1):
        if f't{s}' not in e: e[f't{s}'] = None
        if f'rh{s}' not in e: e[f'rh{s}'] = None
        if f'ok{s}' not in e: e[f'ok{s}'] = 0
    all_entries.append(e)

all_entries.sort(key=lambda e: e['timestamp'])
print(f"Total parsed entries: {len(all_entries)}")

# Now simulate "week" time range (last 7 days from latest entry)
latest = all_entries[-1]['timestamp']
week_start = latest - timedelta(days=7)
filtered = [e for e in all_entries if e['timestamp'] >= week_start]
print(f"Filtered entries (last week): {len(filtered)}")
print(f"  From: {filtered[0]['timestamp']}")
print(f"  To:   {filtered[-1]['timestamp']}")

# Now simulate makeDataset for each sensor
for s in range(1, SENSOR_COUNT + 1):
    key = f't{s}'
    data_points = [(e['timestamp'], e[key]) for e in filtered if e[key] is not None and e[key] is not None]
    
    print(f"\nSensor {s} ({key}): {len(data_points)} chart points")
    
    # Check for gaps - find the largest gap
    if len(data_points) >= 2:
        max_gap = timedelta(0)
        max_gap_start = None
        max_gap_end = None
        for i in range(1, len(data_points)):
            gap = data_points[i][0] - data_points[i-1][0]
            if gap > max_gap:
                max_gap = gap
                max_gap_start = data_points[i-1][0]
                max_gap_end = data_points[i][0]
        
        print(f"  Largest gap: {max_gap}")
        print(f"    from {max_gap_start}")
        print(f"    to   {max_gap_end}")
        
        # Convert to Perth time
        perth_tz = timezone(timedelta(hours=8))
        if max_gap_start:
            print(f"    Perth: {max_gap_start.astimezone(perth_tz)} to {max_gap_end.astimezone(perth_tz)}")

# Check specifically around the gap period
print("\n\n=== GAP ZONE DETAIL ===")
print("Entries between Feb 24 14:00 UTC and Feb 25 20:00 UTC:")
gap_start = datetime(2026, 2, 24, 14, 0, tzinfo=timezone.utc)
gap_end = datetime(2026, 2, 25, 20, 0, tzinfo=timezone.utc)

gap_entries = [e for e in all_entries if gap_start <= e['timestamp'] <= gap_end]
print(f"Count: {len(gap_entries)}")

# Check for entries where t2-t5 are all None
null_sensors = [e for e in gap_entries if all(e.get(f't{s}') is None for s in range(2, 6))]
print(f"Entries where t2-t5 ALL null: {len(null_sensors)}")

# Show entries where ANY of t2-t5 is None
partial_null = [e for e in gap_entries if any(e.get(f't{s}') is None for s in range(2, 6))]
print(f"Entries where ANY of t2-t5 null: {len(partial_null)}")
for e in partial_null[:5]:
    print(f"  {e['timestamp']} t1={e.get('t1')} t2={e.get('t2')} t3={e.get('t3')} t4={e.get('t4')} t5={e.get('t5')}")

# Check if CSV entries are correctly parsed
print("\n\n=== CSV FORMAT ENTRIES ===")
csv_in_gap = [e for e in gap_entries if e.get('_csv', False)]
# Actually let's track which format each entry came from...
# Re-analyze specifically
print("\nFirst few entries and last few entries in gap zone:")
for e in gap_entries[:3]:
    print(f"  {e['timestamp']} t1={e.get('t1'):.1f} t2={e.get('t2')} t3={e.get('t3')} t4={e.get('t4')} t5={e.get('t5')}")
print("  ...")
for e in gap_entries[-3:]:
    print(f"  {e['timestamp']} t1={e.get('t1'):.1f} t2={e.get('t2')} t3={e.get('t3')} t4={e.get('t4')} t5={e.get('t5')}")

# CRITICAL: Check entries around the format transition
print("\n\n=== FORMAT TRANSITION ===")
transition_start = datetime(2026, 2, 25, 9, 0, tzinfo=timezone.utc)
transition_end = datetime(2026, 2, 25, 12, 0, tzinfo=timezone.utc)
transition_entries = [e for e in all_entries if transition_start <= e['timestamp'] <= transition_end]
print(f"Entries between 09:00-12:00 UTC on Feb 25: {len(transition_entries)}")
for e in transition_entries:
    print(f"  {e['timestamp']} t1={e.get('t1')} t2={e.get('t2')} t3={e.get('t3')} t4={e.get('t4')} t5={e.get('t5')}")

# ALSO: Check for humFeeds entries in the gap that might OVERWRITE good temp data
print("\n\n=== humFeeds OVERWRITE CHECK ===")
# Check if any humFeed entries have the same minute-key as tempFeed entries
# and might set rh values incorrectly while also matching a t value
hum_keys = set()
for f in humFeeds:
    ts_str = f.get('created_at', '')
    try:
        ts = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
    except:
        continue
    hum_keys.add(round_min(ts))

temp_keys_in_gap = set()
for e in gap_entries:
    temp_keys_in_gap.add(round_min(e['timestamp']))

overlap = temp_keys_in_gap & hum_keys
print(f"humFeed entries overlapping with gap period: {len(overlap)}")

# Check humFeeds data format
print(f"\nhumFeeds sample (first 3):")
for f in humFeeds[:3]:
    print(f"  {f.get('created_at')} f1={f.get('field1')} f2={f.get('field2')} f3={f.get('field3')} f4={f.get('field4')} f5={f.get('field5')}")

# IMPORTANT: Check if humFeeds contain CSV data that looks like it has commas
csv_hum = [f for f in humFeeds if f.get('field2') and ',' in str(f.get('field2', ''))]
print(f"\nhumFeeds with CSV in field2: {len(csv_hum)}")
if csv_hum:
    for f in csv_hum[:3]:
        print(f"  {f.get('created_at')} f1={f.get('field1')} f2={f.get('field2')} f3={f.get('field3')}")

# Check if humChannel has different field names
print(f"\nhumChannel info:")
hc = data.get('humChannel', {})
for k, v in hc.items():
    if k.startswith('field') or k in ('id', 'name'):
        print(f"  {k}: {v}")
