"""Seed-VC conversion. Default is V2 timbre-only (convert_style=false). V1 kept for rollback."""
import json
import os
import random
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import soundfile as sf
import torch
from modules.bigvgan.bigvgan import BigVGAN

# True: V2 CFM timbre-only. False: previous V1 whisper-small path.
USE_V2 = True

SOURCE_REVISION = "51383efd921027683c89e5348211d93ff12ac2a8"


def _seed_rng() -> None:
    random.seed(20260921)
    np.random.seed(20260921)
    torch.manual_seed(20260921)
    torch.cuda.manual_seed_all(20260921)


def _split_ranges(source_len: int, silences: list) -> list[tuple[str, int, int]]:
    ranges = []
    cursor = 0
    for start, end in silences:
        if cursor < start:
            ranges.append(("speech", cursor, start))
        ranges.append(("silence", start, end))
        cursor = end
    if cursor < source_len:
        ranges.append(("speech", cursor, source_len))
    return ranges


def load_bundle_v1():
    import inference

    args = SimpleNamespace(
        checkpoint=None,
        config=None,
        f0_condition=False,
        fp16=False,
        auto_f0_adjust=False,
        semi_tone_shift=0,
        diffusion_steps=50,
        length_adjust=1.0,
        inference_cfg_rate=0.7,
    )
    original_download = inference.load_custom_model_from_hf

    def download(repo_id, model_filename="pytorch_model.bin", config_filename=None):
        if repo_id == "funasr/campplus":
            return "/existing-models/campplus_cn_common.bin"
        return original_download(repo_id, model_filename, config_filename)

    inference.load_custom_model_from_hf = download
    original_vocoder = BigVGAN.from_pretrained

    def local_v1_vocoder(*args, **kwargs):
        kwargs.pop("pretrained_model_name_or_path", None)
        kwargs.pop("name", None)
        return original_vocoder("/existing-models/bigvgan", **kwargs)

    BigVGAN.from_pretrained = local_v1_vocoder
    t0 = time.perf_counter()
    models = inference.load_models(args)
    inference.load_models = lambda _: models
    load_s = time.perf_counter() - t0
    print(f"seed-vc v1 loaded in {load_s:.2f}s on {torch.cuda.get_device_name(0)}", flush=True)
    return args, models, load_s


def convert_job_v1(root: Path, args, models=None) -> None:
    import inference

    root = Path(root)
    if models is not None:
        inference.load_models = lambda _: models
    _seed_rng()
    source, rate = sf.read(root / "source.wav", dtype="float32", always_2d=True)
    source = source.mean(axis=1)
    silences = json.loads((root / "request.json").read_text())["silences"]
    parts = []
    output_rate = 22050
    t0 = time.perf_counter()
    for index, (kind, start, end) in enumerate(_split_ranges(len(source), silences)):
        if kind == "silence":
            parts.append(np.zeros(round((end - start) * output_rate / rate), dtype=np.float32))
            continue
        segment = root / f"segment-{index}.wav"
        sf.write(segment, source[start:end], rate, subtype="PCM_16")
        out = root / f"output-{index}"
        out.mkdir()
        args.source, args.target, args.output = str(segment), str(root / "reference.audio"), str(out)
        inference.main(args)
        waves = list(out.glob("*.wav"))
        if len(waves) != 1:
            raise RuntimeError("Expected one Seed-VC output")
        samples, sr = sf.read(waves[0], dtype="float32")
        if sr != output_rate or samples.ndim != 1 or not len(samples) or not np.isfinite(samples).all():
            raise RuntimeError("Invalid Seed-VC output")
        parts.append(samples)
    if not parts:
        raise RuntimeError("No speech generated")
    output = np.concatenate(parts)
    if np.max(np.abs(output)) < 1e-7:
        raise RuntimeError("Silent Seed-VC output")
    infer_s = time.perf_counter() - t0
    sf.write(root / "repaired.wav", output, output_rate, subtype="PCM_16")
    (root / "result.json").write_text(
        json.dumps(
            {
                "model": "Seed-VC v1 offline / whisper-small / BigVGAN",
                "source_revision": SOURCE_REVISION,
                "model_revision": "Plachta/Seed-VC/DiT_seed_v2_uvit_whisper_small_wavenet_bigvgan_pruned.pth",
                "precision": "FP32 CFM/vocoder/CampPlus; FP16 Whisper (upstream)",
                "device": torch.cuda.get_device_name(0),
                "torch_version": torch.__version__,
                "diffusion_steps": 50,
                "inference_cfg_rate": 0.7,
                "length_adjust": 1.0,
                "f0_condition": False,
                "convert_style": None,
                "seed": 20260921,
                "explicit_pause_count": len(silences),
                "explicit_pause_seconds": sum((b - a) / rate for a, b in silences),
                "infer_s": round(infer_s, 3),
            }
        )
    )


