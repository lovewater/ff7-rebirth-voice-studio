"""FF7 routes: persistent multi-clip speaker banks and JP-guided synthesis."""

from __future__ import annotations

import base64
import io
import math
import os
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any, List, Optional

import torch
import torch.nn.functional as F
import torchaudio
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from base.ttsmanager import TTSManager

router = APIRouter()
SPEAKER_DIR = Path(os.getenv("FF7_SPEAKER_DIR", "/data/speakers"))
SPEAKER_DIR.mkdir(parents=True, exist_ok=True)


class EmbedRequest(BaseModel):
    speaker: str = Field(..., pattern=r"^[\w.\-]+$", description="版本唯一键，如 red-v12")
    audios: List[str] = Field(..., description="逐句参考音频：路径 / data URL / base64")
    audio_ids: List[str] = Field(default_factory=list, description="与 audios 对齐的素材 stem")
    target_seconds: float = Field(15.0, gt=1, le=15)
    gap_seconds: float = Field(0.12, ge=0, le=1)
    trim_silence: bool = True
    prebatched: bool = False


class EmbedResponse(BaseModel):
    success: bool = True
    speaker: str
    n_clips: int = 0
    batch_count: int = 0
    wav_path: str = ""
    medoid_index: int = 0
    similarities: List[float] = Field(default_factory=list)
    manifest: dict[str, Any] = Field(default_factory=dict)
    embedding_pt_b64: str = ""
    reference_wav_b64: str = ""
    source_wav_b64: str = ""
    message: str = "ok"


class SynthRequest(BaseModel):
    text: str
    speaker: str = Field(..., description="已 embed 的版本唯一键")
    emo_audio: str = Field("", description="日文情绪参考，路径或 base64")
    duration_factor: float = 1.0
    lang: str = "ZH"
    emo_alpha: float = Field(0.8, ge=0, le=1)


class RegisterSpeakerRequest(BaseModel):
    speaker: str = Field(..., pattern=r"^[\w.\-]+$")
    embedding_pt_b64: str
    reference_wav_b64: str


PAUSE_PATTERN = re.compile(r"\[停顿=(\d{1,4})\]")


def _parse_pause_script(text: str) -> list[tuple[str, str | int]]:
    """Parse explicit silences while keeping the actual model text clean."""
    operations: list[tuple[str, str | int]] = []
    cursor = 0
    for match in PAUSE_PATTERN.finditer(text):
        segment = text[cursor:match.start()].strip()
        if segment:
            operations.append(("text", segment))
        pause_ms = int(match.group(1))
        if pause_ms < 50 or pause_ms > 5000:
            raise HTTPException(400, "停顿必须在 50 到 5000 毫秒之间")
        operations.append(("pause", pause_ms))
        cursor = match.end()
    tail = text[cursor:].strip()
    if tail:
        operations.append(("text", tail))
    if not any(kind == "text" for kind, _ in operations):
        raise HTTPException(400, "TTS 文字不能为空")
    return operations


def _decode_audio(item: str, dest: Path) -> Path:
    item = item.strip()
    if os.path.exists(item):
        return Path(item)
    payload = item
    if payload.startswith("data:") and ";base64," in payload:
        payload = payload.split(";base64,", 1)[1]
    try:
        dest.write_bytes(base64.b64decode(payload, validate=True))
    except ValueError as exc:
        raise HTTPException(400, "无效的 base64 音频") from exc
    return dest


def _load_mono16k(path: Path) -> torch.Tensor:
    try:
        wav, sr = torchaudio.load(str(path))
    except (ImportError, OSError):
        import soundfile as sf

        samples, sr = sf.read(str(path), always_2d=True, dtype="float32")
        wav = torch.from_numpy(samples.T.copy())
    if wav.size(0) > 1:
        wav = wav.mean(0, keepdim=True)
    if sr != 16000:
        wav = torchaudio.transforms.Resample(sr, 16000)(wav)
    return wav.float()


def _trim_edges(wav: torch.Tensor, sample_rate: int = 16000) -> torch.Tensor:
    """Remove only leading/trailing near-silence; keep pauses inside a line."""
    if wav.numel() == 0:
        return wav
    magnitude = wav.abs().squeeze(0)
    peak = float(magnitude.max().item())
    if peak <= 0:
        return wav
    threshold = max(10 ** (-45 / 20), peak * 0.01)
    active = torch.nonzero(magnitude >= threshold, as_tuple=False).flatten()
    if active.numel() == 0:
        return wav
    pad = int(sample_rate * 0.05)
    start = max(0, int(active[0]) - pad)
    end = min(wav.size(1), int(active[-1]) + pad + 1)
    return wav[:, start:end]


