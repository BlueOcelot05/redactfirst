# RedactFirst

**Mask personal data on-device, then ask the cloud.** A web app for people who handle
sensitive messages (data-protection officers, clinics, accountants) and want AI help
without handing personal data to a cloud model.

Built for [#BuildHybridAI 2026](https://firebasehybridaihackathon.devpost.com/) with the
**Firebase AI Logic hybrid inference SDK**.

## How it uses hybrid inference

| Stage | What it does | Firebase AI Logic mode | Sees |
|---|---|---|---|
| 0 | Rule detectors: CNP (checksum), IBAN (mod-97), card (Luhn), e-mail, phone | none — plain code, local | raw text |
| 1 | Gemini Nano finds names, addresses, health details, IDs (JSON-schema constrained) | `ONLY_ON_DEVICE` | raw text |
| 2 | Summarise / draft a reply / DPO triage / custom instruction | `PREFER_IN_CLOUD` (falls back to on-device offline) | **redacted text only** |
| 3 | Placeholders in the answer are swapped back to the real values | none — plain code, local | answer + local map |

Privacy properties enforced in code, not just in prose:

- Stage 1 uses `ONLY_ON_DEVICE`, so raw text can never fall back to the cloud. The result is
  also discarded unless `response.inferenceSource === "on_device"` (`src/ai.ts`).
- Before stage 2 the exact outgoing payload is re-scanned by the rule detectors; any remaining
  hard identifier blocks the request (`findLeaks`, `LeakError`).
- If Gemini Nano is unavailable, only rule-based masking runs and the user must explicitly
  confirm they reviewed the text before anything is sent.
- The placeholder → value map lives in memory in the tab. Nothing is stored or logged.
- The UI shows which side served each answer and the exact text that was sent.

## Setup

Requirements: Node 20+, Chrome desktop 139+.

1. **Firebase project** — in the [Firebase console](https://console.firebase.google.com/) create a
   project, add a **Web app**, then open **AI Services → AI Logic → Get started** and choose the
   Gemini Developer API. This also enforces App Check for AI Logic.
2. **Config** — `cp .env.example .env.local` and fill in the web app config values.
3. **App Check (local dev)** — keep `VITE_APPCHECK_DEBUG_TOKEN=true`, run the app, copy the debug
   token printed in the browser console and register it under
   **Security → App Check → Apps → Manage debug tokens**. Never commit a debug token.
4. **On-device model** — click **Enable on-device model** in the app (one-time download, can take
   several minutes). If the status stays "unavailable", check `chrome://on-device-internals`.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests for detectors, redaction, leak guard, parsing
npm run build    # typecheck + production bundle in dist/
```

### Deploy (Firebase Hosting)

Register a reCAPTCHA Enterprise site key for your hosting domain in App Check and set
`VITE_APPCHECK_RECAPTCHA_ENTERPRISE_KEY`. Debug tokens are ignored in production builds.

```bash
npm run build
npx firebase-tools deploy --only hosting --project <your-project-id>
```

## Project layout

```
src/detectors.ts   rule detectors + validators (pure)
src/redact.ts      span merging, placeholders, rehydration, leak guard (pure)
src/ai-pure.ts     prompts and response parsing (pure)
src/ai.ts          stage 1 (on-device) and stage 2 (hybrid) calls
src/firebase.ts    Firebase app, App Check, the two hybrid models
src/main.ts        UI
tests/             vitest unit tests
```

## Limitations

- On-device detection is a language model: it can miss items. The review step exists for that
  reason; this tool assists a human, it does not replace their judgement.
- Rule detectors target Romanian formats (CNP, +40 phones) plus generic IBAN / card / e-mail.
- Chrome's on-device model officially supports a limited set of languages; quality on other
  languages varies.

## License

Apache-2.0 — see [LICENSE](LICENSE).
