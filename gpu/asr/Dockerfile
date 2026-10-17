ARG BASE_IMAGE
FROM ${BASE_IMAGE}

WORKDIR /root/autodl-tmp/code

COPY . /root/autodl-tmp/code

RUN pip install --no-cache-dir -r requirements.txt

ENV PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["python", "main.py"]
