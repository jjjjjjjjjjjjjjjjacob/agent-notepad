FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    MODEL_CACHE=/models EMBEDDING_THREADS=2 HF_HUB_DISABLE_TELEMETRY=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY engine.py .
# Pin and bake model artifacts into the image: no downloads during cold starts.
RUN python engine.py && chmod -R a+rX /models
ENV HF_HUB_OFFLINE=1
COPY app.py test_service.py ./
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4)"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--limit-concurrency", "32", "--no-access-log"]
