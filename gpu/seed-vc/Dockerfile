ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN pip install --no-cache-dir --index-url https://mirrors.aliyun.com/pypi/simple hydra-core==1.3.2 descript-audio-codec==1.0.0
ENV PYTHONUNBUFFERED=1 HF_ENDPOINT=https://hf-mirror.com HF_HUB_DISABLE_XET=1 PYTHONPATH=/opt/seed-vc
WORKDIR /opt/seed-vc
COPY upstream /opt/seed-vc
COPY run_batch.py /app/run_batch.py
ENTRYPOINT ["python", "/app/run_batch.py"]
