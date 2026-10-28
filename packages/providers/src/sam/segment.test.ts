import { readFileSync } from "node:fs";
import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { installMetaClient, MetaClient } from "../meta/client";
import { PRICES } from "../pricing";
import { runSam, samBilledUnits } from "./segment";

const fixture = JSON.parse(readFileSync(new URL("../../../../fixtures/media/sam-video-box-prompt.json", import.meta.url), "utf8")) as { rawOutput: string };

/** Responses SSE in the documented SAM shape: one output_text.delta per frame line, then response.completed. */
function sse(rawOutput: string, usage?: Record<string, number>): string {
  const lane = { item_id: "msg_fixture", output_index: 0, content_index: 0 };
  const events: Record<string, unknown>[] = [{ type: "response.created", response: { id: "resp_fixture", object: "response", status: "in_progress" } }];
  for (const line of rawOutput.split(/(?<=\n)/)) if (line) events.push({ type: "response.output_text.delta", ...lane, delta: line });
  events.push({ type: "response.output_text.done", ...lane, text: rawOutput });
  events.push({ type: "response.completed", response: { id: "resp_fixture", object: "response", status: "completed", ...(usage ? { usage } : {}) } });
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function install(usage?: Record<string, number>) {
  const p = createTestPlatform({ META_API_KEY: "test-key" });
  const f = (async () => new Response(sse(fixture.rawOutput, usage), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  installMetaClient(p, new MetaClient(p, { fetch: f, apiKey: "test-key" }));
  return p;
}

describe("runSam metering (docs: ResponseUsage.video_frames_processed / images_processed)", () => {
  it("meters the frames the server reports, not the caller's estimate", async () => {
    const p = install({ input_tokens: 0, output_tokens: 0, total_tokens: 0, video_frames_processed: 120 });
    const out = await runSam(p, { workspaceId: "ws1", task: "t" }, { media: { kind: "video", fileId: "file-1" }, prompt: { kind: "text", text: "box" }, frameCount: 20 });
    expect(out.frames.length).toBe(20);
    const [usage] = (await p.db.ws("ws1").collection("modelUsage").list()).items;
    expect(usage).toMatchObject({ operation: "segmentation", frames: 120, status: "ok" });
    expect(usage!.costUsdEstimate).toBeCloseTo(120 * PRICES.samPerVideoFrame, 10);
  });

  it("falls back to the estimate (with the 50-frame minimum) when usage is absent", async () => {
    const p = install();
    await runSam(p, { workspaceId: "ws1", task: "t" }, { media: { kind: "video", fileId: "file-1" }, prompt: { kind: "text", text: "box" }, frameCount: 20 });
    const [usage] = (await p.db.ws("ws1").collection("modelUsage").list()).items;
    expect(usage).toMatchObject({ frames: 20 });
    expect(usage!.costUsdEstimate).toBeCloseTo(PRICES.samMinFramesPerVideoRequest * PRICES.samPerVideoFrame, 10);
  });

  it("uses images_processed for stills", () => {
    expect(samBilledUnits("image", { images_processed: 1 }, 1)).toEqual({ units: 1, reported: true });
    expect(samBilledUnits("image", null, 1)).toEqual({ units: 1, reported: false });
  });
});
