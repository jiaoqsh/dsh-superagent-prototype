"""
Activity gaps of coding-agent turns (#8): how long a healthy agent goes without a visible step, to set a Watchdog threshold.

Reads Claude Code session transcripts (JSONL) and uses only each entry's type and timestamp, never its content. A turn runs
from a person's message to the next one; a gap is the time between two consecutive steps within a turn (a model message or a
tool result). Waits for a person inside a turn, such as a permission prompt, count as gaps too, so the false alarms below are
an upper bound.

    python3 bench/replay/activity-gaps.py ['~/.claude/projects/*/*.jsonl']
"""
import glob, json, os, sys
from datetime import datetime

pattern = sys.argv[1] if len(sys.argv) > 1 else '~/.claude/projects/*/*.jsonl'
ts = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
turns = []
for path in glob.glob(os.path.expanduser(pattern)):
    if os.path.getsize(path) < 50_000: continue
    steps = []
    for line in open(path, errors='ignore'):
        try: entry = json.loads(line)
        except ValueError: continue
        kind = entry.get('type')
        if kind not in ('user', 'assistant') or 'timestamp' not in entry or entry.get('isSidechain'): continue
        content = (entry.get('message') or {}).get('content')
        tool_result = isinstance(content, list) and any(isinstance(x, dict) and x.get('type') == 'tool_result' for x in content)
        steps.append((ts(entry['timestamp']), kind == 'user' and not tool_result))
    steps.sort()
    turn = None
    for at, person in steps:
        if person:
            if turn and len(turn) > 1: turns.append(turn)
            turn = [at]
        elif turn is not None: turn.append(at)
    if turn and len(turn) > 1: turns.append(turn)
if not turns: sys.exit(f'no turns found in {pattern}')
gaps = sorted(b - a for turn in turns for a, b in zip(turn, turn[1:]))
lengths = sorted(turn[-1] - turn[0] for turn in turns)
hours = sum(lengths) / 3600
q = lambda xs, p: xs[min(len(xs) - 1, int(p * len(xs)))]
print(f'turns {len(turns)}, agent-hours {hours:.1f}, steps {len(gaps)}')
print('gap (s): ' + '  '.join(f'p{p * 100:g}={q(gaps, p):.0f}' for p in (0.5, 0.9, 0.99, 0.999)) + f'  max={gaps[-1]:.0f}')
print('\n| threshold | turns longer (a turn-time limit) | turns with a gap longer (an activity limit) | false alarms / agent-hour |')
print('|---|---|---|---|')
for minutes in (1, 2, 5, 10, 15, 20, 30, 60, 120, 180):
    t = minutes * 60
    longer = sum(1 for length in lengths if length > t)
    gapped = sum(1 for turn in turns if any(b - a > t for a, b in zip(turn, turn[1:])))
    print(f'| {minutes} min | {longer / len(turns):.1%} | {gapped / len(turns):.1%} | {sum(1 for g in gaps if g > t) / hours:.2f} |')
