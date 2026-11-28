import { sha256 } from "./vault.mjs";

export const isSha256 = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const queryPrefix = "Instruct: Given a search query, retrieve relevant documents that answer the query\nQuery: ";

export function validateVector(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every(Number.isFinite) ||
      Math.abs(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) - 1) > 1e-5) {
    throw Error("Invalid BitNet vector dimensions, values or L2 norm");
  }
}

export function bitnetClient(endpoint, modelId, revision, modelSha256) {
  const base = new URL(endpoint);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password ||
      base.pathname !== "/" || base.search || base.hash) {
    throw Error("Endpoint must be an HTTP(S) origin without credentials");
  }
  async function request(route, payload) {
    const response = await fetch(new URL(route, base), {
      ...(payload && {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      signal: AbortSignal.timeout(125_000),
      redirect: "error",
    }).catch(error => {
      const failure = error.name === "TimeoutError" ? "timed out" : "request failed";
      throw Error(`BitNet ${route} ${failure}`);
    });
    if (!response.ok) {
      // The bridge rejects an oversized JSON body or a worker context refusal
      // with HTTP 400. Keep other HTTP errors fatal, even for a single row.
      if (response.status === 400 && route.startsWith("/bitnet/embed")) {
        const { error } = await response.json().catch(() => ({})) ?? {};
        if (typeof error === "string" && /^(input too large|context limit(?:: \d+ tokens)?)$/u.test(error)) {
          return null;
        }
        throw Error(`BitNet ${route} returned HTTP 400`);
      }
      await response.body?.cancel();
      throw Error(`BitNet ${route} returned HTTP ${response.status}`);
    }
    return response.json().catch(() => { throw Error(`Invalid BitNet ${route} response`); });
  }
  return {
    async profile() {
      const health = await request("/health");
      const { dims, max_tokens, document_device, query_device } = health ?? {};
      if (health?.model !== modelId || health.model_sha256 !== modelSha256 ||
          !Number.isSafeInteger(dims) || dims < 1 || dims > 65536 ||
          !Number.isSafeInteger(max_tokens) || max_tokens < 1 ||
          !Number.isSafeInteger(health.query_context) || health.query_context < 1 ||
          ![document_device, query_device].every(device => ["cuda", "cpu"].includes(device)) ||
          ([document_device, query_device].includes("cuda") &&
            ![health.gpu_worker_sha256, health.gpu_model_sha256].every(isSha256)) ||
          ([document_device, query_device].includes("cpu") && !isSha256(health.runtime_sha256)) ||
          ![health.runtime, health.backend].every(value => typeof value === "string" && value.length > 0)) {
        throw Error("BitNet health does not match the expected model or encoding identity");
      }
      return {
        model: { provider_key: "ollama", model_key: modelId, dimensions: dims, max_tokens },
        identity: {
          revision,
          modelSha256,
          tokenizer: "GGUF Gemma 3 vocabulary, llama_tokenize with special tokens, BOS and EOS",
          documentPrefix: "",
          queryPrefix,
          pooling: "last causal token (EOS)",
          normalization: "L2",
          runtime: health.runtime,
          backend: health.backend,
          queryDevice: query_device,
          queryContext: health.query_context,
          documentDevice: document_device,
          gpuWorkerSha256: health.gpu_worker_sha256 ?? null,
          gpuModelSha256: health.gpu_model_sha256 ?? null,
          cpuRuntimeSha256: health.runtime_sha256 ?? null,
          cpuBlasSha256: health.openblas_dll_sha256 ?? null,
          threads: health.threads ?? null,
          computeBatch: health.compute_batch ?? null,
          flashAttention: health.flash_attention ?? null,
          blasAttention: health.blas_attention ?? null,
          clearKvData: health.clear_kv_data ?? null,
        },
      };
    },
    async encode(parts, profile) {
      const items = parts.map(part => ({
        purpose: "document",
        input: part.input,
        // The bridge logs provenance. The relative file name also occurs in the input.
        source_path: part.relative + (part.key ?? ""),
        entity_kind: part.key ? "block" : "source",
      }));
      const batch = profile.identity.documentDevice === "cuda";
      const payload = await request(batch ? "/bitnet/embed-batch" : "/bitnet/embed",
        batch ? { model: modelId, items } : { model: modelId, ...items[0] });
      if (payload === null) {
        if (parts.length === 1) return [null];
        const middle = Math.floor(parts.length / 2);
        return [...await this.encode(parts.slice(0, middle), profile),
          ...await this.encode(parts.slice(middle), profile)];
      }
      if (payload?.model !== modelId || !Array.isArray(payload.results) ||
          payload.results.length !== parts.length) throw Error("BitNet returned unexpected document results");
      return payload.results.map((row, index) => {
        // The single-document CPU route returns the native worker row. Its
        // device label is added only to the bridge's audit record.
        const device = !batch && row?.device === undefined ? "cpu" : row?.device;
        if (!row || device !== profile.identity.documentDevice || typeof row.truncated !== "boolean" ||
            !Number.isSafeInteger(row.tokens) || row.tokens < 1 || row.tokens > profile.model.max_tokens ||
            row.prefix_applied === true ||
            (row.input_sha256 !== undefined && row.input_sha256 !== sha256(items[index].input))) {
          throw Error("BitNet returned a truncated or incompatible document encoding");
        }
        validateVector(row.vector, profile.model.dimensions);
        if (row.truncated) return null;
        const bytes = Buffer.allocUnsafe(row.vector.length * 4);
        row.vector.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
        return bytes;
      });
    },
  };
}
