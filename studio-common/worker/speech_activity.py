"""Read-only net speech duration: remove >=200ms below 15% of each clip's peak.

This is amplitude gating, not linguistic VAD. Short quiet intervals remain.
The old start/end/speech_s timing and punctuation-based beats are unchanged.
"""
from __future__ import annotations

import array
import io
import math
import subprocess
import sys
import wave
from functools import lru_cache
from pathlib import Path

VERSION = "speech-peak15-gap200-v1"
PEAK_RATIO = 0.15
MIN_SILENCE_S = 0.200


def measure(samples, sample_rate: int, channels: int = 1) -> dict:
    """Measure decoded PCM, keeping stereo channels separate (no cancellation).

    A frame is quiet only if ALL channels are below the global clip peak * .15.
    Equality is voiced. All-zero clips have no speech, even if shorter than 200ms.
    """
    if sample_rate <= 0 or channels <= 0 or len(samples) % channels:
        raise ValueError("invalid PCM layout")
    frames = len(samples) // channels
    if not frames:
        raise ValueError("empty audio")
    peak = max(abs(value) for value in samples)
    if not math.isfinite(peak):
        raise ValueError("invalid PCM sample")
    minimum = math.ceil(MIN_SILENCE_S * sample_rate)
    intervals = []
    if peak == 0:
        intervals = [(0, frames)]
    else:
        threshold = peak * PEAK_RATIO
        start = None
        for frame in range(frames):
            quiet = all(abs(samples[frame * channels + ch]) < threshold for ch in range(channels))
            if quiet and start is None:
                start = frame
            elif not quiet and start is not None:
                if frame - start >= minimum:
                    intervals.append((start, frame))
                start = None
        if start is not None and frames - start >= minimum:
            intervals.append((start, frames))
    silence_frames = sum(end - start for start, end in intervals)
    return {
        "version": VERSION, "peakRatio": PEAK_RATIO, "minSilenceMs": 200,
        "durationS": frames / sample_rate,
        "silenceS": silence_frames / sample_rate,
        "activeS": (frames - silence_frames) / sample_rate,
        "silenceCount": len(intervals),
        "silences": [{"startS": a / sample_rate, "endS": b / sample_rate} for a, b in intervals],
        "status": "silent" if silence_frames == frames else "ok",
    }


def safe_path(root: Path, relative: str) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute() or not candidate.parts or candidate.parts[0] not in {"jp", "cn", "tts"}:
        raise ValueError("invalid audio path")
    target = (root / candidate).resolve()
    if not target.is_relative_to(root.resolve()) or target.suffix.lower() not in {".wav", ".mp3"}:
        raise ValueError("invalid audio path")
    return target


@lru_cache(maxsize=1024)
def _decode_cached(path: str, size: int, mtime_ns: int, ctime_ns: int) -> dict:
    # Preserve channels. Fixed rate bounds work; decoded PCM is never saved.
    result = subprocess.run([
        "ffmpeg", "-nostdin", "-v", "error", "-threads", "1", "-i", path,
        "-t", "601", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1",
    ], capture_output=True, timeout=30, check=True)
    with wave.open(io.BytesIO(result.stdout), "rb") as wav:
        channels, rate = wav.getnchannels(), wav.getframerate()
        if wav.getsampwidth() != 2 or channels > 8:
            raise ValueError("unsupported PCM layout")
        samples = array.array("h", wav.readframes(rate * 601))
    if sys.byteorder != "little":
        samples.byteswap()
    if len(samples) > rate * channels * 600:
        raise ValueError("audio exceeds ten minutes")
    return measure(samples, rate, channels)


def analyze_file(root: Path, relative: str) -> dict:
    target = safe_path(root, relative)
    stat = target.stat()
    if not stat.st_size:
        raise ValueError("empty audio")
    return _decode_cached(str(target), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
