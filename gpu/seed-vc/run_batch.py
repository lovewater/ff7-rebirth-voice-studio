"""Run reproducible timbre-only VC experiments using upstream offline inference."""
import json
import random
from pathlib import Path
from types import SimpleNamespace
import numpy as np
import torch
import inference

jobs = json.loads(Path('/data/jobs.json').read_text())
args = SimpleNamespace(checkpoint=None, config=None, f0_condition=False, fp16=False,
    auto_f0_adjust=False, semi_tone_shift=0, diffusion_steps=50,
    length_adjust=1.0, inference_cfg_rate=0.7)
# Reuse the identical local auxiliary checkpoints already downloaded for IndexTTS.
original_download = inference.load_custom_model_from_hf
def download(repo_id, model_filename='pytorch_model.bin', config_filename=None):
    if repo_id == 'funasr/campplus':
        return '/existing-models/campplus_cn_common.bin'
    return original_download(repo_id, model_filename, config_filename)
inference.load_custom_model_from_hf = download
from modules.bigvgan.bigvgan import BigVGAN
original_vocoder = BigVGAN.from_pretrained
BigVGAN.from_pretrained = lambda name, **kw: original_vocoder('/existing-models/bigvgan', **kw)
models = inference.load_models(args)
inference.load_models = lambda _: models
for job in jobs:
    out = Path('/data/output') / f'{job["source_id"]}-{job["reference_lang"]}'
    out.mkdir(parents=True, exist_ok=True)
    if (out/'manifest.json').exists():
        print('Already complete', out, flush=True)
        continue
    random.seed(20260921)
    np.random.seed(20260921)
    torch.manual_seed(20260921)
    torch.cuda.manual_seed_all(20260921)
    args.source = '/data/' + job['source']
    args.target = '/data/' + job['reference']
    args.output = str(out)
    print('Converting', job['source_id'], job['reference_lang'], flush=True)
    inference.main(args)
    waves = list(out.glob('*.wav'))
    assert len(waves) == 1, waves
    manifest = dict(job, output=waves[0].name, diffusion_steps=50,
        length_adjust=1.0, inference_cfg_rate=0.7, f0_condition=False,
        seed=20260921, model='Seed-VC v1 offline / whisper-small / BigVGAN',
        precision='FP32 CFM/vocoder/CampPlus; FP16 Whisper (upstream)',
        device=torch.cuda.get_device_name(0), torch_version=torch.__version__)
    (out/'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
    print('Completed', out, flush=True)
