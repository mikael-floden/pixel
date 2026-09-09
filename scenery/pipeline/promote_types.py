"""Promote a unanimous per-piece correction to the GROUP's own type.

Run after consume_types.py, whenever he has done a round of Kind-picker
corrections:

    python3 scenery/pipeline/promote_types.py            # list candidates
    python3 scenery/pipeline/promote_types.py --write    # promote them


Only for a group where EVERY piece already carries the same override: the group
default is then provably wrong, flipping it changes nothing that is published
(verified below), and the redundant per-piece overrides come off. What it does
change is the only thing that matters going forward — the type a NEW piece in
that group inherits, which is what keeps minting wrong pieces otherwise.

A group with even one un-reviewed piece is NOT promoted here: flipping it would
retype art he has not looked at.
"""
import json, os, sys, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory, viewer_build

WRITE = '--write' in sys.argv
VD = os.path.join(factory.ROOT, 'viewer_data.json')
CFG = os.path.join(factory.ROOT, 'config', 'factory.json')
before = {x['rel']: x.get('type') for x in json.load(open(VD))['scenery']}

cfg = json.load(open(CFG))
groups = {g['id']: g for g in cfg['groups'] if isinstance(g, dict) and g.get('id')}

per = collections.defaultdict(list)
for rel in before:
    if '/' in rel:
        per[rel.split('/')[0]].append(rel)

promote = []
for gid, rels in sorted(per.items()):
    g = groups.get(gid)
    if not g or not g.get('type'):
        continue
    ovs = {factory.read_manifest(r).get('type') for r in rels}
    if len(ovs) == 1 and (t := ovs.pop()) and t != g['type']:
        promote.append((gid, g['type'], t, rels))

for gid, old, new, rels in promote:
    print('%-18s %s -> %s  (%d pieces, all overridden)' % (gid, old, new, len(rels)))
    if WRITE:
        groups[gid]['type'] = new
        for r in rels:
            man = factory.read_manifest(r)
            man.pop('type', None)          # the group now says it; the override is noise
            factory.write_manifest(r, man)

if WRITE and promote:
    json.dump(cfg, open(CFG, 'w'), indent=2, ensure_ascii=False)
    viewer_build.build()
    after = {x['rel']: x.get('type') for x in json.load(open(VD))['scenery']}
    moved = {k: (before[k], after[k]) for k in before if before.get(k) != after.get(k)}
    print('\nPUBLISHED TYPES CHANGED FOR %d PIECES  <-- must be 0' % len(moved))
    for k, v in list(moved.items())[:5]:
        print('   ', k, v)
print('\n%d group(s)%s' % (len(promote), '' if WRITE else ' (DRY RUN — pass --write)'))
