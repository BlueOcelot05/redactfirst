/**
 * The two AI stages.
 *
 *  Stage 1 (detectOnDevice): Gemini Nano, ONLY_ON_DEVICE. Sees the raw text.
 *  Stage 2 (runTask):        PREFER_IN_CLOUD. Sees only redacted text, and is
 *                            blocked if a hard identifier is still present.
 */
import type { EntityType } from "./detectors";
import { DEVICE_CREATE_OPTIONS, getModels } from "./firebase";
import { chunk, findLeaks } from "./redact";
import { buildTaskPrompt, DETECT_PROMPT, parseEntities, type TaskId } from "./ai-pure";

export type { TaskId };

export type DeviceStatus = "available" | "downloadable" | "downloading" | "unavailable";

interface LanguageModelGlobal {
  availability(options?: unknown): Promise<DeviceStatus>;
}

/** Ask Chrome's Prompt API whether Gemini Nano can run on this machine. */
export async function deviceStatus(): Promise<DeviceStatus> {
  const lm = (globalThis as { LanguageModel?: LanguageModelGlobal }).LanguageModel;
  if (!lm) return "unavailable";
  try {
    return await lm.availability(DEVICE_CREATE_OPTIONS);
  } catch {
    return "unavailable";
  }
}

/** Must be called from a user gesture (Chrome requires user activation to download). */
export async function downloadDeviceModel(onProgress: (fraction: number) => void): Promise<void> {
  const models = getModels();
  if (!models) throw new Error("Firebase is not configured.");
  await models.detector.initializeDeviceModel(onProgress);
}

export interface DetectionResult {
  /** false = the on-device model could not run; caller falls back to rules only. */
  ran: boolean;
  entities: Array<{ text: string; type: EntityType }>;
  error?: string;
}

/** Stage 1. Never falls back to the cloud: ONLY_ON_DEVICE throws instead. */
export async function detectOnDevice(
  text: string,
  onProgress?: (done: number, total: number) => void,
): Promise<DetectionResult> {
  const models = getModels();
  if (!models) return { ran: false, entities: [], error: "Firebase is not configured." };
  const parts = chunk(text);
  const entities: Array<{ text: string; type: EntityType }> = [];
  try {
    for (const [i, part] of parts.entries()) {
      const result = await models.detector.generateContent(DETECT_PROMPT + part.text);
      // Defence in depth: refuse anything that did not run locally.
      if (result.response.inferenceSource !== "on_device") {
        throw new Error("Detection did not run on-device; result discarded.");
      }
      entities.push(...parseEntities(result.response.text()));
      onProgress?.(i + 1, parts.length);
    }
    return { ran: true, entities };
  } catch (err) {
    return { ran: false, entities: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export class LeakError extends Error {
  constructor(public leaks: Array<{ type: EntityType; value: string }>) {
    super(`Blocked: ${leaks.length} unmasked identifier(s) in the outgoing text.`);
  }
}

export interface TaskResult {
  text: string;
  source: "on_device" | "in_cloud" | "unknown";
  /** Exactly what was handed to the model. */
  payload: string;
}

/** Stage 2. Hybrid: cloud when reachable, on-device when not. */
export async function runTask(task: TaskId, redactedText: string, custom = ""): Promise<TaskResult> {
  const models = getModels();
  if (!models) throw new Error("Firebase is not configured.");
  if (task === "custom" && !custom.trim()) throw new Error("Write an instruction first.");

  const payload = buildTaskPrompt(task, redactedText, custom);
  // The guard inspects the full outgoing payload, including a custom instruction.
  const leaks = findLeaks(payload);
  if (leaks.length) throw new LeakError(leaks);

  const result = await models.assistant.generateContent(payload);
  const source = result.response.inferenceSource;
  return {
    text: result.response.text(),
    source: source === "on_device" || source === "in_cloud" ? source : "unknown",
    payload,
  };
}
