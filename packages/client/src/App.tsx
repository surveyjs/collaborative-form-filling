import { useMemo, useState } from "react";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import "survey-core/survey-core.min.css";
import { createSocket } from "./socket";
import { CollaborativeSurvey } from "./CollaborativeSurvey";

interface Session {
  roomId: string;
  name: string;
  /** Custom SurveyJS schema, applied only if this session creates the room. */
  surveyJson?: object;
}

function randomRoomId(): string {
  // Short, URL-friendly id. Avoids Math.random-free constraints — runs in browser.
  return Math.random().toString(36).slice(2, 8);
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const socket = useMemo(() => createSocket(), []);

  if (session) {
    return (
      <CollaborativeSurvey
        socket={socket}
        roomId={session.roomId}
        name={session.name}
        surveyJson={session.surveyJson}
      />
    );
  }

  return <JoinForm onJoin={setSession} />;
}

/** Maps SurveyJS question names to the data-testid the e2e suite targets. */
const TESTID_BY_QUESTION: Record<string, string> = {
  name: "name-input",
  room: "room-input",
  surveyJson: "survey-json-input",
};

function JoinForm({ onJoin }: { onJoin: (s: Session) => void }) {
  const survey = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const presetRoom = params.get("room") ?? "";

    const model = new Model({
      completeText: "Join",
      elements: [
        {
          type: "text",
          name: "name",
          title: "Your name",
          description: "If left empty, you will appear as \"Anonymous\"."
        },
        // When joining via a shared link the room is fixed, so we hide the
        // Room and Survey schema inputs (the latter only applies when creating).
        ...(presetRoom
          ? []
          : [
            {
              type: "text",
              name: "room",
              title: "Room (leave empty to create a new one)",
              placeholder: "e.g., team-42",
              defaultValue: presetRoom,
            },
            {
              type: "comment",
              name: "surveyJson",
              title: "Survey schema (SurveyJS JSON) — optional",
              description:
                "Applied only when creating a new room. If empty, the default survey is used.",
              placeholder:
                '{"pages":[{"name":"page1","elements":[{"type":"text","name":"q1","title":"Question"}]}]}',
              rows: 6,
            },
          ]),
        {
          type: "text",
          name: "room",
          title: "Room ID",
          description: "If empty, a new room will be created.",
          placeholder: "Example: team-42",
          defaultValue: params.get("room") ?? "",
        },
        {
          type: "comment",
          name: "surveyJson",
          title: "Survey JSON schema",
          description:
            "Used only when creating a new room. If omitted, the default survey is used.",
          placeholder: "Paste a valid SurveyJS JSON schema.",
          rows: 6,
        },
      ],
    });

    // Re-expose the data-testid hooks the e2e suite relies on; SurveyJS owns
    // the markup, so we tag the rendered inputs after each question renders.
    model.onAfterRenderQuestion.add((_, opt) => {
      const testid = TESTID_BY_QUESTION[opt.question.name];
      if (!testid) return;
      opt.htmlElement
        .querySelector("input, textarea")
        ?.setAttribute("data-testid", testid);
    });
    model.onAfterRenderSurvey.add((_, opt) => {
      opt.htmlElement
        .querySelector<HTMLElement>(".sd-navigation__complete-btn")
        ?.setAttribute("data-testid", "join-button");
    });

    // Validate the optional schema JSON before letting the form complete.
    model.onCompleting.add((sender, opt) => {
      const question = sender.getQuestionByName("surveyJson");
      question?.clearErrors();
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

    model.onComplete.add((sender) => {
      const name = String(sender.getValue("name") ?? "").trim();
      const room = (String(sender.getValue("room") ?? "").trim() || presetRoom).trim();
      const trimmedJson = String(sender.getValue("surveyJson") ?? "").trim();
      const surveyJson = trimmedJson ? (JSON.parse(trimmedJson) as object) : undefined;

      const finalRoom = room || randomRoomId();
      const url = new URL(window.location.href);
      url.searchParams.set("room", finalRoom);
      window.history.replaceState({}, "", url);
      onJoin({ roomId: finalRoom, name: name || "Anonymous", surveyJson });
    });

    return model;
  }, [onJoin]);

  return (
    <div style={{ maxWidth: 600, margin: "10vh auto", padding: "0 1rem", fontFamily: "sans-serif" }}>
      <h1>Collaborative Survey</h1>
      <p style={{ color: "#555" }}>
        Join a room — anyone using the same room identifier will complete the survey together in real time.
      </p>
      <Survey model={survey} />
    </div>
  );
}
