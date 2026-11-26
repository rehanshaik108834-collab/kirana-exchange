# syntax=docker/dockerfile:1.7
FROM python:3.12.9-slim-bookworm AS builder

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
  && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY services-py/forecast-service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir -r requirements.txt

COPY services-py/forecast-service/pyproject.toml ./pyproject.toml
COPY services-py/forecast-service/src ./src
RUN pip install --no-cache-dir --no-deps .

FROM python:3.12.9-slim-bookworm AS runner

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PATH="/opt/venv/bin:$PATH"
ENV APP_PORT=3006
WORKDIR /app

# libgomp1 is required at runtime by LightGBM
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --create-home --shell /usr/sbin/nologin appuser

COPY --from=builder --chown=appuser:appuser /opt/venv /opt/venv
COPY --from=builder --chown=appuser:appuser /build/src ./src

USER appuser
EXPOSE 3006

HEALTHCHECK --interval=20s --timeout=5s --start-period=25s --retries=3 \
  CMD python -c "import os, sys, urllib.request; port = os.environ.get('APP_PORT', '3006'); sys.exit(0 if urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=3).status == 200 else 1)"

CMD ["uvicorn", "forecast.api.main:app", "--host", "0.0.0.0", "--port", "3006"]
