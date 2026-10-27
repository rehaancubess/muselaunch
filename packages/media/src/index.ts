import type { HandlerRegistry } from "@muselaunch/platform";
import { imageGenerateHandler } from "./images";
import { probeHandler } from "./probe";
import { segmentHandler } from "./segment";
import { transcribeHandler } from "./transcribe";
import { ttsHandler } from "./tts";

/** Job handlers owned by this module. Registered by apps/worker. */
export const handlers: HandlerRegistry = {
  "media.probe": probeHandler,
  "media.segment": segmentHandler,
  "media.transcribe": transcribeHandler,
  "media.image_generate": imageGenerateHandler,
  "media.tts": ttsHandler,
};

export { transcriptToCaptionCues, cuesToSrt, cuesToVtt, type CueOptions } from "./captions";
export { ffmpeg, ffmpegPath, ffprobePath, ffmpegWriter, probeMedia, countVideoFrames, type MediaProbe } from "./ffmpeg";
export { trackingQuality, samFrameSize, paintDetection } from "./masks";
export { LOW_QUALITY_THRESHOLD, SAM_MAX_FRAMES, encodeCorrection, decodeCorrection, samPromptFor } from "./segment";
export { modeForPurpose, MAX_TRANSCRIBE_SECONDS } from "./transcribe";
export { needsVideoNormalisation, MAX_LONG_EDGE } from "./probe";
export { requestSegmentation, correctSegmentation, requestTranscript, waitForTranscript, importStock, ensureConsent, PERSON_PROMPT } from "./service";
export { installMediaDeps, type MediaDeps } from "./util";
