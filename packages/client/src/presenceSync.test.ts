import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "survey-core";
import {
  attachPresence,
  BLUR_DEBOUNCE_MS,
  MOUSE_THROTTLE_MS,
  type PresenceSocket,
} from "./presenceSync";
import type { Participant } from "../../shared/events";

const SURVEY_JSON = {
  elements: [
    { type: "text", name: "projectName" },
    { type: "text", name: "owner" },
  ],
};

const PEERS: Participant[] = [
  { id: "self-id", name: "Me", color: "#e6194b" },
  { id: "peer-1", name: "Bob", color: "#3cb44b" },
];

/** A mock socket capturing emits and letting tests drive incoming events. */
function makeMockSocket() {
  const emit = vi.fn();
  const handlers = new Map<string, ((p: unknown) => void)[]>();

  const socket: PresenceSocket = {
    emit: emit as PresenceSocket["emit"],
    on: ((event: string, handler: (p: unknown) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }) as PresenceSocket["on"],
    off: ((event: string, handler: (p: unknown) => void) => {
      handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    }) as PresenceSocket["off"],
    // no `volatile` — attachPresence must fall back to plain emit
  };

  const receive = (event: string, payload: unknown) =>
    (handlers.get(event) ?? []).forEach((h) => h(payload));
  const handlerCount = () => [...handlers.values()].reduce((n, l) => n + l.length, 0);

  return { socket, emit, receive, handlerCount };
}

/** Emits of a single event, unwrapped to their payloads. */
function emitsOf(emit: ReturnType<typeof vi.fn>, event: string) {
  return emit.mock.calls.filter((c) => c[0] === event).map((c) => c[1]);
}

