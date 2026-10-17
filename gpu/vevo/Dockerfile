ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN pip install --no-cache-dir --index-url https://pypi.org/simple transformers==4.46.3 accelerate==0.24.1 json5 ruamel.yaml ipython einops soundfile pyworld
ENV PYTHONUNBUFFERED=1 HF_ENDPOINT=https://hf-mirror.com HF_HUB_DISABLE_XET=1 PYTHONPATH=/opt/vevo TORCH_HOME=/checkpoints/torch
WORKDIR /opt/vevo
COPY upstream /opt/vevo
COPY run_batch.py /app/run_batch.py
ENTRYPOINT ["python", "/app/run_batch.py"]
