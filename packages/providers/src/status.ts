import { museImageEligible, type Platform } from "@muselaunch/platform";

export type ProviderState = "live" | "not_configured" | "restricted" | "manual_only" | "pending_approval";

export interface ProviderStatus {
  id: string;
  label: string;
  role: string;
  state: ProviderState;
  detail: string;
}

/**
 * Honest availability report for the Integrations screen and the demo report (spec 9:
 * "clearly label production integrations ... unavailable providers"). Never reports a
 * provider as live unless it is configured for real calls.
 */
export function providerStatuses(p: Platform, endUserCountry?: string): ProviderStatus[] {
  const { cfg } = p;
  const meta = Boolean(cfg.META_API_KEY);
  const muse = museImageEligible(cfg, endUserCountry);
  const imageProvider = muse.eligible && cfg.IMAGE_PROVIDER === "muse" ? "muse" : cfg.OPENAI_API_KEY ? "openai" : "none";
  // While OpenAI stands in (cfg.standIn), the Meta-only models are not connected and the two text
  // roles say exactly which OpenAI model answers them.
  const stand = cfg.standIn;
  const realMeta = meta && !stand;
  const waiting = "Needs the Meta Model API key (OpenAI is standing in for Muse Wonder and Muse Spark only)";
  return [
    stand
      ? { id: "muse-wonder", label: `Muse Wonder → OpenAI ${stand.wonder}`, role: "Growth strategist & research orchestrator", state: "live", detail: `Temporary stand-in: OpenAI ${stand.wonder} answers Muse Wonder's calls until the Meta Model API key is connected` }
      : { id: "muse-wonder", label: "Muse Wonder", role: "Growth strategist & research orchestrator", state: meta ? "live" : "not_configured", detail: cfg.META_MODEL_WONDER },
    stand
      ? { id: "muse-spark", label: `Muse Spark 1.3 → OpenAI ${stand.spark}`, role: "App analysis, campaigns, scripts, edits", state: "live", detail: `Temporary stand-in: OpenAI ${stand.spark} answers Muse Spark's calls until the Meta Model API key is connected` }
      : { id: "muse-spark", label: "Muse Spark 1.3", role: "App analysis, campaigns, scripts, edits", state: meta ? "live" : "not_configured", detail: cfg.META_MODEL_SPARK },
    { id: "sam", label: "SAM 3.1", role: "Subject masking & tracking", state: realMeta ? "live" : "not_configured", detail: stand ? waiting : cfg.META_MODEL_SAM },
    { id: "muse-voice", label: "Muse Voice Transcribe", role: "Founder recordings & voice commands", state: realMeta ? "live" : "not_configured", detail: stand ? waiting : cfg.META_MODEL_VOICE },
    {
      id: "muse-image",
      label: "Muse Image",
      role: "Campaign imagery",
      state: muse.eligible && realMeta ? "live" : "restricted",
      detail: muse.eligible ? cfg.META_MODEL_IMAGE : `${muse.reason}. Images use a separately licensed provider.`,
    },
    {
      id: "image-alt",
      label: imageProvider === "openai" ? `OpenAI Images (${cfg.OPENAI_IMAGE_MODEL})` : "Alternative image provider",
      role: "Licensed image generation where Muse Image is unavailable",
      state: imageProvider === "openai" ? "live" : "not_configured",
      detail: imageProvider === "openai" ? "Generated images are labelled as OpenAI-generated" : "Set OPENAI_API_KEY",
    },
    {
      id: "muse-spark-open",
      label: "Muse Spark Open",
      role: "Meta's open-weights Spark on Baseten: high-volume copy and variant steps, and the fallback when the Meta Model API is limited",
      state: cfg.BASETEN_API_KEY ? "live" : "not_configured",
      detail: cfg.BASETEN_API_KEY
        ? `${cfg.SPARK_OPEN_MODEL} (open weights via Baseten) · runs: ${cfg.SPARK_OPEN_TASKS.join(", ") || "nothing by default"} · fallback ${cfg.SPARK_OPEN_FALLBACK ? "on" : "off"}`
        : "Set BASETEN_API_KEY (Baseten Model APIs) to connect",
    },
    {
      id: "muse-glimmer",
      label: "Muse Glimmer",
      role: "Self-hosted brand memory & preference reasoning",
      state: cfg.GLIMMER_BASE_URL ? "live" : "not_configured",
      detail: cfg.GLIMMER_BASE_URL ? `${cfg.GLIMMER_MODEL} (${cfg.GLIMMER_LABEL})` : "Set GLIMMER_BASE_URL to a running llama.cpp/SGLang/vLLM/Ollama endpoint",
    },
    { id: "tts", label: "Text-to-speech", role: "Optional narration (labelled external TTS)", state: cfg.OPENAI_API_KEY ? "live" : "not_configured", detail: cfg.OPENAI_API_KEY ? cfg.OPENAI_TTS_MODEL : "Optional" },
    {
      id: "stock",
      label: "Stock media",
      role: "Licensed stock footage/images",
      state: cfg.PEXELS_API_KEY || cfg.PIXABAY_API_KEY ? "live" : "manual_only",
      detail: cfg.PEXELS_API_KEY || cfg.PIXABAY_API_KEY ? "Configured" : "Upload your own footage; Openverse images available",
    },
  ];
}
