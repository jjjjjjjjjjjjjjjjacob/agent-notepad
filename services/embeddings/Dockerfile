FROM python:3.14.7-slim-trixie@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6 AS build
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    MODEL_CACHE=/models EMBEDDING_THREADS=2 HF_HUB_DISABLE_TELEMETRY=1 ORT_DISABLE_TELEMETRY=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements.txt
COPY engine.py .
# Keep the existing model identity and preprocessing; downloads happen only at build time.
RUN python engine.py && chmod -R a+rX /models
COPY stage_runtime.py /tmp/stage_runtime.py
RUN python /tmp/stage_runtime.py && python -m pip uninstall --yes pip \
    && rm -rf /usr/local/lib/python3.12/ensurepip
COPY app.py test_service.py ./

# Verify this publisher's keyless signature before building; a digest alone is not identity verification.
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:c31ff9abcb1910f3ab25c7957bdaf0bfe12a01eb546e8df2282f1c8f682b606c
COPY --from=build /runtime /
COPY --from=build /usr/local /usr/local
COPY --from=build /models /models
COPY --from=build /app /app
ENV PATH=/usr/local/bin:/usr/bin:/bin LD_LIBRARY_PATH=/usr/local/lib \
    PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    MODEL_CACHE=/models EMBEDDING_THREADS=2 HF_HUB_DISABLE_TELEMETRY=1 HF_HUB_OFFLINE=1 \
    ORT_DISABLE_TELEMETRY=1
WORKDIR /app
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
    CMD ["/usr/local/bin/python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4)"]
CMD ["/usr/local/bin/python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--limit-concurrency", "32", "--no-access-log"]