def _balanced_batches(
    items: list[dict[str, Any]], target_seconds: float, gap_seconds: float
) -> list[list[dict[str, Any]]]:
    total = sum(item["duration_s"] for item in items)
    n_batches = max(1, math.ceil(total / target_seconds))
    while True:
        bins: list[list[dict[str, Any]]] = [[] for _ in range(n_batches)]
        loads = [0.0] * n_batches
        ok = True
        for item in sorted(items, key=lambda row: row["duration_s"], reverse=True):
            candidates = []
            for index, members in enumerate(bins):
                projected = loads[index] + item["duration_s"]
                if projected <= target_seconds + 1e-6:
                    candidates.append((projected, index))
            if not candidates:
                ok = False
                break
            _, index = min(candidates)
            bins[index].append(item)
            loads[index] += item["duration_s"]
        if ok:
            for members in bins:
                members.sort(key=lambda row: (row["ordinal"], row["segment_no"]))
            return bins
        n_batches += 1


def _split_long_items(
    items: list[dict[str, Any]], target_seconds: float
) -> list[dict[str, Any]]:
    """Split every source into balanced contiguous segments no longer than the cap."""
    max_samples = max(1, int(target_seconds * 16000))
    segments: list[dict[str, Any]] = []
    for item in items:
        segment_count = max(1, math.ceil(item["wav"].size(1) / max_samples))
        chunks = torch.tensor_split(item["wav"], segment_count, dim=1)
        for segment_no, chunk in enumerate(chunks, start=1):
            segment_id = (
                item["id"]
                if segment_count == 1
                else f"{item['id']}#{segment_no}/{segment_count}"
            )
            segments.append(
                {
                    **item,
                    "segment_id": segment_id,
                    "segment_no": segment_no,
                    "segment_count": segment_count,
                    "duration_s": chunk.size(1) / 16000,
                    "wav": chunk,
                }
            )
    return segments


def _write_batch(
    members: list[dict[str, Any]], out: Path, gap_seconds: float, target_seconds: float
) -> None:
    speech_seconds = sum(member["duration_s"] for member in members)
    if len(members) > 1:
        gap_seconds = min(
            gap_seconds,
            max(0.0, (target_seconds - speech_seconds) / (len(members) - 1)),
        )
    silence = torch.zeros(1, math.floor(16000 * gap_seconds))
    parts = []
    for index, member in enumerate(members):
        parts.append(member["wav"])
        if index + 1 < len(members):
            parts.append(silence)
    batch = torch.cat(parts, dim=1).cpu()
    try:
        torchaudio.save(str(out), batch, 16000)
    except (ImportError, OSError):
        import soundfile as sf

        sf.write(str(out), batch.squeeze(0).numpy(), 16000, subtype="PCM_16")


def _average_embeddings(
    model, paths: List[Path]
) -> tuple[Optional[torch.Tensor], Optional[torch.Tensor], List[float], int]:
    styles = []
    emotions = []
    for path in paths:
        wav = _load_mono16k(path)
        feat = torchaudio.compliance.kaldi.fbank(
            wav.to(model.device), num_mel_bins=80, dither=0, sample_frequency=16000
        )
        feat = feat - feat.mean(dim=0, keepdim=True)
        with torch.no_grad(), torch.amp.autocast(
            torch.device(model.device).type,
            enabled=model.dtype is not None,
            dtype=model.dtype,
        ):
            styles.append(model.campplus_model(feat.unsqueeze(0)))
            inputs = model.extract_features(wav, sampling_rate=16000, return_tensors="pt")
            semantic = model.get_emb(
                inputs["input_features"].to(model.device),
                inputs["attention_mask"].to(model.device),
            )
            emotions.append(
                model.gpt.get_emovec(
                    semantic,
                    torch.tensor([semantic.shape[-1]], device=model.device),
                )
            )
    if not styles:
        return None, None, [], 0

    stack = F.normalize(torch.cat(styles, dim=0).float(), p=2, dim=-1)
    centroid = F.normalize(stack.mean(dim=0, keepdim=True), p=2, dim=-1)
    emotion_centroid = torch.cat(emotions, dim=0).float().mean(dim=0, keepdim=True)
    similarities = F.cosine_similarity(stack, centroid.expand_as(stack), dim=-1)
    medoid_index = int(similarities.argmax().item())
    return centroid, emotion_centroid, similarities.detach().cpu().tolist(), medoid_index


