FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUTF8=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential \
       ca-certificates \
       libsasl2-dev \
       libsasl2-modules \
       libkrb5-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5085 5086

CMD ["python", "core.py", "--config", "/app/config/presentation/adapter.runtime.json", "serve", "--host", "0.0.0.0", "--port", "5085", "--developer-port", "5086"]
