import { createRoot } from "react-dom/client";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import "survey-core/survey-core.min.css";

/** Frameworks with a client app mounted at /<value>/ by the server. */
const FRAMEWORKS = [
  { value: "react", text: "React", imageLink: "logos/react.svg" },
  { value: "js", text: "JS", imageLink: "logos/js.svg" },
  { value: "vue", text: "Vue", imageLink: "logos/vue.svg" },
  { value: "angular", text: "Angular", imageLink: "logos/angular.svg" },
];

/** Maps SurveyJS question names to the data-testid the e2e suite targets. */
const TESTID_BY_QUESTION: Record<string, string> = {
  name: "name-input",
  room: "room-input",
  surveyJson: "survey-json-input",
};

function randomRoomId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Mirrors the server-side room id rule (see server/src/index.ts). */
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ROOM_DESC_DEFAULT = "If empty, a new room will be created.";

const params = new URLSearchParams(window.location.search);
const presetRoom = params.get("room") ?? "";

const lobby = new Model({
  completeText: "Join",
  // Live value updates so the room-existence check runs while typing.
  textUpdateMode: "onTyping",
  elements: [
    {
      type: "imagepicker",
      name: "framework",
      title: "Choose your framework",
      isRequired: true,
      defaultValue: "react",
      showLabel: true,
      imageFit: "contain",
      imageWidth: 96,
      imageHeight: 96,
      choices: FRAMEWORKS,
    },
    {
      type: "text",
      name: "name",
      title: "Your name",
      description: "If left empty, you will appear as \"Anonymous\".",
    },
    // When joining via a shared link the room is fixed, so we hide the
    // Room and Survey schema inputs (the latter only applies when creating).
    ...(presetRoom
      ? []
      : [
        {
          type: "text",
          name: "room",
          title: "Room ID",
          description: ROOM_DESC_DEFAULT,
          placeholder: "Example: team-42",
          validators: [{
            type: "regex",
            regex: "^[A-Za-z0-9_-]{0,64}$",
            text: "Only letters, digits, - and _ (max 64 chars).",
          }],
        },
        // Shown only once the check below says the typed room doesn't exist:
        // the schema applies exclusively when creating a room.
        {
          type: "comment",
          name: "surveyJson",
          title: "Survey JSON schema",
          description:
            "The room will be created with this schema. If omitted, the default survey is used.",
          placeholder: "Paste a valid SurveyJS JSON schema.",
          rows: 6,
          visible: false,
        },
      ]),
  ],
});
lobby.showCompletedPage = false;

// ---------------------------------------------------------------------------
// Room existence check (mirrors the COLLAB lobby): debounce the typed room id,
// ask the server, and drive the hint text plus the schema block visibility.
// roomExists: true | false | null (unknown — empty/invalid id or check pending).
let roomExists: boolean | null = null;
let checkSeq = 0;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
const roomQ = lobby.getQuestionByName("room");
const seedQ = lobby.getQuestionByName("surveyJson");

function updateForRoomState(): void {
  if (!roomQ) return; // ?room= flow: the fields don't exist
  const id = String(lobby.getValue("room") ?? "").trim();
  if (id === "") {
    roomExists = null;
    roomQ.description = ROOM_DESC_DEFAULT;
    seedQ.visible = false;
    return;
  }
  if (!ROOM_ID_RE.test(id)) {
    roomExists = null;
    roomQ.description = "Only letters, digits, - and _ (max 64 chars).";
    seedQ.visible = false;
    return;
  }
  const seq = ++checkSeq;
  fetch(`api/rooms/${encodeURIComponent(id)}`)
    .then((r) => {
      if (r.status !== 200) return null;
      // A stale server (without GET /api/rooms/:id) lets this request fall
      // into the SPA fallback, which answers 200 text/html — surface that as
      // an error instead of choking on r.json().
      const type = r.headers.get("content-type") ?? "";
      if (!type.includes("application/json")) {
        throw new Error(`GET /api/rooms answered "${type}" — restart the dev server?`);
      }
      return r.json();
    })
    .then((info: { exists?: boolean; participantCount?: number } | null) => {
      if (seq !== checkSeq) return; // a newer check superseded this one
      if (info && info.exists) {
        roomExists = true;
        const n = info.participantCount ?? 0;
        roomQ.description = `Room exists — ${n} participant${n === 1 ? "" : "s"} online. You will join it.`;
        seedQ.visible = false;
      } else {
        roomExists = false;
        roomQ.description = "Room doesn't exist yet — it will be created with the schema below.";
        seedQ.visible = true;
      }
    })
    .catch((err) => {
      if (seq !== checkSeq) return;
      console.warn("[lobby] room check failed:", err);
      roomExists = null;
      roomQ.description = "Can't reach the server.";
    });
}

