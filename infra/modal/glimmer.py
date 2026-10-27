"""
Muse Glimmer on Modal (production endpoint for the public beta, paid by the hackathon Modal credit).

Serves the 17 GB Q4_K_M GGUF with llama.cpp's OpenAI-compatible server on one L40S (48 GB),
scales to zero when idle, and caches weights in a Modal Volume so cold starts don't re-download.

Setup (once, on your PC):
    pip install modal
    modal setup                                   # log in
    modal secret create muselaunch-glimmer GLIMMER_API_KEY=<long random string>
Deploy:
    modal deploy infra/modal/glimmer.py
Then put the printed URL + "/v1" in .env as GLIMMER_BASE_URL_PROD and the same key as GLIMMER_API_KEY,
and re-run `pnpm deploy:gcp`.

Warm it before a demo:  curl <url>/health   (first start ≈ 1–3 min while the model loads to GPU).
"""
import subprocess

import modal

MINUTES = 60
MODEL_REPO = "meta-models/Muse-Glimmer-30B-GGUF"
MODEL_FILE = "Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf"
PORT = 8080

image = modal.Image.from_registry("ghcr.io/ggml-org/llama.cpp:server-cuda", add_python="3.12").entrypoint([])
weights = modal.Volume.from_name("muselaunch-glimmer-weights", create_if_missing=True)
app = modal.App("muselaunch-glimmer")


@app.function(
    image=image,
    gpu="L40S",
    volumes={"/models": weights},
    secrets=[modal.Secret.from_name("muselaunch-glimmer")],
    scaledown_window=10 * MINUTES,  # stay warm 10 min after the last request, then scale to zero
    timeout=60 * MINUTES,
    max_containers=2,
)
@modal.concurrent(max_inputs=4)
@modal.web_server(port=PORT, startup_timeout=20 * MINUTES)
def serve():
    import os

    cmd = [
        "/app/llama-server",
        "-hf", MODEL_REPO,
        "--hf-file", MODEL_FILE,
        "-a", "muse-glimmer",
        "-ngl", "99",
        "-c", "131072",
        "-np", "2",  # 2 concurrent slots of 65K context each
        "--host", "0.0.0.0",
        "--port", str(PORT),
        "--api-key", os.environ["GLIMMER_API_KEY"],
        "--chat-template-kwargs", '{"reasoning_strength":"low"}',
        "--no-mmproj",  # text-only memory reasoning; keeps VRAM for KV cache
    ]
    subprocess.Popen(cmd, env={**os.environ, "LLAMA_CACHE": "/models"})
