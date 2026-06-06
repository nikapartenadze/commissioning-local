#!/usr/bin/env python3
"""Manual I4 data-loss check — same logic as observer/probe.py check_data_loss,
run directly against the live soak (the observer's monotonic clock lagged, so
this gives the decisive verdict without waiting). Inputs already dumped to the
run dir."""
import glob, json, os, re

RUN = "runs/overnight-20260606-0236"

def norm(r):
    return None if r in (None, "", "Cleared") else r

# journals → latest non-hot write per IO
journaled, hot = {}, set()
for p in glob.glob(f"{RUN}/journal-bot*.jsonl"):
    for line in open(p, errors="replace"):
        try: e = json.loads(line)
        except: continue
        if e.get("action") != "mark" or e.get("status") != 200: continue
        iid = e.get("ioId")
        if iid is None: continue
        if e.get("hot"): hot.add(iid); continue
        ts = e.get("ts", "")
        if iid not in journaled or ts > journaled[iid][0]:
            journaled[iid] = (ts, e.get("result"))
journaled = {i: r for i, (t, r) in journaled.items() if i not in hot}

# local + queue
L = json.load(open(f"{RUN}/_local.json"))
local = {int(k): v for k, v in L["res"].items()}
queued = set(L["queued"])

# cloud
cloud = {}
for line in open(f"{RUN}/_cloud.txt", errors="replace"):
    line = line.strip()
    if "|" not in line: continue
    i, r = line.split("|", 1)
    cloud[int(i)] = r or None

# business-rejected (SPARE etc.) + suspect(non-business) IOs the observer
# classifies — business are EXCLUDED (legit cloud refusal), suspect = bug drops.
R = json.load(open(f"{RUN}/_rejected.json"))
rejected, suspect = set(R["business"]), set(R["suspect"])

# wiped: field wrote it, local no longer has it, NOT a business reject
wiped = [i for i, r in journaled.items()
         if i not in rejected and norm(local.get(i)) != norm(r)]
# unsynced-lost: local has it, cloud doesn't, NOT queued, NOT business-rejected
unsynced_lost = [i for i in journaled
                 if norm(local.get(i)) != norm(cloud.get(i))
                 and i not in queued and i not in rejected]

print(f"non-hot soak writes (journaled): {len(journaled)}")
print(f"hot-set IOs (excluded, ambiguous): {len(hot)}")
print(f"business-rejected (SPARE) excluded: {len(rejected)}")
print(f"suspect silent drops (B1/B7 — must be 0): {len(suspect)}")
print(f"local_wiped (field write lost from local): {len(wiped)}")
print(f"unsynced_lost (not in cloud AND not queued AND not rejected): {len(unsynced_lost)}")
print(f"still_queued_safe (distinct IOs pending): {len(queued)}")
if wiped[:8]: print("  wiped sample:", [(i, journaled[i], local.get(i)) for i in wiped[:8]])
if unsynced_lost[:8]: print("  lost sample:", [(i, local.get(i), cloud.get(i)) for i in unsynced_lost[:8]])
verdict = not wiped and not unsynced_lost and not suspect
print(f"\nI4 DATA-LOSS: {'PASS — zero field work lost' if verdict else 'FAIL'}")
