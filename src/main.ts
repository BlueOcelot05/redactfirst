import { detectOnDevice, deviceStatus, downloadDeviceModel, LeakError, runTask, type TaskId } from "./ai";
import { detectWithRules, type Span } from "./detectors";
import { firebaseConfigured } from "./firebase";
import { redact, rehydrate, spansFromStrings, type Redaction } from "./redact";

// All sample data below is synthetic.
const SAMPLE = `Subject: Request for a copy of my medical file

Dear Sir or Madam,

My name is Andrei Popescu and I was a patient in your cardiology ward between 3 and 9 March 2026,
where Dr. Ioana Marinescu treated me for atrial fibrillation and prescribed apixaban.

Under Article 15 GDPR I am asking for a full copy of my medical file, including the discharge letter.
My personal numeric code is 1800101050014 and I live at Strada Republicii 14, ap. 7, Oradea.

Please send the documents to andrei.popescu@example.com or call me on 0712 345 678.
If there is a fee, I can pay by transfer from RO49 AAAA 1B31 0075 9384 0000.

Kind regards,
Andrei Popescu`;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const input = $<HTMLTextAreaElement>("input");
const preview = $("preview");
const detectInfo = $("detect-info");
const confirmWrap = $("confirm-wrap");
const confirmBox = $<HTMLInputElement>("confirm");
const maskBtn = $<HTMLButtonElement>("mask-btn");
const devicePill = $("device-pill");
const deviceBtn = $<HTMLButtonElement>("device-btn");
const cloudPill = $("cloud-pill");
const taskError = $("task-error");
const taskButtons = [...document.querySelectorAll<HTMLButtonElement>("button.task")];

interface State {
  source: string;
  spans: Span[];
  redaction: Redaction | null;
  /** true when Gemini Nano actually ran for the current text. */
  modelRan: boolean;
}
const state: State = { source: "", spans: [], redaction: null, modelRan: false };

function setPill(el: HTMLElement, text: string, kind: "" | "ok" | "warn" | "cloud" | "local" = ""): void {
  el.textContent = text;
  el.className = `pill ${kind}`.trim();
}

async function refreshStatus(): Promise<void> {
  const status = await deviceStatus();
  const labels = {
    available: ["On-device model: ready", "ok"],
    downloadable: ["On-device model: not downloaded", "warn"],
    downloading: ["On-device model: downloading…", "warn"],
    unavailable: ["On-device model: unavailable in this browser", "warn"],
  } as const;
  setPill(devicePill, labels[status][0], labels[status][1]);
  deviceBtn.hidden = !(firebaseConfigured && (status === "downloadable" || status === "downloading"));
  setPill(
    cloudPill,
    !firebaseConfigured ? "Cloud: not configured" : navigator.onLine ? "Cloud: reachable" : "Cloud: offline",
    firebaseConfigured && navigator.onLine ? "ok" : "warn",
  );
}

function renderPreview(): void {
  preview.replaceChildren();
  const r = state.redaction;
  if (!r) return;
  // Built with DOM nodes + textContent only: pasted text can never become markup.
  let cursor = 0;
  const placeholders = [...r.map.entries()];
  for (const span of r.spans) {
    const original = state.source.slice(span.start, span.end);
    preview.append(state.source.slice(cursor, span.start));
    const mark = document.createElement("mark");
    mark.textContent = placeholders.find(([, v]) => v === original)?.[0] ?? `[${span.type}]`;
    mark.title = `${original} — click to unmask`;
    mark.dataset.source = span.source;
    mark.tabIndex = 0;
    mark.setAttribute("role", "button");
    const unmask = () => {
      state.spans = state.spans.filter((s) => state.source.slice(s.start, s.end) !== original);
      apply();
    };
    mark.addEventListener("click", unmask);
    mark.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        unmask();
      }
    });
    preview.append(mark);
    cursor = span.end;
  }
  preview.append(state.source.slice(cursor));
}

function apply(): void {
  state.redaction = redact(state.source, state.spans);
  renderPreview();
  const n = state.redaction.map.size;
  detectInfo.textContent = state.modelRan
    ? `${n} item(s) masked — rules + Gemini Nano, on this device.`
    : `${n} item(s) masked — rules only. Names, addresses and health details may be missed.`;
  confirmWrap.hidden = state.modelRan;
  confirmBox.checked = false;
  $("results").hidden = true;
  $("payload-wrap").hidden = true;
  taskError.hidden = true;
}

