FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir psycopg[binary]
COPY catalog_cn.py extract_one.py ./
CMD ["python3", "-u", "catalog_cn.py"]