@router.post("/v1/speaker/embed", response_model=EmbedResponse)
def embed_speaker(req: EmbedRequest):
    if not req.audios:
        raise HTTPException(400, "audios 不能为空")
    if req.audio_ids and len(req.audio_ids) != len(req.audios):
        raise HTTPException(400, "audio_ids 必须与 audios 等长")

    with tempfile.TemporaryDirectory(prefix="ff7emb_") as tmp_name:
        tmp = Path(tmp_name)
        items: list[dict[str, Any]] = []
        raw_samples = 0
        for index, encoded in enumerate(req.audios):
            source = _decode_audio(encoded, tmp / f"source-{index:04d}.audio")
            wav = _load_mono16k(source)
            raw_samples += wav.size(1)
            if raw_samples > 15 * 16000:
                raise HTTPException(400, "已选原音频总时长不能超过 15 秒，请减少素材")
            if req.trim_silence:
                wav = _trim_edges(wav)
            if wav.size(1) < 1600:
                raise HTTPException(400, f"素材过短：{req.audio_ids[index] if req.audio_ids else index}")
            items.append(
                {
                    "id": req.audio_ids[index] if req.audio_ids else str(index),
                    "ordinal": index + 1,
                    "duration_s": wav.size(1) / 16000,
                    "wav": wav,
                }
            )

        # New versions are one concatenation, capped at 15s (no hidden splitting).
        if sum(item["duration_s"] for item in items) > req.target_seconds + 1e-6:
            raise HTTPException(400, "音源总时长超过目标时长")
        segments = _split_long_items(items, req.target_seconds)
        batches = [segments]

        batch_paths = []
        for index, members in enumerate(batches):
            path = tmp / f"batch-{index + 1:03d}.wav"
            _write_batch(members, path, req.gap_seconds, req.target_seconds)
            batch_paths.append(path)

        manager = TTSManager.get_instance()
        with manager.get_lock():
            model = manager.get_infer()
            style, base_emo, similarities, medoid_index = _average_embeddings(model, batch_paths)

        wav_path = SPEAKER_DIR / f"{req.speaker}.wav"
        wav_path.write_bytes(batch_paths[medoid_index].read_bytes())
        manifest_batches = []
        for index, (members, path) in enumerate(zip(batches, batch_paths)):
            wav = _load_mono16k(path)
            batch_duration = wav.size(1) / 16000
            speech_duration = sum(member["duration_s"] for member in members)
            effective_gap = (
                max(0.0, batch_duration - speech_duration) / (len(members) - 1)
                if len(members) > 1
                else 0.0
            )
            manifest_batches.append(
                {
                    "batch_no": index + 1,
                    "duration_s": round(batch_duration, 4),
                    "gap_seconds": round(effective_gap, 4),
                    "source_ids": list(dict.fromkeys(member["id"] for member in members)),
                    "segment_ids": [member["segment_id"] for member in members],
                    "similarity": similarities[index],
                }
            )
        manifest = {
            "speaker": req.speaker,
            "target_seconds": req.target_seconds,
            "raw_source_duration_s": raw_samples / 16000,
            "max_total_seconds": 15,
            "source_audio": "concatenated selected clips, edges trimmed, gaps capped",
            "gap_seconds": req.gap_seconds,
            "trim_silence": req.trim_silence,
            "source_clips": [
                {
                    "id": item["id"],
                    "ordinal": item["ordinal"],
                    "duration_s": round(item["duration_s"], 4),
                }
                for item in items
            ],
            "segments": [
                {
                    "id": item["segment_id"],
                    "source_id": item["id"],
                    "segment_no": item["segment_no"],
                    "segment_count": item["segment_count"],
                    "duration_s": round(item["duration_s"], 4),
                }
                for item in segments
            ],
            "batches": manifest_batches,
            "medoid_index": medoid_index,
            "speaker_embedding": "normalized mean of per-batch CampPlus vectors",
            "base_emotion": "mean of per-batch IndexTTS emotion vectors",
        }
        pt_path = SPEAKER_DIR / f"{req.speaker}.pt"
        torch.save(
            {
                "style": None if style is None else style.cpu(),
                "base_emo": None if base_emo is None else base_emo.cpu(),
                "wav": str(wav_path),
                "n": len(items),
                "batch_count": len(batch_paths),
                "medoid_index": medoid_index,
                "similarities": similarities,
                "manifest": manifest,
            },
            pt_path,
        )
        return EmbedResponse(
            success=True,
            speaker=req.speaker,
            n_clips=len(items),
            batch_count=len(batch_paths),
            wav_path=str(wav_path),
            medoid_index=medoid_index,
            similarities=similarities,
            manifest=manifest,
            embedding_pt_b64=base64.b64encode(pt_path.read_bytes()).decode("ascii"),
            reference_wav_b64=base64.b64encode(wav_path.read_bytes()).decode("ascii"),
            source_wav_b64=base64.b64encode(batch_paths[0].read_bytes()).decode("ascii"),
        )


