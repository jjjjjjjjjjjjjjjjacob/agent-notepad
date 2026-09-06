# Embedding service

[FastEmbed](https://github.com/qdrant/fastembed) (Apache-2.0) runs the MIT-licensed [BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) model on CPU using ONNX Runtime. No AWS account, GPU, or hosted model API is required. Convex continues to store vectors and perform hybrid retrieval.

The image pins FastEmbed 0.8.0 and the quantized model artifact at Hugging Face commit `52398278842ec682c6f32300af41344b1c0b0bb2`. It downloads the model during the build and starts offline. Changing a model, artifact, or preprocessing algorithm requires a new model identifier, index, and backfill; changing only the URL must preserve the same vector space.

## Local development

From the repository root:

```sh
# Store locally; do not commit this file.
umask 077
printf 'EMBEDDING_SERVICE_TOKEN=%s\n' "$(openssl rand -hex 32)" > services/embeddings/.env
docker compose --env-file services/embeddings/.env -f services/embeddings/compose.yaml up --build -d
curl --fail http://127.0.0.1:8088/health
docker compose --env-file services/embeddings/.env -f services/embeddings/compose.yaml exec embeddings python test_service.py
```

Set `EMBEDDING_SERVICE_URL=http://127.0.0.1:8088` and the same `EMBEDDING_SERVICE_TOKEN` **on your isolated local Convex deployment**. A hosted Convex deployment cannot call your laptop's localhost. The app's ordinary development environment uses hosted Convex; run `bun run backend:test` and `bun run dev:test` to use the isolated backend and frontend instead.

The service tests use real embeddings and check semantic paraphrases, vector shape and normalization, query instructions, authorization, model mismatch, batch bounds, and complete long-input coverage. Run the optional application integration test with these two variables and `RUN_EMBEDDING_INTEGRATION=1 bun run test -- tests/embeddings-integration.test.ts`. That test uses the real service with Convex's in-memory test backend and never modifies a deployed database.

## Hosting

Build this directory on any Docker-compatible host and expose container port 8080 behind HTTPS. Begin with 2 CPU cores and 2 GiB RAM, one worker, and an always-running instance; measure usage before sizing further. These are starting settings, not a throughput guarantee. Configure the shared token as a secret. Use `/health` for readiness checks. Do not expose the unauthenticated container port directly to the internet. The local Compose configuration binds only to loopback; a hosting platform normally supplies its own ingress.

On the target Convex deployment, configure:

```text
EMBEDDING_SERVICE_URL=https://your-embedding-service.example
EMBEDDING_SERVICE_TOKEN=<the service's shared secret>
```

The service URL is a base URL, without `/embed`. These settings belong on Convex, not in `NEXT_PUBLIC_*` variables. Requests refuse redirects to avoid forwarding credentials. The service bounds request bytes, batch sizes, input lengths, concurrency, and queue wait time. It returns 503 when busy; search keeps keyword results and reports degradation, and indexing uses persisted bounded retries.

After deploying the new Convex schema and functions, run `bunx convex run retrieval:backfill '{}'` against the intended deployment. Pass its returned cursor until null. The backfill upgrades old chunk layouts, queues missing BGE vectors, skips active jobs, and permits explicit retries of blocked or failed jobs. Verify all embedding jobs completed, then run `bun scripts/test-retrieval.ts --require-hybrid` against the relevant frontend. A configured endpoint alone does not establish index coverage.

## Model limits and retrieval

The model produces normalized 384-dimensional English embeddings with a 512-token limit. Queries receive BGE's retrieval instruction; documents do not. Queries over the token limit fail explicitly. Indexed body passages are at most 1,200 characters with heading context and overlap. If an input still exceeds the token limit, the service splits it using the model tokenizer, embeds every window, and returns a token-weighted normalized mean. Responses expose window and token counts. Pooling long inputs can weaken relevance, so short indexed passages remain the normal path.

Retrieval expands small matching passages into surrounding section context, retaining exact revision offsets and citations under the caller's context budget. Related queries share one embedding request. Keyword fallback remains available. This English model is not a promise of multilingual retrieval quality.

The old 1,024-dimensional Titan field/index remains in the schema for an additive rollout; new retrieval never searches it. Remove it only in a later migration after confirming no old deployed functions depend on it. Other application features may independently use AWS; search itself requires only this service and Convex.