def load_bundle_v2():
    import yaml
    from hydra.utils import instantiate
    from omegaconf import DictConfig
    import hf_utils
    from modules.v2.vc_wrapper import VoiceConversionWrapper
    import modules.v2.vc_wrapper as vc_wrapper_mod

    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    original_hf = hf_utils.load_custom_model_from_hf
    local_weights = {
        ("funasr/campplus", "campplus_cn_common.bin"): Path("/existing-models/campplus_cn_common.bin"),
        ("Plachta/Seed-VC", "v2/cfm_small.pth"): Path("/opt/seed-vc/weights/v2/cfm_small.pth"),
        ("Plachta/Seed-VC", "v2/ar_base.pth"): Path("/opt/seed-vc/weights/v2/ar_base.pth"),
        ("Plachta/ASTRAL-quantization", "bsq32/bsq32_light.pth"): Path(
            "/opt/seed-vc/weights/astral/bsq32_light.pth"
        ),
        ("Plachta/ASTRAL-quantization", "bsq2048/bsq2048_light.pth"): Path(
            "/opt/seed-vc/weights/astral/bsq2048_light.pth"
        ),
    }

    def download(repo_id, model_filename="pytorch_model.bin", config_filename=None):
        local = local_weights.get((repo_id, model_filename))
        if local is not None and local.is_file():
            print(f"local weight {repo_id}/{model_filename} -> {local}", flush=True)
            return str(local)
        print(f"hf-mirror download {repo_id}/{model_filename}", flush=True)
        return original_hf(repo_id, model_filename, config_filename)

    hf_utils.load_custom_model_from_hf = download
    vc_wrapper_mod.load_custom_model_from_hf = download

    args = SimpleNamespace(
        diffusion_steps=30,
        length_adjust=1.0,
        intelligibility_cfg_rate=0.7,
        similarity_cfg_rate=0.7,
        convert_style=False,
        anonymization_only=False,
        compile=False,
        ar_checkpoint_path=str(local_weights[("Plachta/Seed-VC", "v2/ar_base.pth")])
        if local_weights[("Plachta/Seed-VC", "v2/ar_base.pth")].is_file()
        else None,
        cfm_checkpoint_path=str(local_weights[("Plachta/Seed-VC", "v2/cfm_small.pth")])
        if local_weights[("Plachta/Seed-VC", "v2/cfm_small.pth")].is_file()
        else None,
        top_p=0.9,
        temperature=1.0,
        repetition_penalty=1.0,
    )
    os.chdir("/opt/seed-vc")
    vocoder_dir = Path("/existing-models/bigvgan")
    if not (vocoder_dir / "bigvgan_generator.pt").is_file():
        raise FileNotFoundError(f"local BigVGAN missing: {vocoder_dir}")
    # Hydra yaml calls from_pretrained(pretrained_model_name_or_path=...).
    # Do not patch BigVGAN.from_pretrained with a positional `name` lambda.
    cfg = DictConfig(yaml.safe_load(open("configs/v2/vc_wrapper.yaml", "r")))
    cfg.vocoder.pretrained_model_name_or_path = str(vocoder_dir)
    t0 = time.perf_counter()
    models = instantiate(cfg)
    models.load_checkpoints(
        ar_checkpoint_path=args.ar_checkpoint_path,
        cfm_checkpoint_path=args.cfm_checkpoint_path,
    )
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    models.to(device)
    models.eval()
    load_s = time.perf_counter() - t0
    print(
        f"seed-vc v2 timbre-only loaded in {load_s:.2f}s on {torch.cuda.get_device_name(0)} "
        f"wrapper={type(models).__name__} vocoder={vocoder_dir}",
        flush=True,
    )
    if not isinstance(models, VoiceConversionWrapper):
        print("warn: unexpected v2 wrapper type", type(models), flush=True)
    return args, models, load_s


