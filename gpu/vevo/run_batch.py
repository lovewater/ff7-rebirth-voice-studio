"""Official Vevo-Timbre pipeline; one model load for all comparison jobs."""
import json, hashlib
from pathlib import Path
import torch
import soundfile as sf
from huggingface_hub import snapshot_download
from models.vc.vevo.vevo_utils import VevoInferencePipeline

root = Path('/data')
local = snapshot_download('amphion/Vevo', revision='7edf4640c400c20542aa39c45b63f60e6c7baba0', cache_dir='/checkpoints/hf', allow_patterns=['tokenizer/vq8192/*', 'acoustic_modeling/Vq8192ToMels/*', 'acoustic_modeling/Vocoder/*'], max_workers=8)
pipeline = VevoInferencePipeline(
    content_style_tokenizer_ckpt_path=f'{local}/tokenizer/vq8192',
    fmt_cfg_path='./models/vc/vevo/config/Vq8192ToMels.json',
    fmt_ckpt_path=f'{local}/acoustic_modeling/Vq8192ToMels',
    vocoder_cfg_path='./models/vc/vevo/config/Vocoder.json',
    vocoder_ckpt_path=f'{local}/acoustic_modeling/Vocoder', device=torch.device('cuda'))
for job in json.loads((root/'jobs.json').read_text()):
    torch.manual_seed(20260921)
    source, ref = root/job['source'], root/job['reference']
    output = root/'output'/f"{job['source_id']}-jp"
    output.mkdir(parents=True, exist_ok=True)
    with torch.inference_mode():
        wav = pipeline.inference_fm(src_wav_path=str(source), timbre_ref_wav_path=str(ref), flow_matching_steps=32)
        # Same -25 dB RMS normalization as upstream save_audio; PCM16 for our importer.
        rms = torch.sqrt(torch.mean(wav**2))
        wav = wav * (10 ** ((-25 - 20 * torch.log10(rms + 1e-9)) / 20))
    sf.write(output/'vevo.wav', wav.squeeze().cpu().numpy(), 24000, subtype='PCM_16')
    meta = dict(job, source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(), reference_sha256=hashlib.sha256(ref.read_bytes()).hexdigest(), output='vevo.wav', model='Vevo-Timbre', weights_revision=Path(local).name, model_revision='amphion/Vevo/Vq8192ToMels', engine_url='docker-compose://ff7-vevo', flow_matching_steps=32, seed=20260921, precision='FP32', device=torch.cuda.get_device_name(), torch_version=torch.__version__)
    (output/'manifest.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    print('DONE', job['source_id'], flush=True)
