"use client";
/**
 * Owner: module D (Multimodal media). Founder recording / spoken instructions via Muse Voice Transcribe.
 * Props are the agreed contract; replace the internals.
 */
import { Mic } from "lucide-react";
import { FeaturePlaceholder } from "../_placeholder";

export interface VoiceRecorderProps {
  appId?: string;
  purpose?: "founder_brief" | "voice_command" | "captions";
  onTranscript?: (text: string, transcriptId: string) => void;
}

export default function VoiceRecorder(_props: VoiceRecorderProps) {
  return <FeaturePlaceholder icon={<Mic aria-hidden />} title="Voice recording" description="Record a founder brief or speak an edit. Transcription isn’t available in this build yet." />;
}