function stubRect(el: Element, rect: { left: number; top: number; width: number; height: number }) {
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function setupDom() {
  document.body.innerHTML =
    '<main>' +
    '<div data-name="projectName"><input id="pn-input" /></div>' +
    '<div data-name="owner"><input id="ow-input" /></div>' +
    "</main>";
  const projectName = document.querySelector('[data-name="projectName"]')!;
  const owner = document.querySelector('[data-name="owner"]')!;
  stubRect(projectName, { left: 100, top: 200, width: 400, height: 100 });
  stubRect(owner, { left: 100, top: 320, width: 400, height: 100 });
  return { projectName, owner };
}

function attach(overrides: Partial<Parameters<typeof attachPresence>[0]> = {}) {
  const survey = new Model(SURVEY_JSON);
  const mock = makeMockSocket();
  const detach = attachPresence({
    survey,
    socket: mock.socket,
    roomId: "r1",
    selfId: "self-id",
    initialParticipants: PEERS,
    getParticipant: (id) => PEERS.find((p) => p.id === id),
    ...overrides,
  });
  return { survey, detach, ...mock };
}

describe("attachPresence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupDom();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  describe("outgoing focus", () => {
    it("emits focus-question on onFocusInQuestion and dedupes repeats", () => {
      const { survey, emit } = attach();
      const question = survey.getQuestionByName("projectName");

      survey.onFocusInQuestion.fire(survey, { question } as never);
      survey.onFocusInQuestion.fire(survey, { question } as never);

      expect(emitsOf(emit, "focus-question")).toEqual([{ roomId: "r1", name: "projectName" }]);
    });

    it("reports the top-level question for nested (composite/matrix cell) questions", () => {
      const { survey, emit } = attach();
      const nested = { name: "cell", parentQuestion: { name: "projectName" } };

      survey.onFocusInQuestion.fire(survey, { question: nested } as never);

      expect(emitsOf(emit, "focus-question")).toEqual([{ roomId: "r1", name: "projectName" }]);
    });

    it("emits a null focus after a debounced focusout inside a question", () => {
      const { survey, emit } = attach();
      survey.onFocusInQuestion.fire(survey, {
        question: survey.getQuestionByName("projectName"),
      } as never);

      document
        .getElementById("pn-input")!
        .dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      vi.advanceTimersByTime(BLUR_DEBOUNCE_MS);

      expect(emitsOf(emit, "focus-question")).toEqual([
        { roomId: "r1", name: "projectName" },
        { roomId: "r1", name: null },
      ]);
    });

    it("cancels the pending blur when focus returns to a question in time", () => {
      const { survey, emit } = attach();
      survey.onFocusInQuestion.fire(survey, {
        question: survey.getQuestionByName("projectName"),
      } as never);

      document
        .getElementById("pn-input")!
        .dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      vi.advanceTimersByTime(BLUR_DEBOUNCE_MS / 2);
      document
        .getElementById("ow-input")!
        .dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      vi.advanceTimersByTime(BLUR_DEBOUNCE_MS);

      expect(emitsOf(emit, "focus-question")).toEqual([{ roomId: "r1", name: "projectName" }]);
    });

    it("ignores focusout happening outside any question", () => {
      const { emit } = attach();

      document.body.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      vi.advanceTimersByTime(BLUR_DEBOUNCE_MS);

      expect(emitsOf(emit, "focus-question")).toEqual([]);
    });
  });

  describe("outgoing cursor", () => {
    const moveMouse = (target: Element | Document, clientX: number, clientY: number) =>
      target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX, clientY }));

    it("throttles mousemove to a single trailing emit with fractional coords", () => {
      const { emit, projectName } = { ...attach(), ...setupDomRefs() };

      moveMouse(projectName, 150, 225);
      moveMouse(projectName, 200, 250); // last one within the window wins
      expect(emitsOf(emit, "cursor-moved")).toEqual([]);

      vi.advanceTimersByTime(MOUSE_THROTTLE_MS);

      expect(emitsOf(emit, "cursor-moved")).toEqual([
        { roomId: "r1", name: "projectName", x: 0.25, y: 0.5 },
      ]);
    });

    it("sends a hide (name: null) when the pointer is not over a question", () => {
      const { emit } = attach();

      moveMouse(document.body, 5, 5);
      vi.advanceTimersByTime(MOUSE_THROTTLE_MS);

      expect(emitsOf(emit, "cursor-moved")).toEqual([{ roomId: "r1", name: null, x: 0, y: 0 }]);
    });

    it("does not resend an identical position", () => {
      const { emit, projectName } = { ...attach(), ...setupDomRefs() };

      moveMouse(projectName, 200, 250);
      vi.advanceTimersByTime(MOUSE_THROTTLE_MS);
      moveMouse(projectName, 200, 250);
      vi.advanceTimersByTime(MOUSE_THROTTLE_MS);

      expect(emitsOf(emit, "cursor-moved")).toHaveLength(1);
    });

    function setupDomRefs() {
      return { projectName: document.querySelector('[data-name="projectName"]')! };
    }
  });

  describe("incoming presence rendering", () => {
    it("decorates the focused question and shows a name badge", () => {
      const { receive } = attach();

      receive("focus-question", { id: "peer-1", name: "projectName" });

      const node = document.querySelector<HTMLElement>('[data-name="projectName"]')!;
      expect(node.getAttribute("data-collab-focus")).toBe("on");
      expect(node.style.getPropertyValue("--collab-peer-color")).toBe("#3cb44b");

      const badge = document.querySelector<HTMLElement>(".collab-focus-badge")!;
      expect(badge.textContent).toBe("Bob");
      expect(badge.style.display).toBe("block");
    });

    it("removes the decoration when the peer blurs", () => {
      const { receive } = attach();
      receive("focus-question", { id: "peer-1", name: "projectName" });

      receive("focus-question", { id: "peer-1", name: null });

      const node = document.querySelector<HTMLElement>('[data-name="projectName"]')!;
      expect(node.hasAttribute("data-collab-focus")).toBe(false);
      expect(document.querySelector<HTMLElement>(".collab-focus-badge")!.style.display).toBe(
        "none",
      );
    });

    it("positions the remote cursor within the anchored question rect", () => {
      const { receive } = attach();

      receive("cursor-moved", { id: "peer-1", name: "projectName", x: 0.5, y: 0.5 });

      const cursor = document.querySelector<HTMLElement>(".collab-cursor")!;
      expect(cursor.style.display).toBe("block");
      expect(cursor.style.left).toBe("300px"); // 100 + 0.5 * 400
      expect(cursor.style.top).toBe("250px"); // 200 + 0.5 * 100
      const label = document.querySelector<HTMLElement>(".collab-cursor-name")!;
      expect(label.textContent).toBe("Bob");
    });

    it("hides the cursor on a null anchor", () => {
      const { receive } = attach();
      receive("cursor-moved", { id: "peer-1", name: "projectName", x: 0.5, y: 0.5 });

      receive("cursor-moved", { id: "peer-1", name: null, x: 0, y: 0 });

      expect(document.querySelector<HTMLElement>(".collab-cursor")!.style.display).toBe("none");
    });

    it("clears everything for a peer that left", () => {
      const { receive } = attach();
      receive("focus-question", { id: "peer-1", name: "projectName" });
      receive("cursor-moved", { id: "peer-1", name: "projectName", x: 0.5, y: 0.5 });

      receive("participant-left", { id: "peer-1" });

      const node = document.querySelector<HTMLElement>('[data-name="projectName"]')!;
      expect(node.hasAttribute("data-collab-focus")).toBe(false);
      expect(document.querySelector(".collab-cursor")).toBeNull();
      expect(document.querySelector(".collab-focus-badge")).toBeNull();
    });

    it("seeds remote focus from initialParticipants and skips self", () => {
      attach({
        initialParticipants: [
          { ...PEERS[0], focus: "owner" }, // self — must be ignored
          { ...PEERS[1], focus: "projectName" },
        ],
      });

      expect(
        document
          .querySelector<HTMLElement>('[data-name="projectName"]')!
          .getAttribute("data-collab-focus"),
      ).toBe("on");
      expect(
        document.querySelector<HTMLElement>('[data-name="owner"]')!.hasAttribute("data-collab-focus"),
      ).toBe(false);
    });
  });

  describe("detach", () => {
    it("removes listeners, decorations and the overlay layer", () => {
      const { survey, detach, emit, receive, handlerCount } = attach();
      receive("focus-question", { id: "peer-1", name: "projectName" });

      detach();

      expect(handlerCount()).toBe(0);
      expect(document.querySelector(".collab-presence-layer")).toBeNull();
      expect(
        document
          .querySelector<HTMLElement>('[data-name="projectName"]')!
          .hasAttribute("data-collab-focus"),
      ).toBe(false);

      // No further emits after detach.
      survey.onFocusInQuestion.fire(survey, {
        question: survey.getQuestionByName("owner"),
      } as never);
      document
        .querySelector('[data-name="projectName"]')!
        .dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 200, clientY: 250 }));
      vi.advanceTimersByTime(MOUSE_THROTTLE_MS * 2);
      expect(emit).not.toHaveBeenCalled();
    });
  });
});
