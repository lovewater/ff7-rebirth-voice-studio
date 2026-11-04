"""CPU evidence for full original JP reuse. Never infer words or crop audio."""
from __future__ import annotations
import argparse
import array
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys

VERSION = 'remake-full-source-acoustic-v1'

def measure(samples, rate, channels):
    if rate <= 0 or channels <= 0 or not samples or len(samples) % channels:
        raise ValueError('invalid-pcm-layout')
    if not all(math.isfinite(x) for x in samples):
        raise ValueError('nonfinite-pcm')
    peak = max(abs(x) for x in samples)
    frames = len(samples) // channels
    # Separate channels, float32 PCM: neither cancellation nor PCM16 rounding can fake silence.
    exact_zero = all(x == 0 for x in samples)
    active_frames = sum(any(abs(samples[i + ch]) >= peak * .15 for ch in range(channels))
                        for i in range(0, len(samples), channels)) if peak else 0
    return dict(version=VERSION, decoded=True, channels=channels, sample_rate=rate,
                frames=frames, duration_s=frames / rate, peak=peak,
                exact_zero=exact_zero, active_s=active_frames / rate,
                classification='exact-pcm-zero' if exact_zero else 'nonzero-activity',
                linguistic_classification=False, full_clip=True)

def analyze(file: Path):
    # Fixed upper limit prevents corrupt headers from exhausting the worker; fail rather than truncate.
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=channels,sample_rate,duration:format=duration', '-of', 'json', str(file)],
        check=True, capture_output=True, timeout=30)
    meta = json.loads(probe.stdout)
    stream = meta['streams'][0]
    channels, rate = int(stream['channels']), int(stream['sample_rate'])
    duration = float(stream.get('duration', meta.get('format', {}).get('duration', 0)))
    if not 0 < duration <= 900 or not 1 <= channels <= 8 or not 8000 <= rate <= 192000:
        raise ValueError('unsupported-audio-layout-or-duration')
    result = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', '-i', str(file),
        '-map', '0:a:0', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
        check=True, capture_output=True, timeout=120)
    samples = array.array('f', result.stdout)
    if sys.byteorder != 'little':
        samples.byteswap()
    evidence = measure(samples, rate, channels)
    evidence['source_sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
    return evidence

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('file', type=Path)
    args = parser.parse_args()
    print(json.dumps(analyze(args.file)))