@router.post("/v1/speaker/register")
def register_speaker(req: RegisterSpeakerRequest):
    """Restore a studio-owned speaker artifact onto the active GPU node."""
    try:
        embedding_bytes = base64.b64decode(req.embedding_pt_b64, validate=True)
        reference_bytes = base64.b64decode(req.reference_wav_b64, validate=True)
    except ValueError as exc:
        raise HTTPException(400, "无效的 speaker base64") from exc

    with tempfile.TemporaryDirectory(prefix="ff7speaker_") as tmp_name:
        tmp = Path(tmp_name)
        source_pt = tmp / "speaker.pt"
        source_wav = tmp / "reference.wav"
        source_pt.write_bytes(embedding_bytes)
        source_wav.write_bytes(reference_bytes)
        try:
            blob = torch.load(source_pt, map_location="cpu", weights_only=True)
        except Exception as exc:
            raise HTTPException(400, "无效的 speaker embedding") from exc
        if not isinstance(blob, dict):
            raise HTTPException(400, "speaker embedding 必须是字典")
        style = blob.get("style")
        base_emo = blob.get("base_emo")
        if not isinstance(style, torch.Tensor) or not isinstance(base_emo, torch.Tensor):
            raise HTTPException(400, "speaker embedding 缺少 style/base_emo")
        try:
            _load_mono16k(source_wav)
        except Exception as exc:
            raise HTTPException(400, "无效的 speaker reference wav") from exc

        target_pt = SPEAKER_DIR / f"{req.speaker}.pt"
        target_wav = SPEAKER_DIR / f"{req.speaker}.wav"
        torch.save({"style": style.float().cpu(), "base_emo": base_emo.float().cpu()}, target_pt)
        target_wav.write_bytes(reference_bytes)
    return {"success": True, "speaker": req.speaker}


class CompareRequest(BaseModel):
    audio: str = Field(..., description="待比对音频：路径 / data URL / base64")
    embedding_pt_b64: str = Field(..., description="参照 speaker.pt")


def _style_from_pt_bytes(raw: bytes) -> torch.Tensor:
    blob = torch.load(io.BytesIO(raw), map_location="cpu", weights_only=False)
    if not isinstance(blob, dict) or not isinstance(blob.get("style"), torch.Tensor):
        raise HTTPException(400, "speaker.pt 缺少 style")
    return F.normalize(blob["style"].float().reshape(1, -1), p=2, dim=-1)


def _campplus_style(model, wav: torch.Tensor) -> torch.Tensor:
    feat = torchaudio.compliance.kaldi.fbank(
        wav.to(model.device), num_mel_bins=80, dither=0, sample_frequency=16000
    )
    feat = feat - feat.mean(dim=0, keepdim=True)
    with torch.no_grad(), torch.amp.autocast(
        torch.device(model.device).type,
        enabled=getattr(model, "dtype", None) is not None,
        dtype=getattr(model, "dtype", None),
    ):
        style = model.campplus_model(feat.unsqueeze(0))
    return F.normalize(style.float(), p=2, dim=-1)


@router.post("/v1/speaker/compare")
def compare_speaker(req: CompareRequest):
    try:
        ref = _style_from_pt_bytes(base64.b64decode(req.embedding_pt_b64, validate=True))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f"无效 embedding: {exc}") from exc
    with tempfile.TemporaryDirectory(prefix="ff7cmp_") as tmp_name:
        path = _decode_audio(req.audio, Path(tmp_name) / "clip.audio")
        wav = _trim_edges(_load_mono16k(path))
        if wav.size(1) < 1600:
            raise HTTPException(400, "音频过短")
        manager = TTSManager.get_instance()
        with manager.get_lock():
            model = manager.get_infer()
            query = _campplus_style(model, wav)
    score = float(F.cosine_similarity(query.cpu(), ref, dim=-1).item())
    return {"success": True, "cosine": round(score, 6)}