lobby.onValueChanged.add((_, options) => {
  if (options.name !== "room") return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(updateForRoomState, 300);
});
updateForRoomState();

// Re-expose the data-testid hooks the e2e suite relies on; SurveyJS owns
// the markup, so we tag the rendered inputs after each question renders.
lobby.onAfterRenderQuestion.add((_, opt) => {
  const testid = TESTID_BY_QUESTION[opt.question.name];
  if (!testid) return;
  opt.htmlElement
    .querySelector("input, textarea")
    ?.setAttribute("data-testid", testid);
});
lobby.onAfterRenderSurvey.add((_, opt) => {
  opt.htmlElement
    .querySelector<HTMLElement>(".sd-navigation__complete-btn")
    ?.setAttribute("data-testid", "join-button");
});

// Validate the optional schema JSON before letting the form complete.
lobby.onCompleting.add((sender, opt) => {
  const question = sender.getQuestionByName("surveyJson");
  question?.clearErrors();
  if (!question?.isVisible) return; // hidden block never participates
  const trimmed = String(sender.getValue("surveyJson") ?? "").trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a survey schema JSON object");
    }
  } catch (err) {
    question?.addError(
      `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    opt.allow = false;
  }
});

lobby.onComplete.add(async (sender) => {
  const framework = String(sender.getValue("framework") ?? "react");
  const name = String(sender.getValue("name") ?? "").trim();
  const room = (String(sender.getValue("room") ?? "").trim() || presetRoom).trim();
  // The schema only counts while its block is shown (i.e. the room is known
  // not to exist) — a stale value in the hidden block must not resurface.
  const trimmedJson = seedQ?.isVisible
    ? String(sender.getValue("surveyJson") ?? "").trim()
    : "";
  const finalRoom = room || randomRoomId();

  const enter = (): void => {
    const nameParam = name ? `&name=${encodeURIComponent(name)}` : "";
    window.location.href = `${framework}/?room=${encodeURIComponent(finalRoom)}${nameParam}`;
  };

  if (roomExists === true || !trimmedJson) {
    // No custom schema — the room is created lazily (with the default survey)
    // when the first participant's socket joins.
    enter();
    return;
  }
  // A custom schema must reach the server before we navigate away from the
  // form: clients join by room id only. 409 = room already exists (its schema
  // is fixed at creation) — just join it, matching the old socket semantics.
  try {
    const res = await fetch("api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: finalRoom, surveyJson: JSON.parse(trimmedJson) }),
    });
    if (res.status === 201 || res.status === 409) {
      enter();
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const question = sender.getQuestionByName("room") ?? sender.getQuestionByName("name");
      question?.addError(`Failed to create room: ${body.error ?? `HTTP ${res.status}`}`);
      sender.clear(false, false); // back to the form, keeping the answers
    }
  } catch (err) {
    const question = sender.getQuestionByName("room") ?? sender.getQuestionByName("name");
    question?.addError(`Failed to create room: ${err instanceof Error ? err.message : String(err)}`);
    sender.clear(false, false);
  }
});

// Browser Back from a client can restore this page from the back-forward
// cache with the survey still "completed" (which renders nothing, as
// showCompletedPage is off). Put the form back, keeping the entered answers.
window.addEventListener("pageshow", (ev) => {
  if (ev.persisted && lobby.state === "completed") {
    lobby.clear(false, true);
    // The room may have been created/emptied while we were away.
    updateForRoomState();
  }
});

createRoot(document.getElementById("root")!).render(
  <div style={{ maxWidth: 600, margin: "6vh auto", padding: "0 1rem", fontFamily: "sans-serif" }}>
    <h1>Collaborative Survey</h1>
    <p style={{ color: "#555" }}>
      Pick a framework and join a room — anyone using the same room identifier
      will complete the survey together in real time.
    </p>
    <Survey model={lobby} />
  </div>,
);
