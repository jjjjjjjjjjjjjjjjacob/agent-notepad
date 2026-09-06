"""CPU embeddings with a pinned model and explicit, lossless input windowing."""
import os
from pathlib import Path

import numpy as np
from fastembed import TextEmbedding
from huggingface_hub import snapshot_download
from tokenizers import Tokenizer

MODEL_NAME = "BAAI/bge-small-en-v1.5"
MODEL_REPO = "qdrant/bge-small-en-v1.5-onnx-q"
MODEL_REVISION = "52398278842ec682c6f32300af41344b1c0b0bb2"
MODEL_ID = f"bge-small-en-v1.5:{MODEL_REVISION}:windows-v1"
DIMENSIONS = 384
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "


def download_model():
    return snapshot_download(
        MODEL_REPO,
        revision=MODEL_REVISION,
        cache_dir=os.environ.get("MODEL_CACHE", "/models"),
        allow_patterns=["*.json", "model_optimized.onnx"],
        local_files_only=os.environ.get("HF_HUB_OFFLINE") == "1",
    )


class Engine:
    def __init__(self):
        path = download_model()
        self.tokenizer = Tokenizer.from_file(str(Path(path) / "tokenizer.json"))
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        self.model = TextEmbedding(
            model_name=MODEL_NAME,
            specific_model_path=path,
            threads=int(os.environ.get("EMBEDDING_THREADS", "2")),
        )

    def windows(self, text, input_type):
        if input_type == "query":
            text = QUERY_PREFIX + text
        encoding = self.tokenizer.encode(text, add_special_tokens=False)
        if input_type == "query" and len(encoding.ids) > 510:
            raise ValueError("Query exceeds the model's 512-token limit.")
        # Most 1,200-character indexed passages fit one window. For dense text or
        # long heading context, embed every token window and pool; never truncate.
        windows, weights = [], []
        while len(encoding.ids) > 510:
            end = encoding.offsets[480][0]
            if end <= 0:
                raise ValueError("Input cannot be split within the token limit.")
            window = text[:end]
            count = len(self.tokenizer.encode(window, add_special_tokens=False).ids)
            if count > 510:
                raise ValueError("Input window exceeds the token limit.")
            windows.append(window)
            weights.append(count)
            text = text[end:]
            encoding = self.tokenizer.encode(text, add_special_tokens=False)
        if text:
            windows.append(text)
            weights.append(max(1, len(encoding.ids)))
        return windows, weights

    def embed(self, texts, input_type):
        groups = [self.windows(text, input_type) for text in texts]
        flat = [window for windows, _ in groups for window in windows]
        vectors = list(self.model.embed(flat, batch_size=16))
        output, offset = [], 0
        for windows, weights in groups:
            pooled = np.average(vectors[offset:offset + len(windows)], axis=0, weights=weights)
            norm = np.linalg.norm(pooled)
            if not np.isfinite(pooled).all() or not np.isfinite(norm) or norm <= 0:
                raise RuntimeError("Invalid model output.")
            output.append((pooled / norm).tolist())
            offset += len(windows)
        return {
            "model": MODEL_ID,
            "dimensions": DIMENSIONS,
            "embeddings": output,
            "windows": [len(windows) for windows, _ in groups],
            "token_counts": [sum(weights) for _, weights in groups],
        }


if __name__ == "__main__":
    download_model()
