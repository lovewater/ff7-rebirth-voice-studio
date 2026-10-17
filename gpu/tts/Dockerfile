# Reuse the Qwen image already on inference-host (torch 2.8.0+cu128, py3.11).
# Do not pull pytorch/pytorch; weights stay on the host bind-mount.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ENV PYTHONUNBUFFERED=1 \
    HF_ENDPOINT=https://hf-mirror.com \
    PYTHONPATH=/app/main:/app/tts_base \
    INDEXTTS_UPSTREAM_COMMIT=ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c \
    INDEXTTS_MODEL_REVISION=c39ce5ba981572cb187443877ff559dfb246ce63 \
    UV_SYSTEM_PYTHON=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

LABEL org.opencontainers.image.source="https://github.com/index-tts/index-tts" \
      org.opencontainers.image.revision="ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c"

WORKDIR /app
COPY tts_base /app/tts_base
COPY main /app/main
COPY audio_cache /app/audio_cache
COPY requirements-api.txt /app/requirements-api.txt
COPY config.json /app/main/config.json

# Image already has torch/torchaudio 2.8.0+cu128; pip should skip them.
RUN pip install --no-cache-dir -e /app/tts_base \
        -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple \
    && pip install --no-cache-dir -r /app/requirements-api.txt \
        -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple

EXPOSE 8000
CMD ["python", "/app/main/main.py"]
