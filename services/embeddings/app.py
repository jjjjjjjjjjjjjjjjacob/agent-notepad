"""Authenticated, bounded HTTP service. Run one worker per container."""
import asyncio
import hmac
import json
import os
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from starlette.concurrency import run_in_threadpool

from engine import DIMENSIONS, MODEL_ID, Engine


class Batch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    texts: list[str] = Field(min_length=1, max_length=16)
    input_type: Literal["query", "passage"]
    model: Literal[MODEL_ID]

    @field_validator("texts")
    @classmethod
    def validate_texts(cls, texts):
        if any(not text.strip() or len(text) > 12000 for text in texts):
            raise ValueError("Each input must contain 1–12,000 characters.")
        return texts


@asynccontextmanager
async def lifespan(app):
    token = os.environ.get("EMBEDDING_SERVICE_TOKEN", "")
    if len(token) < 32:
        raise RuntimeError("Set EMBEDDING_SERVICE_TOKEN to at least 32 random characters.")
    app.state.token = token
    app.state.engine = await run_in_threadpool(Engine)
    app.state.slots = asyncio.Semaphore(1)
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
async def health():
    return {"status": "ready", "model": MODEL_ID, "dimensions": DIMENSIONS}


@app.post("/embed")
async def embed(request: Request):
    supplied = request.headers.get("authorization", "").encode()
    expected = f"Bearer {app.state.token}".encode()
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(401, "Unauthorized")
    # Bound raw bytes before JSON parsing (including chunked requests).
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 800_000:
            raise HTTPException(413, "Embedding request too large")
    try:
        batch = Batch.model_validate_json(body)
    except (ValidationError, ValueError, json.JSONDecodeError):
        # Do not reflect private input text in error bodies or logs.
        raise HTTPException(422, "Invalid embedding request") from None
    try:
        await asyncio.wait_for(app.state.slots.acquire(), timeout=5)
    except TimeoutError:
        raise HTTPException(503, "Embedding service busy", headers={"Retry-After": "1"}) from None
    try:
        return await run_in_threadpool(app.state.engine.embed, batch.texts, batch.input_type)
    except ValueError:
        raise HTTPException(422, "Input exceeds embedding limits") from None
    finally:
        app.state.slots.release()
