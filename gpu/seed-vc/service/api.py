"""GPU-resident Seed-VC HTTP service. Models stay loaded; GPU lock serializes vs IndexTTS."""
import base64
import fcntl
import hashlib
import json
import os
import sys
import time
from pathlib import Path
import tempfile
import threading

import soundfile as sf
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parent))
import convert as seed_convert

app = FastAPI(title="FF7 Seed-VC timbre repair")
queue = threading.Lock()
LOCK = Path(os.getenv("GPU_LOCK_PATH", "/gpu-lock/inference.lock"))
LOCK.parent.mkdir(parents=True, exist_ok=True)
BUNDLE = {"args": None, "models": None, "load_s": None}


class ConvertRequest(BaseModel):
    source_wav_b64: str
    jp_audio_b64: str = ""
    embedding_reference_b64: str = ""
    reference_wav_b64: str = ""
    embedding_reference_lang: str = Field("cn", pattern=r"^(jp|cn|en)$")
    original_lang: str = Field("jp", pattern=r"^(jp|cn|en)$")
    reference_mode: str = Field("auto", pattern=r"^(auto|original|native)$")
    silences: list[tuple[int, int]] = Field(default_factory=list)


def decode(payload, dest):
    try:
        data = base64.b64decode(payload, validate=True)
        if not data or len(data) > 64 * 1024 * 1024:
            raise ValueError("audio size")
        dest.write_bytes(data)
        info = sf.info(dest)
        if info.duration <= 0 or info.duration > 300:
            raise ValueError("audio duration")
        return data, info
    except Exception as exc:
        raise HTTPException(400, "无效音频或时长超过 300 秒") from exc


@app.on_event("startup")
def startup():
    args, models, load_s = seed_convert.load_bundle()
    BUNDLE["args"] = args
    BUNDLE["models"] = models
    BUNDLE["load_s"] = load_s


@app.get("/health")
def health():
    return {
        "status": "healthy" if BUNDLE["models"] is not None else "loading",
        "model": "Seed-VC v2 CFM timbre-only",
        "convert_style": False,
        "reference_threshold_s": 1.5,
        "mode": "gpu-resident",
        "load_s": BUNDLE["load_s"],
    }


@app.post("/v1/convert")
def convert(req: ConvertRequest):
    if BUNDLE["models"] is None:
        raise HTTPException(503, "Seed-VC 模型还在加载")
    with tempfile.TemporaryDirectory(prefix="ff7vc_") as tmp:
        root = Path(tmp)
        source, info = decode(req.source_wav_b64, root / "source.wav")
        if req.reference_wav_b64:
            reference, ref_info = decode(req.reference_wav_b64, root / "reference.audio")
            use_embedding = False
            jp_info = fallback_info = ref_info
        else:
            if not req.jp_audio_b64 or not req.embedding_reference_b64:
                raise HTTPException(400, "缺少音色参考")
            jp, jp_info = decode(req.jp_audio_b64, root / "jp.audio")
            fallback, fallback_info = decode(req.embedding_reference_b64, root / "embedding.audio")
            if req.reference_mode == "native":
                use_embedding = True
            elif req.reference_mode == "original":
                use_embedding = False
            else:
                use_embedding = jp_info.duration < 1.5
            reference = fallback if use_embedding else jp
            (root / "reference.audio").write_bytes(reference)
        last = 0
        for start, end in req.silences:
            if start < last or start < 0 or end <= start or end > info.frames:
                raise HTTPException(400, "停顿区间无效")
            last = end
        (root / "request.json").write_text(json.dumps({"silences": req.silences}))
        t0 = time.perf_counter()
        with queue, LOCK.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                seed_convert.convert_job(root, BUNDLE["args"], BUNDLE["models"])
            except Exception as exc:
                raise HTTPException(500, "Seed-VC 音色修复失败：" + str(exc)[-1200:]) from exc
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
        wall_s = time.perf_counter() - t0
        output = (root / "repaired.wav").read_bytes()
        meta = json.loads((root / "result.json").read_text())
        meta.update(
            reference_kind="embedding_source" if use_embedding else "line_original",
            reference_lang=req.embedding_reference_lang if use_embedding else req.original_lang,
            reference_mode=req.reference_mode,
            original_lang=req.original_lang,
            jp_duration_s=jp_info.duration,
            reference_duration_s=fallback_info.duration if use_embedding else jp_info.duration,
            reference_threshold_s=1.5,
            source_sha256=hashlib.sha256(source).hexdigest(),
            reference_sha256=hashlib.sha256(reference).hexdigest(),
            output_sha256=hashlib.sha256(output).hexdigest(),
            wall_s=round(wall_s, 3),
            mode="gpu-resident",
        )
        return {"audio_wav_b64": base64.b64encode(output).decode("ascii"), "conversion_meta": meta}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8811)
