# 在官方 vLLM 0.28.0 上补音频解码依赖。不要在宿主机 pip。
FROM vllm/vllm-openai:v0.28.0
USER root
RUN pip install --no-cache-dir --root-user-action=ignore librosa soundfile soxr
