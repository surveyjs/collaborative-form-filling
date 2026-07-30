import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "survey-core";
import {
  attachPresence,
  BLUR_DEBOUNCE_MS,
  CURSOR_BUFFER_MS,
  CURSOR_IDLE_MS,
  MOUSE_THROTTLE_MS,
  pageKey,
  resolvePage,
  type PresenceSocket,
} from "../../../shared/presenceSync";
import type { Participant } from "../../../shared/events";

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
  const handle = attachPresence({
    survey,
    socket: mock.socket,
    roomId: "r1",
    selfId: "self-id",
    initialParticipants: PEERS,
    getParticipant: (id) => PEERS.find((p) => p.id === id),
    ...overrides,
  });
  return { survey, detach: handle.detach, goToParticipant: handle.goToParticipant, ...mock };
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

    it("throttles mousemove into a single trailing packet carrying the sampled path", () => {
      const { emit, projectName } = { ...attach(), ...setupDomRefs() };

      moveMouse(projectName, 150, 225);
      moveMouse(projectName, 200, 250);
      expect(emitsOf(emit, "cursor-moved")).toEqual([]);

      vi.advanceTimersByTime(MOUSE_THROTTLE_MS);

      expect(emitsOf(emit, "cursor-moved")).toEqual([
        {
          roomId: "r1",
          name: "projectName",
          points: [
            { x: 0.125, y: 0.25, t: 0 },
            { x: 0.25, y: 0.5, t: 0 },
          ],
        },
      ]);
    });

    it("downsamples a busy window to at most 3 points with time offsets", () => {
      const { emit, projectName } = { ...attach(), ...setupDomRefs() };

      moveMouse(projectName, 150, 225); // t=0 (first)
      vi.advanceTimersByTime(10);
      moveMouse(projectName, 200, 225); // t=10 (mid of 4 samples)
      vi.advanceTimersByTime(10);
      moveMouse(projectName, 250, 225); // t=20 — dropped
      vi.advanceTimersByTime(10);
      moveMouse(projectName, 300, 225); // t=30 (last)
      vi.advanceTimersByTime(MOUSE_THROTTLE_MS - 30);

      expect(emitsOf(emit, "cursor-moved")).toEqual([
        {
          roomId: "r1",
          name: "projectName",
          points: [
            { x: 0.125, y: 0.25, t: 0 },
            { x: 0.25, y: 0.25, t: 10 },
            { x: 0.5, y: 0.25, t: 30 },
          ],
        },
      ]);
    });

    it("anchors to the nearest question when the pointer is not over one", () => {
      const { emit } = attach();

      // (50, 50) is above/left of projectName (rect 100,200 400x100) — the
      // nearest question; fractions extrapolate outside 0..1.
      moveMouse(document.body, 50, 50);
      vi.advanceTimersByTime(MOUSE_THROTTLE_MS);

      expect(emitsOf(emit, "cursor-moved")).toEqual([
        { roomId: "r1", name: "projectName", points: [{ x: -0.125, y: -1.5, t: 0 }] },
      ]);
    });

    it("picks the geometrically nearest question in the gap between two", () => {
      const { emit } = attach();

      // (300, 315) sits between projectName (bottom 300, distance 15) and
      // owner (top 320, distance 5) — owner wins.
      moveMouse(document.body, 300, 315);
      vi.advanceTimersByTime(MOUSE_THROTTLE_MS);

      expect(emitsOf(emit, "cursor-moved")).toEqual([
        { roomId: "r1", name: "owner", points: [{ x: 0.5, y: -0.05, t: 0 }] },
      ]);
    });

    it("sends a hide (name: null) when no question is rendered at all", () => {
      document.body.innerHTML = ""; // e.g. completion page
      const { emit } = attach();

      moveMouse(document.body, 5, 5);
      vi.advanceTimersByTime(MOUSE_THROTTLE_MS);

      expect(emitsOf(emit, "cursor-moved")).toEqual([{ roomId: "r1", name: null, points: [] }]);
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

      receive("cursor-moved", {
        id: "peer-1",
        name: "projectName",
        points: [{ x: 0.5, y: 0.5, t: 0 }],
      });

      const cursor = document.querySelector<HTMLElement>(".collab-cursor")!;
      expect(cursor.style.display).toBe("block");
      expect(cursor.style.left).toBe("300px"); // 100 + 0.5 * 400
      expect(cursor.style.top).toBe("250px"); // 200 + 0.5 * 100
      const label = document.querySelector<HTMLElement>(".collab-cursor-name")!;
      expect(label.textContent).toBe("Bob");
    });

    it("extrapolates the remote cursor outside the anchor rect for out-of-range fractions", () => {
      const { receive } = attach();

      receive("cursor-moved", {
        id: "peer-1",
        name: "projectName",
        points: [{ x: -0.125, y: -1.5, t: 0 }],
      });

      const cursor = document.querySelector<HTMLElement>(".collab-cursor")!;
      expect(cursor.style.display).toBe("block");
      expect(cursor.style.left).toBe("50px"); // 100 + (-0.125) * 400
      expect(cursor.style.top).toBe("50px"); // 200 + (-1.5) * 100
    });

    it("replays a multi-point path and settles on its last point", () => {
      // Force the raf helper onto its setTimeout fallback so fake timers
      // drive the replay animation frames.
      vi.stubGlobal("requestAnimationFrame", undefined);
      try {
        const { receive } = attach();

        receive("cursor-moved", {
          id: "peer-1",
          name: "projectName",
          points: [
            { x: 0, y: 0, t: 0 },
            { x: 1, y: 1, t: 40 },
          ],
        });

        // The replay starts at the first sample...
        const cursor = document.querySelector<HTMLElement>(".collab-cursor")!;
        expect(cursor.style.display).toBe("block");
        expect(cursor.style.left).toBe("100px");
        expect(cursor.style.top).toBe("200px");

        // ...and holds the last one once the buffered clock passes it.
        vi.advanceTimersByTime(CURSOR_BUFFER_MS + 100);
        expect(cursor.style.left).toBe("500px"); // 100 + 1 * 400
        expect(cursor.style.top).toBe("300px"); // 200 + 1 * 100
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("hides the cursor on a null anchor", () => {
      const { receive } = attach();
      receive("cursor-moved", {
        id: "peer-1",
        name: "projectName",
        points: [{ x: 0.5, y: 0.5, t: 0 }],
      });

      receive("cursor-moved", { id: "peer-1", name: null, points: [] });

      expect(document.querySelector<HTMLElement>(".collab-cursor")!.style.display).toBe("none");
    });

    it("clears everything for a peer that left", () => {
      const { receive } = attach();
      receive("focus-question", { id: "peer-1", name: "projectName" });
      receive("cursor-moved", {
        id: "peer-1",
        name: "projectName",
        points: [{ x: 0.5, y: 0.5, t: 0 }],
      });

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

      // No further emits after detach (attach itself announced the page).
      emit.mockClear();
      survey.onFocusInQuestion.fire(survey, {
        question: survey.getQuestionByName("owner"),
      } as never);
      survey.currentPage = survey.pages[0];
      document
        .querySelector('[data-name="projectName"]')!
        .dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 200, clientY: 250 }));
      vi.advanceTimersByTime(MOUSE_THROTTLE_MS * 2);
      expect(emit).not.toHaveBeenCalled();
    });
  });

  const MULTIPAGE_JSON = {
    pages: [
      {
        name: "overview",
        elements: [
          { type: "text", name: "projectName" },
          { type: "text", name: "owner" },
        ],
      },
      {
        name: "team",
        elements: [
          { type: "text", name: "members" },
          { type: "text", name: "secret", visible: false },
        ],
      },
    ],
  };

  function attachMultipage(overrides: Partial<Parameters<typeof attachPresence>[0]> = {}) {
    const survey = new Model(MULTIPAGE_JSON);
    const mock = makeMockSocket();
    const handle = attachPresence({
      survey,
      socket: mock.socket,
      roomId: "r1",
      selfId: "self-id",
      initialParticipants: PEERS,
      getParticipant: (id) => PEERS.find((p) => p.id === id),
      ...overrides,
    });
    return { survey, detach: handle.detach, goToParticipant: handle.goToParticipant, ...mock };
  }

  /** Adds a question node for the second page and spies on its scroll. */
  function addMembersNode() {
    const node = document.createElement("div");
    node.setAttribute("data-name", "members");
    document.querySelector("main")!.appendChild(node);
    const scrollIntoView = vi.fn();
    node.scrollIntoView = scrollIntoView; // jsdom lacks a runtime implementation
    return { node, scrollIntoView };
  }

  describe("outgoing page", () => {
    it("announces the initial page on attach and page changes after, deduped", () => {
      const { survey, emit } = attachMultipage();

      expect(emitsOf(emit, "page-changed")).toEqual([{ roomId: "r1", name: "overview" }]);

      survey.currentPage = survey.getPageByName("team");
      survey.currentPage = survey.getPageByName("team");

      expect(emitsOf(emit, "page-changed")).toEqual([
        { roomId: "r1", name: "overview" },
        { roomId: "r1", name: "team" },
      ]);
    });
  });

  describe("pageKey / resolvePage", () => {
    it("round-trips every page and resolves #index keys", () => {
      const survey = new Model(MULTIPAGE_JSON);
      for (const page of survey.pages) {
        expect(resolvePage(survey, pageKey(survey, page))).toBe(page);
      }
      expect(resolvePage(survey, "#1")).toBe(survey.pages[1]);
      expect(resolvePage(survey, "ghost")).toBeNull();
      expect(resolvePage(survey, "#42")).toBeNull();
    });
  });

  describe("goToParticipant", () => {
    it("switches to the page of the peer's focused question and scrolls to it", () => {
      const { survey, receive, goToParticipant } = attachMultipage();
      const { scrollIntoView } = addMembersNode();
      receive("focus-question", { id: "peer-1", name: "members" });

      goToParticipant("peer-1");

      expect(survey.currentPage.name).toBe("team");
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    });

    it("falls back to the question under the peer's fresh cursor without focus", () => {
      const { survey, receive, goToParticipant } = attachMultipage();
      const { scrollIntoView } = addMembersNode();
      receive("cursor-moved", {
        id: "peer-1",
        name: "members",
        points: [{ x: 0.5, y: 0.5, t: 0 }],
      });

      goToParticipant("peer-1");

      expect(survey.currentPage.name).toBe("team");
      expect(scrollIntoView).toHaveBeenCalled();
    });

    it("ignores a stale cursor and switches to the peer's page without scrolling", () => {
      const { survey, receive, goToParticipant } = attachMultipage();
      const { scrollIntoView } = addMembersNode();
      receive("cursor-moved", {
        id: "peer-1",
        name: "members",
        points: [{ x: 0.5, y: 0.5, t: 0 }],
      });
      receive("page-changed", { id: "peer-1", name: "team" });
      vi.advanceTimersByTime(CURSOR_IDLE_MS + 1000);

      goToParticipant("peer-1");

      expect(survey.currentPage.name).toBe("team");
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("falls back to the peer's page when their focused question is hidden", () => {
      const { survey, receive, goToParticipant } = attachMultipage();
      receive("focus-question", { id: "peer-1", name: "secret" }); // visible: false
      receive("page-changed", { id: "peer-1", name: "team" });

      goToParticipant("peer-1");

      expect(survey.currentPage.name).toBe("team");
    });

    it("uses the page seeded from initialParticipants (late join)", () => {
      const { survey, goToParticipant } = attachMultipage({
        initialParticipants: [PEERS[0], { ...PEERS[1], page: "team" }],
      });

      goToParticipant("peer-1");

      expect(survey.currentPage.name).toBe("team");
    });

    it("is a no-op for unknown peers and peers without any location", () => {
      const { survey, receive, goToParticipant } = attachMultipage();
      receive("focus-question", { id: "peer-1", name: null });

      expect(() => goToParticipant("ghost")).not.toThrow();
      expect(() => goToParticipant("peer-1")).not.toThrow();
      expect(survey.currentPage.name).toBe("overview");
    });

    it("force-renders the target row on lazy-rendering surveys", () => {
      const survey = new Model(MULTIPAGE_JSON);
      survey.lazyRenderEnabled = true;
      const { receive, goToParticipant } = attachMultipage({ survey });
      const page = survey.getPageByName("team")!;
      const forceRender = vi.spyOn(page, "forceRenderElement");
      receive("focus-question", { id: "peer-1", name: "members" });

      goToParticipant("peer-1");

      expect(survey.currentPage.name).toBe("team");
      expect(forceRender).toHaveBeenCalledWith(survey.getQuestionByName("members"));
    });

    it("keeps polling for the question node until the page has rendered", () => {
      // Force the raf helper onto its setTimeout fallback (fake timers don't
      // drive jsdom's real requestAnimationFrame).
      vi.stubGlobal("requestAnimationFrame", undefined);
      try {
        const { survey, receive, goToParticipant } = attachMultipage();
        receive("focus-question", { id: "peer-1", name: "members" });

        goToParticipant("peer-1");
        expect(survey.currentPage.name).toBe("team");

        // Node appears a couple of ticks later, as after a real page re-render.
        vi.advanceTimersByTime(40);
        const { scrollIntoView } = addMembersNode();
        vi.advanceTimersByTime(40);

        expect(scrollIntoView).toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
