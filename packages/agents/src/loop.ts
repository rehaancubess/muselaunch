import type { SourceRef } from "@muselaunch/contracts";
import { AppError, toAppError, type Platform } from "@muselaunch/platform";
import { isExpiredResponseRef, parseToolArgs, respond, toolParameters, type FunctionTool, type ResponseInputItem } from "@muselaunch/providers";
import type { z } from "zod";
import type { RunRecorder } from "./runs";
import { brief, clip } from "./util";

export interface LoopToolResult {
  output: unknown;
  /** Ends the loop after this turn's calls are processed. */
  finish?: boolean;
  citations?: SourceRef[];
}

export interface LoopTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  /** Search tools count against `maxSearchCalls` (checked before running). */
  search?: boolean;
  run(args: z.infer<S>): Promise<LoopToolResult>;
}

export function defineTool<S extends z.ZodTypeAny>(t: LoopTool<S>): LoopTool<S> {
  return t;
}

export interface LoopOutcome {
  finished: boolean;
  stopReason?: string;
  finalText: string;
  turns: number;
}

/**
 * Bounded Muse Wonder tool loop over the Responses API (function tools + previous_response_id, falling
 * back to resending the full conversation if the server has dropped the stored response).
 * - Tool arguments are validated with Zod; invalid args return an error to the model (never executed).
 * - The AgentBudget is checked before every turn and every tool call; exhaustion records a
 *   `budget_stop` step and ends the loop gracefully (no crash, saved work is kept).
 * - Cancellation is honoured between turns and tool calls.
 */
