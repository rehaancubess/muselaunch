import type { HandlerRegistry } from "@muselaunch/platform";
import { resolveMediaHandler } from "./broll";
import { analyzeClipHandler } from "./clip";
import { imageGenerateHandler } from "./images";
import { probeHandler } from "./probe";
import { analyzeRecordingHandler } from "./recording";
import { segmentHandler } from "./segment";
import { musicHandler, voiceoverHandler } from "./sound";
import { transcribeHandler } from "./transcribe";
import { ttsHandler } from "./tts";
import { extractUiHandler } from "./ui-extract";

/** Job handlers owned by this module. Registered by apps/worker. */
export const handlers: HandlerRegistry = {
  "media.probe": probeHandler,
  "media.segment": segmentHandler,
  "media.transcribe": transcribeHandler,
  "media.image_generate": imageGenerateHandler,
  "media.tts": ttsHandler,
  "media.analyze_clip": analyzeClipHandler,
  "storyboard.resolve_media": resolveMediaHandler,
  "media.analyze_recording": analyzeRecordingHandler,
  "media.extract_ui": extractUiHandler,
  "media.music": musicHandler,
  "media.voiceover": voiceoverHandler,
};

export { brollTargets, imageSizeFor, importBroll, reasonFor, trimBrollVideo, usedKey, BROLL_KINDS, VIDEO_SCALE, type BrollOutcome, type BrollTarget } from "./broll";
export { storeGeneratedImages } from "./images";

// Sound (Track 3): original music + SFX synthesized by our own code, verified AI voiceover.
export { renderMusic, planArrangement, renderSfx, encodeM4a, wavBytes, integratedLoudness, ensureMusicAsset, ensureSfxLibrary, moodFromText, musicAssetId, sfxAssetId, MUSIC_ENGINE_VERSION, SFX_ENGINE_VERSION, type MusicRender, type MusicPlan } from "./music";
export { prepareSoundtrack, soundSettings, narrationScript, setSfx, removeMusic, removeVoiceover, normalizeWords, wordErrorRate, scriptTurns, voiceoverCredits, type SoundtrackResult, type VoiceoverResult } from "./sound";

export { transcriptToCaptionCues, cuesToSrt, cuesToVtt, type CueOptions } from "./captions";
export { ffmpeg, ffmpegPath, ffprobePath, ffmpegWriter, probeMedia, countVideoFrames, type MediaProbe } from "./ffmpeg";
export { trackingQuality, samFrameSize, paintDetection } from "./masks";
export { LOW_QUALITY_THRESHOLD, SAM_MAX_FRAMES, encodeCorrection, decodeCorrection, samPromptFor } from "./segment";
export { modeForPurpose, MAX_TRANSCRIBE_SECONDS, toWav } from "./transcribe";
export { needsVideoNormalisation, MAX_LONG_EDGE } from "./probe";
export { requestSegmentation, correctSegmentation, requestTranscript, waitForTranscript, importStock, ensureConsent, PERSON_PROMPT } from "./service";
export { installMediaDeps, mediaDeps, type MediaDeps } from "./util";
export { loadTracks, buildTracks, presenceRanges, meanBbox, trackQuality } from "./tracks";
export { requestClipAnalysis, estimateClipAnalysis, DEFAULT_CLIP_PROMPTS } from "./clip";
export { findOrCreateSegmentation, findOrCreateTranscript, lookupSegmentation, lookupTranscript } from "./service";
export { MAX_OBJECT_OUTPUTS } from "./segment";
export { detectShots, keyframeTimes, sampleFrameChanges, SHOT_RULES, type Shot, type FrameChanges } from "./frames";
export { requestRecordingAnalysis, estimateRecordingAnalysis, recordingProblem, autoAnalyzeRecording, MAX_RECORDING_SEC } from "./recording";
export { requestUiExtraction, estimateUiExtraction, appScreenshots, pendingScreens, isUiCrop, isOriginalScreenshot, pickPhoneScreen, UI_SCREEN_PROMPTS } from "./ui-extract";
