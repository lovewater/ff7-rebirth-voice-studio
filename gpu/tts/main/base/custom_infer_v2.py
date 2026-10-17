
import threading
import time
import warnings
import random

from base.path_utils import ensure_project_paths

ensure_project_paths()

from indextts.infer_v2 import IndexTTS2, find_most_similar_cosine

import librosa
import torch
import torchaudio

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=UserWarning)

import os
os.environ['ACCELERATE_USE_CPU'] = 'false'
os.environ['ACCELERATE_LOW_CPU_MEM_USAGE'] = 'false'
os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'

class CustomIndexTTS2(IndexTTS2):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # 在这里添加自定义初始化逻辑
        self._locker = threading.Lock()
        self.max_text_tokens_per_segment = 80
        print("CustomIndexTTS2 initialized!")

    def perpare(self, spk_audio_prompt,
                emo_audio_prompt=None, emo_alpha=1.0,
                emo_vector=None, emo_text=None, use_random=False,):
        print(">> 开始准备...")
        time_start = time.perf_counter()
        with self._locker:
            wait_time = time.perf_counter() - time_start
            start_time = time.perf_counter()

            if emo_vector is not None:
                # we have emotion vectors; they can't be blended via alpha mixing
                # in the main inference process later, so we must pre-calculate
                # their new strengths here based on the alpha instead!
                emo_vector_scale = max(0.0, min(1.0, emo_alpha))
                if emo_vector_scale != 1.0:
                    # scale each vector and truncate to 4 decimals (for nicer printing)
                    emo_vector = [int(x * emo_vector_scale * 10000) / 10000 for x in emo_vector]
                    print(f"scaled emotion vectors to {emo_vector_scale}x: {emo_vector}")
            else:
                if emo_text is None:
                    emo_text = spk_audio_prompt  # use main text prompt

                emo_dict = self.qwen_emo.inference(emo_text)
                print(f"detected emotion vectors from text: {emo_dict}")
                # convert ordered dict to list of vectors; the order is VERY important!
                emo_vector = list(emo_dict.values())

            if emo_audio_prompt is None:
                # we are not using any external "emotion reference voice"; use
                # speaker's voice as the main emotion reference audio.
                emo_audio_prompt = spk_audio_prompt
                # must always use alpha=1.0 when we don't have an external reference voice
                emo_alpha = 1.0

            # 如果参考音频改变了，才需要重新生成, 提升速度
            if self.cache_spk_cond is None or self.cache_spk_audio_prompt != spk_audio_prompt:
                if self.cache_spk_cond is not None:
                    self.cache_spk_cond = None
                    self.cache_s2mel_style = None
                    self.cache_s2mel_prompt = None
                    self.cache_mel = None
                    torch.cuda.empty_cache()
                audio,sr = self._load_and_cut_audio(spk_audio_prompt,15,False)
                audio_22k = torchaudio.transforms.Resample(sr, 22050)(audio)
                audio_16k = torchaudio.transforms.Resample(sr, 16000)(audio)

                inputs = self.extract_features(audio_16k, sampling_rate=16000, return_tensors="pt")
                input_features = inputs["input_features"]
                attention_mask = inputs["attention_mask"]
                input_features = input_features.to(self.device)
                attention_mask = attention_mask.to(self.device)
                spk_cond_emb = self.get_emb(input_features, attention_mask)

                _, S_ref = self.semantic_codec.quantize(spk_cond_emb)
                ref_mel = self.mel_fn(audio_22k.to(spk_cond_emb.device).float())
                ref_target_lengths = torch.LongTensor([ref_mel.size(2)]).to(ref_mel.device)
                feat = torchaudio.compliance.kaldi.fbank(audio_16k.to(ref_mel.device),
                                                        num_mel_bins=80,
                                                        dither=0,
                                                        sample_frequency=16000)
                feat = feat - feat.mean(dim=0, keepdim=True)  # feat2另外一个滤波器能量组特征[922, 80]
                style = self.campplus_model(feat.unsqueeze(0))  # 参考音频的全局style2[1,192]

                prompt_condition = self.s2mel.models['length_regulator'](S_ref,
                                                                        ylens=ref_target_lengths,
                                                                        n_quantizers=3,
                                                                        f0=None)[0]

                self.cache_spk_cond = spk_cond_emb
                self.cache_s2mel_style = style
                self.cache_s2mel_prompt = prompt_condition
                self.cache_spk_audio_prompt = spk_audio_prompt
                self.cache_mel = ref_mel
            else:
                style = self.cache_s2mel_style
                prompt_condition = self.cache_s2mel_prompt
                spk_cond_emb = self.cache_spk_cond
                ref_mel = self.cache_mel
            weight_vector = None
            emovec_mat = None
            if emo_vector is not None:
                weight_vector = torch.tensor(emo_vector, device=self.device)
                if use_random:
                    random_index = [random.randint(0, x - 1) for x in self.emo_num]
                else:
                    random_index = [find_most_similar_cosine(style, tmp) for tmp in self.spk_matrix]

                emo_matrix = [tmp[index].unsqueeze(0) for index, tmp in zip(random_index, self.emo_matrix)]
                emo_matrix = torch.cat(emo_matrix, 0)
                emovec_mat = weight_vector.unsqueeze(1) * emo_matrix
                emovec_mat = torch.sum(emovec_mat, 0)
                emovec_mat = emovec_mat.unsqueeze(0)

            if self.cache_emo_cond is None or self.cache_emo_audio_prompt != emo_audio_prompt:
                if self.cache_emo_cond is not None:
                    self.cache_emo_cond = None
                    torch.cuda.empty_cache()
                emo_audio, _ = self._load_and_cut_audio(emo_audio_prompt,15,False,sr=16000)
                emo_inputs = self.extract_features(emo_audio, sampling_rate=16000, return_tensors="pt")
                emo_input_features = emo_inputs["input_features"]
                emo_attention_mask = emo_inputs["attention_mask"]
                emo_input_features = emo_input_features.to(self.device)
                emo_attention_mask = emo_attention_mask.to(self.device)
                emo_cond_emb = self.get_emb(emo_input_features, emo_attention_mask)

                self.cache_emo_cond = emo_cond_emb
                self.cache_emo_audio_prompt = emo_audio_prompt
            else:
                emo_cond_emb = self.cache_emo_cond

            print(f'>> 准备输入信息用时: {(time.perf_counter() - start_time):.2f}')
            return wait_time,[spk_cond_emb,emo_cond_emb,emo_alpha,emo_vector,weight_vector,emovec_mat,ref_mel,style,prompt_condition]

    def generatesegments(self,text,max_text_tokens_per_segment = -1):
        text_tokens_list = self.tokenizer.tokenize(text)
        if max_text_tokens_per_segment > 60:
            self.max_text_tokens_per_segment = max_text_tokens_per_segment
        return self.tokenizer.split_segments(text_tokens_list, self.max_text_tokens_per_segment)

    def forward(self,
                sent,
                spk_cond_emb,
                emo_cond_emb,
                emo_alpha,
                emo_vector,
                weight_vector,
                emovec_mat,
                ref_mel,
                style,
                prompt_condition,
                **generation_kwargs):
        time_start = time.perf_counter()
        with self._locker:
            wait_time = time.perf_counter() - time_start
            top_p = generation_kwargs.pop("top_p", 0.8)
            top_k = generation_kwargs.pop("top_k", 30)
            temperature = generation_kwargs.pop("temperature", 0.8)
            autoregressive_batch_size = 1
            length_penalty = generation_kwargs.pop("length_penalty", 0.0)
            num_beams = generation_kwargs.pop("num_beams", 3)
            repetition_penalty = generation_kwargs.pop("repetition_penalty", 10.0)
            max_mel_tokens = generation_kwargs.pop("max_mel_tokens", 1500)

            #self._set_gr_progress(0.2 + 0.7 * seg_idx / segments_count,
            #                        f"speech synthesis {seg_idx + 1}/{segments_count}...")

            text_tokens = self.tokenizer.convert_tokens_to_ids(sent)
            text_tokens = torch.tensor(text_tokens, dtype=torch.int32, device=self.device).unsqueeze(0)
            m_start_time = time.perf_counter()
            gpt_gen_time = 0
            gpt_forward_time = 0
            s2mel_time = 0
            bigvgan_time = 0
            has_warned = False
            seg_nograd_start_time = time.perf_counter()
            with torch.no_grad():
                with torch.amp.autocast(text_tokens.device.type, enabled=self.dtype is not None, dtype=self.dtype):
                    emovec = self.gpt.merge_emovec(
                        spk_cond_emb,
                        emo_cond_emb,
                        torch.tensor([spk_cond_emb.shape[-1]], device=text_tokens.device),
                        torch.tensor([emo_cond_emb.shape[-1]], device=text_tokens.device),
                        alpha=emo_alpha
                    )

                    if emo_vector is not None:
                        emovec = emovec_mat + (1 - torch.sum(weight_vector)) * emovec
                        # emovec = emovec_mat

                    codes, speech_conditioning_latent = self.gpt.inference_speech(
                        spk_cond_emb,
                        text_tokens,
                        emo_cond_emb,
                        cond_lengths=torch.tensor([spk_cond_emb.shape[-1]], device=text_tokens.device),
                        emo_cond_lengths=torch.tensor([emo_cond_emb.shape[-1]], device=text_tokens.device),
                        emo_vec=emovec,
                        do_sample=True,
                        top_p=top_p,
                        top_k=top_k,
                        temperature=temperature,
                        num_return_sequences=autoregressive_batch_size,
                        length_penalty=length_penalty,
                        num_beams=num_beams,
                        repetition_penalty=repetition_penalty,
                        max_generate_length=max_mel_tokens,
                        **generation_kwargs
                    )

                gpt_gen_time += time.perf_counter() - m_start_time
                if not has_warned and (codes[:, -1] != self.stop_mel_token).any():
                    warnings.warn(
                        f"WARN: generation stopped due to exceeding `max_mel_tokens` ({max_mel_tokens}). "
                        f"Input text tokens: {text_tokens.shape[1]}. "
                        f"Consider reducing `max_text_tokens_per_segment`({self.max_text_tokens_per_segment}) or increasing `max_mel_tokens`.",
                        category=RuntimeWarning
                    )
                    has_warned = True

                code_lens = torch.tensor([codes.shape[-1]], device=codes.device, dtype=codes.dtype)
                #                 if verbose:
                #                     print(codes, type(codes))
                #                     print(f"codes shape: {codes.shape}, codes type: {codes.dtype}")
                #                     print(f"code len: {code_lens}")

                code_lens = []
                max_code_len = 0
                for code in codes:
                    if self.stop_mel_token not in code:
                        code_len = len(code)
                    else:
                        len_ = (code == self.stop_mel_token).nonzero(as_tuple=False)[0]
                        code_len = len_[0].item() if len_.numel() > 0 else len(code)
                    code_lens.append(code_len)
                    max_code_len = max(max_code_len, code_len)
                codes = codes[:, :max_code_len]
                code_lens = torch.LongTensor(code_lens)
                code_lens = code_lens.to(self.device)
                #if verbose:
                #    print(codes, type(codes))
                #    print(f"fix codes shape: {codes.shape}, codes type: {codes.dtype}")
                #    print(f"code len: {code_lens}")

                m_start_time = time.perf_counter()
                use_speed = torch.zeros(spk_cond_emb.size(0)).to(spk_cond_emb.device).long()
                with torch.amp.autocast(text_tokens.device.type, enabled=self.dtype is not None, dtype=self.dtype):
                    latent = self.gpt(
                        speech_conditioning_latent,
                        text_tokens,
                        torch.tensor([text_tokens.shape[-1]], device=text_tokens.device),
                        codes,
                        torch.tensor([codes.shape[-1]], device=text_tokens.device),
                        emo_cond_emb,
                        cond_mel_lengths=torch.tensor([spk_cond_emb.shape[-1]], device=text_tokens.device),
                        emo_cond_mel_lengths=torch.tensor([emo_cond_emb.shape[-1]], device=text_tokens.device),
                        emo_vec=emovec,
                        use_speed=use_speed,
                    )
                    gpt_forward_time += time.perf_counter() - m_start_time

                dtype = None
                with torch.amp.autocast(text_tokens.device.type, enabled=dtype is not None, dtype=dtype):
                    m_start_time = time.perf_counter()
                    diffusion_steps = 25
                    inference_cfg_rate = 0.7
                    latent = self.s2mel.models['gpt_layer'](latent)
                    S_infer = self.semantic_codec.quantizer.vq2emb(codes.unsqueeze(1))
                    S_infer = S_infer.transpose(1, 2)
                    S_infer = S_infer + latent
                    target_lengths = (code_lens * 1.72).long()

                    cond = self.s2mel.models['length_regulator'](S_infer,
                                                                 ylens=target_lengths,
                                                                 n_quantizers=3,
                                                                 f0=None)[0]
                    cat_condition = torch.cat([prompt_condition, cond], dim=1)
                    vc_target = self.s2mel.models['cfm'].inference(cat_condition,
                                                                   torch.LongTensor([cat_condition.size(1)]).to(
                                                                       cond.device),
                                                                   ref_mel, style, None, diffusion_steps,
                                                                   inference_cfg_rate=inference_cfg_rate)
                    vc_target = vc_target[:, :, ref_mel.size(-1):]
                    s2mel_time += time.perf_counter() - m_start_time

                    m_start_time = time.perf_counter()
                    wav = self.bigvgan(vc_target.float()).squeeze().unsqueeze(0)
                    print(wav.shape)
                    bigvgan_time += time.perf_counter() - m_start_time
                    wav = wav.squeeze(1)

                wav = torch.clamp(32767 * wav, -32767.0, 32767.0)
                # wavs.append(wav[:, :-512])
                print(f'>> sequence nograd 推理总用时: {(time.perf_counter() - seg_nograd_start_time):.2f}')
                return wait_time,wav.cpu()  # to cpu before saving

    def toWav(self,wav_list, output_path,
              sampling_rate=22050,
              interval_silence=200):
        wavs = self.insert_interval_silence(wav_list, sampling_rate=sampling_rate, interval_silence=interval_silence)
        wav = torch.cat(wavs, dim=1)
        wav = wav.cpu()  # to cpu
        if output_path:
            # 直接保存音频到指定路径中
            if os.path.isfile(output_path):
                os.remove(output_path)
                print(">> remove old wav file:", output_path)
            if os.path.dirname(output_path) != "":
                os.makedirs(os.path.dirname(output_path), exist_ok=True)
            torchaudio.save(output_path, wav.type(torch.int16), sampling_rate)
            print(">> wav file saved to:", output_path)
            return output_path
        else:
            # 返回以符合Gradio的格式要求
            wav_data = wav.type(torch.int16)
            wav_data = wav_data.numpy().T
            return (sampling_rate, wav_data)