export async function runToolLoop(
  p: Platform,
  opts: {
    recorder: RunRecorder;
    task: string;
    instructions: string;
    input: string;
    tools: LoopTool[];
    throwIfCancelled: () => void;
    maxTurns?: number;
    maxOutputTokens?: number;
    onTurn?: (turn: number) => Promise<void>;
  },
): Promise<LoopOutcome> {
  const rec = opts.recorder;
  const decls: FunctionTool[] = opts.tools.map((t) => ({ name: t.name, description: t.description, parameters: toolParameters(t.schema) }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const maxTurns = opts.maxTurns ?? rec.budget.maxToolCalls + 2;
  let input: ResponseInputItem[] = [{ role: "user", content: [{ type: "input_text", text: opts.input }] }];
  /**
   * The whole conversation (user brief, Wonder's tool calls, tool outputs), kept so it can be resent in
   * full if the server forgets a stored response (see isExpiredResponseRef). After that the loop stays
   * stateless: each turn sends the full history.
   */
  const history: ResponseInputItem[] = [...input];
  let stateless = false;
  let previousResponseId: string | undefined;
  let finalText = "";
  /** Set after a search-budget hit: the loop gets one wrap-up turn, and then reports that stop. */
  let wrapUp: string | null = null;
  const ended = async (turns: number): Promise<LoopOutcome> => {
    if (!wrapUp) return { finished: true, finalText, turns };
    await rec.budgetStopStep(wrapUp);
    return { finished: false, stopReason: wrapUp, finalText, turns };
  };
  for (let turn = 0; turn < maxTurns; turn++) {
    opts.throwIfCancelled();
    const stop = rec.budgetStop();
    if (stop) {
      await rec.budgetStopStep(stop);
      return { finished: false, stopReason: stop, finalText, turns: turn };
    }
    await opts.onTurn?.(turn);
    const call = (items: ResponseInputItem[], prev: string | undefined) =>
      respond(p, {
        ctx: rec.callCtx(opts.task),
        model: "wonder",
        instructions: opts.instructions,
        input: items,
        tools: decls,
        previousResponseId: prev,
        maxOutputTokens: opts.maxOutputTokens ?? 6000,
        reasoningEffort: "medium",
        parallelToolCalls: true,
        cacheKey: `agents.${opts.task}`,
      });
    let res: Awaited<ReturnType<typeof respond>>;
    try {
      res = stateless ? await call(history, undefined) : await call(input, previousResponseId);
    } catch (raw) {
      if (stateless || !previousResponseId || !isExpiredResponseRef(raw)) throw raw;
      stateless = true;
      await rec.step({ kind: "message", title: "Conversation resent in full", output: "The model service no longer had the earlier turns of this conversation, so the whole conversation (brief, tool calls and results) was sent again. Nothing is lost." });
      res = await call(history, undefined);
    }
    rec.addModelUsage(res);
    await rec.step({
      kind: "model_call",
      title: res.functionCalls.length ? `Muse Wonder → ${res.functionCalls.map((f) => f.name).join(", ")}` : "Muse Wonder (final answer)",
      model: res.model,
      output: res.text || res.functionCalls.map((f) => `${f.name}(${clip(f.arguments, 300)})`).join("\n"),
    });
    previousResponseId = res.responseId;
    if (res.text) finalText = res.text;
    if (!res.functionCalls.length) return ended(turn + 1);
    if (!previousResponseId) throw new AppError("PROVIDER_ERROR", "Responses API returned no response id for a tool-calling turn", { retryable: true });

    const outputs: ResponseInputItem[] = [];
    let finish = false;
    let budgetHit: string | null = null;
    for (const fc of res.functionCalls) {
      opts.throwIfCancelled();
      const tool = byName.get(fc.name);
      const started = Date.now();
      const stepStart = new Date().toISOString();
      const reply = (output: unknown) => outputs.push({ type: "function_call_output", call_id: fc.callId, output: clip(typeof output === "string" ? output : JSON.stringify(output), 24_000) });
      if (!tool) {
        reply({ error: `Unknown tool ${fc.name}` });
        continue;
      }
      const limit = rec.budgetStop({ toolCalls: 1, searchCalls: tool.search ? 1 : 0 });
      if (limit) {
        budgetHit = limit;
        const onlySearches = tool.search && limit.startsWith("search");
        reply({ error: `budget_exhausted: ${limit}. ${onlySearches ? "No more searches: save what the results you already have support, then call finish." : "Do not call more tools; call finish now."}` });
        continue;
      }
      const parsed = parseToolArgs(fc.arguments, tool.schema);
      if (!parsed.ok) {
        const step = await rec.step({ kind: "tool_call", title: `${fc.name}: invalid arguments`, status: "failed", input: fc.arguments, output: parsed.error, startedAt: stepStart });
        await rec.tool(step.id, fc.name, safeArgs(fc.arguments), { error: { code: "VALIDATION_FAILED", message: clip(parsed.error, 4000), retryable: false } }, Date.now() - started);
        reply({ error: `Invalid arguments: ${parsed.error}` });
        continue;
      }
      try {
        const out = await tool.run(parsed.data);
        const step = await rec.step({ kind: "tool_call", title: fc.name, input: parsed.data, output: out.output, citations: out.citations, startedAt: stepStart });
        await rec.tool(step.id, fc.name, parsed.data as Record<string, unknown>, { result: out.output }, Date.now() - started);
        reply(out.output);
        if (out.finish) finish = true;
      } catch (raw) {
        const err = toAppError(raw);
        if (err.code === "CANCELLED") throw err;
        const step = await rec.step({ kind: "tool_call", title: `${fc.name} failed`, status: "failed", input: parsed.data, output: err.message, startedAt: stepStart });
        await rec.tool(step.id, fc.name, parsed.data as Record<string, unknown>, { error: err.toInfo() }, Date.now() - started);
        reply({ error: err.opts.userMessage ?? err.message });
      }
    }
    history.push(...res.functionCalls.map((fc): ResponseInputItem => ({ type: "function_call", call_id: fc.callId, name: fc.name, arguments: fc.arguments })), ...outputs);
    await rec.save({});
    if (finish) return ended(turn + 1);
    if (budgetHit) {
      // The calls that did run in this turn still have results. Send them back for one wrap-up turn
      // (budgeted calls keep being refused) so the model can save what it found, rather than
      // discarding them. First live run: 4 parallel searches, budget hit on the third, nothing saved.
      if (!wrapUp && budgetHit.startsWith("search") && turn + 1 < maxTurns) {
        wrapUp = budgetHit;
        input = outputs;
        continue;
      }
      await rec.budgetStopStep(wrapUp ?? budgetHit);
      return { finished: false, stopReason: wrapUp ?? budgetHit, finalText, turns: turn + 1 };
    }
    input = outputs;
  }
  await rec.budgetStopStep(`turn limit (${maxTurns})`);
  return { finished: false, stopReason: `turn limit (${maxTurns})`, finalText, turns: maxTurns };
}

function safeArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { raw: brief(raw, 2000) };
  } catch {
    return { raw: brief(raw, 2000) };
  }
}
