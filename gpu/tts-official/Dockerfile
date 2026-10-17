ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/opt/index-tts
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates ffmpeg git libgl1 libglib2.0-0 libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
COPY upstream /opt/index-tts
WORKDIR /opt/index-tts
# The LAN base is the proven inference-host IndexTTS 2.5 environment. PYTHONPATH
# points at this fresh official checkout, so its source replaces the base copy.
COPY patches /tmp/patches
RUN python3 /tmp/patches/apply_patch.py
COPY app /app
CMD ["python", "/app/main.py"]
