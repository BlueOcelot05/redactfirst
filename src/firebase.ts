/**
 * Firebase bootstrap: app, App Check and the two Firebase AI Logic hybrid models.
 *
 *  - detector:  ONLY_ON_DEVICE  — raw text is never allowed to fall back to the cloud.
 *  - assistant: PREFER_IN_CLOUD — works on redacted text; falls back to on-device when offline.
 */
import { initializeApp, type FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  type GenerativeModel,
  type LanguageModelCreateOptions,
} from "firebase/ai";

const env = import.meta.env;

export const firebaseConfigured = Boolean(
  env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_APP_ID,
);

/** Text-only sessions: no multimodal flag needed in Chrome. */
export const DEVICE_CREATE_OPTIONS: LanguageModelCreateOptions = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

/** JSON schema the on-device model must follow when reporting personal data. */
export const DETECTION_SCHEMA = {
  type: "object",
  required: ["entities"],
  additionalProperties: false,
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        required: ["text", "type"],
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          type: { type: "string", enum: ["PERSON", "ADDRESS", "HEALTH", "ORG", "DATE", "ID", "OTHER"] },
        },
      },
    },
  },
} as const;

export interface Models {
  detector: GenerativeModel;
  assistant: GenerativeModel;
}

let models: Models | null = null;

function initAppCheck(app: FirebaseApp): void {
  // Debug tokens are honoured in dev builds only, so a production bundle can never ship one.
  if (env.DEV && env.VITE_APPCHECK_DEBUG_TOKEN) {
    const token = env.VITE_APPCHECK_DEBUG_TOKEN;
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
      token === "true" ? true : token;
  }
  const siteKey = env.VITE_APPCHECK_RECAPTCHA_ENTERPRISE_KEY;
  if (!siteKey && !(env.DEV && env.VITE_APPCHECK_DEBUG_TOKEN)) {
    console.warn("[RedactFirst] App Check is not configured; cloud requests will be rejected.");
    return;
  }
  initializeAppCheck(app, {
    // In dev with a debug token the provider is never actually invoked.
    provider: new ReCaptchaEnterpriseProvider(siteKey || "debug-only"),
    isTokenAutoRefreshEnabled: true,
  });
}

/** Lazily initialise Firebase. Returns null when the project is not configured. */
export function getModels(): Models | null {
  if (!firebaseConfigured) return null;
  if (models) return models;

  const app = initializeApp({
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  });
  initAppCheck(app);

  const ai = getAI(app, { backend: new GoogleAIBackend() });
  const cloudModel = env.VITE_CLOUD_MODEL || undefined;

  models = {
    detector: getGenerativeModel(ai, {
      mode: InferenceMode.ONLY_ON_DEVICE,
      onDeviceParams: {
        createOptions: DEVICE_CREATE_OPTIONS,
        promptOptions: { responseConstraint: DETECTION_SCHEMA },
      },
    }),
    assistant: getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_IN_CLOUD,
      onDeviceParams: { createOptions: DEVICE_CREATE_OPTIONS },
      ...(cloudModel ? { inCloudParams: { model: cloudModel } } : {}),
    }),
  };
  return models;
}