@router.post("/v1/tts")
def synth(req: SynthRequest):
    wav_path = SPEAKER_DIR / f"{req.speaker}.wav"
    if not wav_path.exists():
        raise HTTPException(400, f"先调用 /v1/speaker/embed，缺少 {wav_path}")
    manager = TTSManager.get_instance()
    model = manager.get_infer()
    pt_path = SPEAKER_DIR / f"{req.speaker}.pt"
    speaker_style = None
    base_emo = None
    if pt_path.exists():
        blob = torch.load(pt_path, map_location="cpu")
        style = blob.get("style")
        if style is not None:
            speaker_style = style.to(model.device)
        emotion = blob.get("base_emo")
        if emotion is not None:
            base_emo = emotion.to(model.device)

    operations = _parse_pause_script(req.text)
    pause_count = sum(kind == "pause" for kind, _ in operations)
    spoken_text = PAUSE_PATTERN.sub("", req.text).strip()

    with tempfile.TemporaryDirectory(prefix="ff7tts_") as tmp_name:
        tmp = Path(tmp_name)
        emo_path = None
        if req.emo_audio:
            emo_path = str(_decode_audio(req.emo_audio, tmp / "emotion.audio"))
        out = tmp / f"{uuid.uuid4().hex}.wav"
        common_kwargs = dict(
            spk_audio_prompt=str(wav_path),
            lang=req.lang,
            duration_factor=float(req.duration_factor),
            use_random=False,
            text_normalization=True,
            verbose=False,
        )
        if speaker_style is not None:
            common_kwargs["_speaker_style"] = speaker_style
        if base_emo is not None:
            common_kwargs["_base_emo_vector"] = base_emo
        if emo_path:
            common_kwargs["emo_audio_prompt"] = emo_path
            common_kwargs["emo_alpha"] = float(req.emo_alpha)
        with manager.get_lock():
            if pause_count == 0:
                model.infer(text=spoken_text, output_path=str(out), **common_kwargs)
            else:
                generated: list[tuple[str, torch.Tensor | int, int | None]] = []
                expected_sr = None
                expected_channels = None
                segment_no = 0
                for kind, value in operations:
                    if kind == "pause":
                        generated.append((kind, int(value), None))
                        continue
                    segment_no += 1
                    segment_path = tmp / f"segment-{segment_no:03d}.wav"
                    model.infer(text=str(value), output_path=str(segment_path), **common_kwargs)
                    try:
                        wav, sample_rate = torchaudio.load(str(segment_path))
                    except (ImportError, OSError):
                        import soundfile as sf

                        samples, sample_rate = sf.read(
                            str(segment_path), always_2d=True, dtype="float32"
                        )
                        wav = torch.from_numpy(samples.T.copy())
                    if expected_sr is None:
                        expected_sr = sample_rate
                        expected_channels = wav.size(0)
                    elif sample_rate != expected_sr or wav.size(0) != expected_channels:
                        raise HTTPException(500, "TTS 分段音频格式不一致")
                    generated.append((kind, wav.cpu(), sample_rate))

                if expected_sr is None or expected_channels is None:
                    raise HTTPException(500, "TTS 没有生成音频")
                parts = []
                for kind, value, _sample_rate in generated:
                    if kind == "pause":
                        frames = round(expected_sr * int(value) / 1000)
                        parts.append(torch.zeros(expected_channels, frames))
                    else:
                        parts.append(value)
                combined = torch.cat(parts, dim=1)
                try:
                    torchaudio.save(str(out), combined, expected_sr)
                except (ImportError, OSError):
                    import soundfile as sf

                    sf.write(
                        str(out), combined.squeeze(0).numpy(), expected_sr, subtype="PCM_16"
                    )
        audio = out.read_bytes()
    return {
        "success": True,
        "audio_wav_b64": base64.b64encode(audio).decode("ascii"),
        "speaker": req.speaker,
        "bytes": len(audio),
        "spoken_text": spoken_text,
        "pause_count": pause_count,
    }