def _unpack_v2_audio(value):
    if value is None:
        return None
    if isinstance(value, tuple) and len(value) == 2:
        # convert_voice_with_streaming yields (mp3_bytes, (sr, wave))
        # and _stream_wave_chunks stores full_audio as (sr, wave).
        if isinstance(value[0], int):
            value = value[1]
        else:
            value = value[1]
            if isinstance(value, tuple) and len(value) == 2 and isinstance(value[0], int):
                value = value[1]
    if torch.is_tensor(value):
        value = value.detach().float().cpu().numpy()
    wave = np.asarray(value, dtype=np.float32)
    wave = np.squeeze(wave)
    if wave.ndim != 1:
        wave = wave.reshape(-1)
    return wave


def _v2_wave(wrapper, source_path: str, target_path: str, args) -> np.ndarray:
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    # stream_output=False never yields; take the last streamed full_audio instead.
    stream = wrapper.convert_voice_with_streaming(
        source_audio_path=source_path,
        target_audio_path=target_path,
        diffusion_steps=args.diffusion_steps,
        length_adjust=args.length_adjust,
        intelligebility_cfg_rate=args.intelligibility_cfg_rate,
        similarity_cfg_rate=args.similarity_cfg_rate,
        top_p=args.top_p,
        temperature=args.temperature,
        repetition_penalty=args.repetition_penalty,
        convert_style=False,
        anonymization_only=False,
        device=device,
        dtype=torch.float32,
        stream_output=True,
    )
    wave = None
    for item in stream:
        audio = _unpack_v2_audio(item)
        if audio is not None and len(audio):
            wave = audio
    if wave is None or not len(wave) or not np.isfinite(wave).all():
        raise RuntimeError("Invalid Seed-VC v2 output")
    return wave


def convert_job_v2(root: Path, args, models=None) -> None:
    root = Path(root)
    if models is None:
        raise RuntimeError("Seed-VC v2 models not loaded")
    _seed_rng()
    source, rate = sf.read(root / "source.wav", dtype="float32", always_2d=True)
    source = source.mean(axis=1)
    silences = json.loads((root / "request.json").read_text())["silences"]
    parts = []
    output_rate = 22050
    t0 = time.perf_counter()
    for index, (kind, start, end) in enumerate(_split_ranges(len(source), silences)):
        if kind == "silence":
            parts.append(np.zeros(round((end - start) * output_rate / rate), dtype=np.float32))
            continue
        segment = root / f"segment-{index}.wav"
        sf.write(segment, source[start:end], rate, subtype="PCM_16")
        samples = _v2_wave(models, str(segment), str(root / "reference.audio"), args)
        parts.append(samples)
    if not parts:
        raise RuntimeError("No speech generated")
    output = np.concatenate(parts)
    peak = np.max(np.abs(output))
    if peak < 1e-7:
        raise RuntimeError("Silent Seed-VC output")
    infer_s = time.perf_counter() - t0
    sf.write(root / "repaired.wav", output, output_rate, subtype="PCM_16")
    (root / "result.json").write_text(
        json.dumps(
            {
                "model": "Seed-VC v2 CFM timbre-only",
                "source_revision": SOURCE_REVISION,
                "model_revision": "Plachta/Seed-VC/v2/cfm_small.pth",
                "precision": "FP32 CFM/vocoder; convert_style=false",
                "device": torch.cuda.get_device_name(0),
                "torch_version": torch.__version__,
                "diffusion_steps": args.diffusion_steps,
                "intelligibility_cfg_rate": args.intelligibility_cfg_rate,
                "similarity_cfg_rate": args.similarity_cfg_rate,
                "length_adjust": args.length_adjust,
                "convert_style": False,
                "seed": 20260921,
                "explicit_pause_count": len(silences),
                "explicit_pause_seconds": sum((b - a) / rate for a, b in silences),
                "infer_s": round(infer_s, 3),
            }
        )
    )


def load_bundle():
    return load_bundle_v2() if USE_V2 else load_bundle_v1()


def convert_job(root: Path, args, models=None) -> None:
    if USE_V2:
        convert_job_v2(root, args, models)
    else:
        convert_job_v1(root, args, models)


if __name__ == "__main__":
    loaded_args, loaded_models, _ = load_bundle()
    convert_job(Path(sys.argv[1]), loaded_args, loaded_models)
