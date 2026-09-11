import { afterEach, describe, expect, it, vi } from "vitest";
import type { Model } from "survey-core";
import { connectRoom } from "../../../shared/room";
import type { AppSocket } from "../../../shared/socket";
import type { RoomStatePayload } from "../../../shared/events";

const TWO_PAGE_JSON = {
  pages: [
    { name: "overview", elements: [{ type: "text", name: "projectName" }] },
    { name: "team", elements: [{ type: "text", name: "owner" }] },
  ],
};

/**
 * A socket whose lifecycle the test drives: `connected` is settable and
 * `fire("connect")` stands in for socket.io announcing a (re)connection.
 */
function makeMockSocket(connected: boolean) {
  const emit = vi.fn();
  const handlers = new Map<string, ((payload?: unknown) => void)[]>();

  const socket = {
    get connected() {
      return connected;
    },
    emit: emit,
    on: (event: string, handler: (payload?: unknown) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    off: (event: string, handler: (payload?: unknown) => void) => {
      handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    },
  } as unknown as AppSocket;

  const fire = (event: string, payload?: unknown) =>
    (handlers.get(event) ?? []).slice().forEach((h) => h(payload));

  return {
    socket,
    emit,
    fire,
    setConnected: (value: boolean) => {
      connected = value;
    },
    handlerCount: (event: string) => (handlers.get(event) ?? []).length,
    joins: () => emit.mock.calls.filter((call) => call[0] === "join-room"),
  };
}

const roomState = (): RoomStatePayload => ({
  surveyJson: TWO_PAGE_JSON,
  data: {},
  selfId: "self",
  participants: [],
});

let detach: (() => void) | null = null;
afterEach(() => {
  detach?.();
  detach = null;
  document.body.innerHTML = "";
});

describe("connectRoom: joining", () => {
  it("joins immediately when the socket is already connected", () => {
    const mock = makeMockSocket(true);

    detach = connectRoom({
      socket: mock.socket,
      roomId: "r1",
      name: "Alice",
      onSurvey: () => {},
    });

    expect(mock.joins()).toEqual([["join-room", { roomId: "r1", name: "Alice" }]]);
  });

  it("joins once the connection is established, and not before", () => {
    const mock = makeMockSocket(false);

    detach = connectRoom({
      socket: mock.socket,
      roomId: "r1",
      name: "Alice",
      onSurvey: () => {},
    });
    expect(mock.joins()).toHaveLength(0);

    mock.setConnected(true);
    mock.fire("connect");

    // Exactly one: joining eagerly AND on connect would double up here.
    expect(mock.joins()).toHaveLength(1);
  });

  it("re-joins after a reconnect", () => {
    const mock = makeMockSocket(true);

    detach = connectRoom({
      socket: mock.socket,
      roomId: "r1",
      name: "Alice",
      onSurvey: () => {},
    });
    mock.fire("connect"); // socket.io announces the new connection

    // A reconnect gives the client a NEW socket id and the server tracks room
    // membership per socket — without re-joining it is in no room at all, and
    // both directions of sync stop with nothing said.
    expect(mock.joins()).toHaveLength(2);
  });

  it("stops re-joining after detach", () => {
    const mock = makeMockSocket(true);

    const stop = connectRoom({
      socket: mock.socket,
      roomId: "r1",
      name: "Alice",
      onSurvey: () => {},
    });
    stop();
    mock.fire("connect");

    expect(mock.joins()).toHaveLength(1);
    expect(mock.handlerCount("connect")).toBe(0);
  });
});

describe("connectRoom: re-joining keeps the reader in place", () => {
  it("restores the page the user was on", () => {
    const mock = makeMockSocket(true);
    const models: Model[] = [];

    detach = connectRoom({
      socket: mock.socket,
      roomId: "r1",
      name: "Alice",
      onSurvey: (model) => models.push(model),
    });

    mock.fire("room-state", roomState());
    const first = models[0];
    first.currentPage = first.getPageByName("team");

    // The reconnect: a fresh room-state rebuilds the model from scratch.
    mock.fire("connect");
    mock.fire("room-state", roomState());

    expect(models).toHaveLength(2);
    expect(models[1]).not.toBe(first);
    expect(models[1].currentPage.name).toBe("team");
  });

  it("starts on the first page for a first join", () => {
    const mock = makeMockSocket(true);
    const models: Model[] = [];

    detach = connectRoom({
      socket: mock.socket,
      roomId: "r1",
      name: "Alice",
      onSurvey: (model) => models.push(model),
    });
    mock.fire("room-state", roomState());

    expect(models[0].currentPage.name).toBe("overview");
  });
});