async function mask(): Promise<void> {
  const text = input.value;
  if (!text.trim()) return;
  maskBtn.disabled = true;
  try {
    // Manual spans only survive if the text has not changed.
    const manual = text === state.source ? state.spans.filter((s) => s.source === "manual") : [];
    state.source = text;
    state.spans = [...manual, ...detectWithRules(text)];
    state.modelRan = false;
    apply(); // rule-based result is shown immediately

    detectInfo.textContent = "Rules applied. Asking the on-device model…";
    const result = await detectOnDevice(text, (done, total) => {
      detectInfo.textContent = `On-device model: ${done}/${total} part(s) analysed…`;
    });
    if (input.value !== text) return; // text changed while we were working
    if (result.ran) {
      state.spans.push(...spansFromStrings(text, result.entities));
      state.modelRan = true;
    } else if (result.error) {
      console.info("[RedactFirst] on-device detection skipped:", result.error);
    }
    apply();
  } finally {
    maskBtn.disabled = false;
    void refreshStatus();
  }
}

function maskSelection(): void {
  const { selectionStart: start, selectionEnd: end, value } = input;
  if (start === end) return;
  if (value !== state.source) {
    state.source = value;
    state.spans = detectWithRules(value);
    state.modelRan = false;
  }
  state.spans.push({ start, end, type: "OTHER", source: "manual" });
  apply();
}

async function run(task: TaskId): Promise<void> {
  taskError.hidden = true;
  const fail = (msg: string) => {
    taskError.textContent = msg;
    taskError.hidden = false;
  };
  if (!state.redaction || input.value !== state.source) return fail("Run “Mask personal data” first (the text changed).");
  if (!state.modelRan && !confirmBox.checked) return fail("Confirm that you reviewed the redacted text in step 2.");
  if (!firebaseConfigured) return fail("Firebase is not configured — see README, “Setup”.");

  taskButtons.forEach((b) => (b.disabled = true));
  try {
    const result = await runTask(task, state.redaction.text, $<HTMLInputElement>("custom").value);
    $("raw-out").textContent = result.text;
    $("restored-out").textContent = rehydrate(result.text, state.redaction.map);
    $("payload").textContent = result.payload;
    const pill = $("source-pill");
    if (result.source === "in_cloud") setPill(pill, "ran in the cloud", "cloud");
    else if (result.source === "on_device") setPill(pill, "ran on this device", "local");
    else setPill(pill, "source unknown", "warn");
    $("results").hidden = false;
    $("payload-wrap").hidden = false;
  } catch (err) {
    if (err instanceof LeakError) {
      fail(`${err.message} Mask them in step 1–2: ${err.leaks.map((l) => l.type).join(", ")}.`);
    } else {
      console.error(err);
      fail(err instanceof Error ? err.message : "The request failed.");
    }
  } finally {
    taskButtons.forEach((b) => (b.disabled = false));
  }
}

maskBtn.addEventListener("click", () => void mask());
$("mask-selection-btn").addEventListener("click", maskSelection);
$("sample-btn").addEventListener("click", () => {
  input.value = SAMPLE;
  void mask();
});
taskButtons.forEach((b) => b.addEventListener("click", () => void run(b.dataset.task as TaskId)));
deviceBtn.addEventListener("click", async () => {
  deviceBtn.disabled = true;
  try {
    await downloadDeviceModel((f) => setPill(devicePill, `On-device model: downloading ${Math.round(f * 100)}%`, "warn"));
  } catch (err) {
    console.error(err);
  } finally {
    deviceBtn.disabled = false;
    void refreshStatus();
  }
});
window.addEventListener("online", () => void refreshStatus());
window.addEventListener("offline", () => void refreshStatus());

if (!firebaseConfigured) {
  const note = $("setup-note");
  note.textContent =
    "Demo mode: Firebase is not configured, so only rule-based masking works. Copy .env.example to .env.local and fill it in (see README).";
  note.hidden = false;
}
void refreshStatus();
