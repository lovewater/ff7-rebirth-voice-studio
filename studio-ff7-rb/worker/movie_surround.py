"""Replace reviewed dialogue-only movie-bank windows on all voice channels.

The center is the selected Chinese PCM. The original per-window channel energy
balance is used for dry surround copies; Japanese reverberation is removed.
This does not reconstruct the original room impulse response. Untouched windows
and LFE are preserved exactly before the unavoidable whole-bank HCA encoding.
"""
from __future__ import annotations
import array
import hashlib
import math
import re
import struct

POLICY = 'movie-dialogue-surround-v1'
VOICE_CHANNELS = (0, 1, 2, 4, 5)


def event_cues(data: bytes) -> list[tuple[str, int]]:
    """Read a MovieScene event time/value array, rejecting ambiguous identities."""
    matches = list(re.finditer(rb'(?:[A-Z0-9]+_)+(?:[0-9]{2,4}_){2,5}[a-zA-Z0-9]+', data))
    if not matches:
        raise RuntimeError('movie voice event has no voice keys')
    first = matches[0].start()
    tables = []
    for pos in range(max(0, first - 20000), first - 8):
        count = struct.unpack_from('<I', data, pos)[0]
        if not 1 <= count <= 1000 or pos + 8 + count * 4 > first:
            continue
        if struct.unpack_from('<I', data, pos + 4 + count * 4)[0] != count or count > len(matches):
            continue
        times = struct.unpack_from('<' + 'i' * count, data, pos + 4)
        if min(times) < 0 or max(times) > 24000 * 7200 or list(times) != sorted(times):
            continue
        keys = [m.group().decode('ascii') for m in matches[:count]]
        if len(set(keys)) != count:
            continue
        tables.append((pos, list(zip(keys, times))))
    if not tables:
        raise RuntimeError('movie voice event time/value table is unproven')
    return max(tables, key=lambda x: x[0])[1]


def window_profile(extra: dict, stem: str, cues: list[tuple[str, int]], event_sha: str, overlap_approval: dict | None = None) -> dict:
    if extra.get('tick_resolution') != 24000 or extra.get('frame_rate') != 30:
        raise RuntimeError(f'{stem}: movie event time base is not proven')
    tick = extra.get('source_voice_tick')
    hits = [(s, t) for s, t in cues if s == stem]
    if hits != [(stem, tick)]:
        raise RuntimeError(f'{stem}: voice event does not match imported source tick')
    origin = extra['bank_start_frame'] / 30
    start = tick / 24000 - origin
    if abs(start - extra['slice_start_s']) > .0001:
        raise RuntimeError(f'{stem}: movie bank offset disagrees with voice event')
    simultaneous = [s for s, t in cues if t == tick and s != stem]
    if simultaneous:
        raise RuntimeError(f'{stem}: simultaneous original voices cannot be separated safely')
    later = [(s, t) for s, t in cues if t > tick]
    following = min(later, key=lambda r: r[1]) if later else None
    stop = following[1] / 24000 - origin if following else None
    overlap = stop is not None and extra['slice_end_s'] > stop + .001
    if overlap:
        expected = dict(stem=stem,source_wav_sha256=extra['source_audio_sha256'],
                        slice_start_s=extra['slice_start_s'],slice_end_s=extra['slice_end_s'],
                        action='replace-dialogue-window')
        if not overlap_approval or any(overlap_approval.get(k) != v for k,v in expected.items()):
            raise RuntimeError(f'{stem}: subtitle slice overlaps the next original voice event; explicit source-bound choice required')
        stop = extra['slice_end_s']
    return dict(overlap_approval=overlap_approval if overlap else None,policy=POLICY, channels=list(VOICE_CHANNELS),
                source_wav_sha256=extra['source_audio_sha256'], event_sha256=event_sha,
                clear_end_s=stop, next_stem=following[0] if following else None)


def replace_windows(samples: array.array, channels: int, rate: int, pieces: list[dict], overrun_s: float = .08) -> list[dict]:
    """Preflight every piece, then replace all reviewed voice channels atomically."""
    if channels != 6 or rate < 1 or len(samples) % channels:
        raise RuntimeError('reviewed movie dialogue requires a six-channel PCM bank')
    before = array.array('h', samples)
    count = len(samples) // channels
    ordered = sorted(pieces, key=lambda p: p['start'])
    plans = []
    for index, p in enumerate(ordered):
        if p.get('keep_japanese'):
            continue
        profile = p.get('surround')
        if not profile or profile.get('policy') != POLICY or profile.get('channels') != list(VOICE_CHANNELS):
            raise RuntimeError(f"{p['stem']}: missing reviewed surround policy")
        start, end = round(p['start'] * rate), round(p['end'] * rate)
        stop = count if profile['clear_end_s'] is None else min(count, round(profile['clear_end_s'] * rate))
        nxt = round(ordered[index + 1]['start'] * rate) if index + 1 < len(ordered) else count
        stop = min(stop, nxt)
        if not 0 <= start < end <= stop <= count:
            raise RuntimeError(f"{p['stem']}: unsafe surround window {start}:{end}:{stop}/{count}")
        if any(abs(v) > 1 for v in before[start * channels + 3:stop * channels:channels]):
            raise RuntimeError(f"{p['stem']}: LFE contains more than quantization noise; needs separate review")
        mono = p['mono']
        length = min(len(mono), stop - start)
        if len(mono) - length > round(overrun_s * rate) and any(mono[length:]):
            raise RuntimeError(f"{p['stem']}: Chinese audio exceeds the next original event")
        center = before[start * channels + 2:end * channels:channels]
        energy = sum(v * v for v in center)
        if not energy:
            raise RuntimeError(f"{p['stem']}: zero center cannot prove dialogue routing")
        peak = max((abs(v) for v in mono[:length]), default=0)
        gains = {}
        for ch in VOICE_CHANNELS:
            if ch == 2:
                gains[ch] = 1.
            else:
                y = before[start * channels + ch:end * channels:channels]
                gain = math.sqrt(sum(v * v for v in y) / energy)
                gains[ch] = min(gain, 32760 / peak) if peak else 0.
        plans.append((p, start, stop, length, gains))
    # No failure after this point may leave a partially modified source bank.
    after = array.array('h', before)
    proof = []
    for p, start, stop, length, gains in plans:
        for ch in VOICE_CHANNELS:
            after[start * channels + ch:stop * channels:channels] = array.array('h', [0]) * (stop - start)
            values = p['mono'][:length] if ch == 2 else array.array('h', (round(v * gains[ch]) for v in p['mono'][:length]))
            after[start * channels + ch:(start + length) * channels:channels] = values
        proof.append(dict(stem=p['stem'],start=start/rate,clear_end=stop/rate,
                          samples_written=length,gains=gains,profile=p['surround']))
    # Outside the replacement intervals every interleaved sample is identical.
    cursor = 0
    for _, start, stop, _, _ in plans:
        if before[cursor * channels:start * channels] != after[cursor * channels:start * channels]:
            raise RuntimeError('untouched movie PCM changed')
        cursor = stop
    if before[cursor * channels:] != after[cursor * channels:] or before[3::channels] != after[3::channels]:
        raise RuntimeError('untouched movie tail or LFE changed')
    samples[:] = after
    return proof
