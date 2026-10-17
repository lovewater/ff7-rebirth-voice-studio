import os
from pathlib import Path

def patch(path: Path, replacements: list[tuple[str, str]]) -> None:
    source = path.read_text()
    for old, new in replacements:
        if old not in source:
            if new in source:
                continue
            raise RuntimeError(f"{path} missing patch target: {old[:80]!r}")
        count = source.count(old)
        if count != 1:
            raise RuntimeError(f"{path} expected one patch target, found {count}: {old[:80]!r}")
        source = source.replace(old, new, 1)
    path.write_text(source)


SPEAKER_START = (
    '        print(">> starting inference...")\n        self._set_gr_progress(0, "starting inference...")',
    '''        print(">> starting inference...")
        # Optional robust speaker conditioning built by the FF7 API from
        # multiple <=15 second batches. The medoid WAV remains the official
        # semantic and mel prompt.
        external_speaker_style = generation_kwargs.pop("_speaker_style", None)
        external_base_emo = generation_kwargs.pop("_base_emo_vector", None)
        external_emo_supplied = emo_audio_prompt is not None
        duration_factor = float(generation_kwargs.pop("duration_factor", 1.0) or 1.0)
        generation_kwargs.pop("lang", None)
        generation_kwargs.pop("text_normalization", None)
        self._set_gr_progress(0, "starting inference...")''',
)

STYLE_INJECT = (
    '''            ref_mel = self.cache_mel

        if emo_vector is not None:''',
    '''            ref_mel = self.cache_mel

        if external_speaker_style is not None:
            style = external_speaker_style.to(device=self.device, dtype=style.dtype)

        if emo_vector is not None:''',
)

EMOVEC = (
    '''                    emovec = self.gpt.merge_emovec(
                        spk_cond_emb,
                        emo_cond_emb,
                        torch.tensor([spk_cond_emb.shape[-1]], device=text_tokens.device),
                        torch.tensor([emo_cond_emb.shape[-1]], device=text_tokens.device),
                        alpha=emo_alpha
                    )''',
    '''                    if external_base_emo is None:
                        emovec = self.gpt.merge_emovec(
                            spk_cond_emb,
                            emo_cond_emb,
                            torch.tensor([spk_cond_emb.shape[-1]], device=text_tokens.device),
                            torch.tensor([emo_cond_emb.shape[-1]], device=text_tokens.device),
                            alpha=emo_alpha
                        )
                    else:
                        base_emovec = external_base_emo.to(
                            device=text_tokens.device,
                            dtype=spk_cond_emb.dtype,
                        )
                        if external_emo_supplied:
                            target_emovec = self.gpt.get_emovec(
                                emo_cond_emb,
                                torch.tensor([emo_cond_emb.shape[-1]], device=text_tokens.device),
                            )
                            emovec = base_emovec + emo_alpha * (target_emovec - base_emovec)
                        else:
                            emovec = base_emovec''',
)

DURATION = (
    "                    target_lengths = (code_lens * 1.72).long()",
    "                    target_lengths = (code_lens * 1.72 * duration_factor).long()",
)

v2 = Path(os.environ.get("INDEX_TTS_ROOT", "/opt/index-tts")) / "indextts" / "infer_v2.py"
if not v2.exists():
    raise SystemExit(f"missing {v2}")
patch(v2, [SPEAKER_START, STYLE_INJECT, EMOVEC, DURATION])
