/**
 * Framework-agnostic collaboration wiring: survey-core's CollaborationPlugin <-> WebSocket.
 *
 * This module has ZERO runtime imports on purpose. It is compiled independently by five
 * differently-built apps (Vite x4 + the Angular CLI); importing "survey-core" from here
 * would resolve to a SECOND copy of the library and break survey-core's Serializer
 * singleton. Instead the caller builds the model and the plugin from ITS OWN dependency
 * copy and injects them through `createSurvey` (structural typing below). Type-only
 * imports are fine - they are erased at build.
 *
 * The plugin's message vocabulary is deliberately the same as the wire protocol's
 * (see PROTOCOL.md), so frames are forwarded in both directions without translation.
 * The one local step is building the Model from the schema, which is not the plugin's
 * concern and happens exactly once.
 */

/** Structural mirror of survey-core's EventBase - only what is used here. */
export interface ICollabEvent {
  add(handler: (sender: unknown, options: { message: any }) => void): void;
  remove(handler: (sender: unknown, options: { message: any }) => void): void;
}

/** The plugin surface this module uses: events out, methods in. */
export interface ICollabPluginLike {
  onEvent: ICollabEvent;
  apply(message: any): void;
  dispose(): void;
}

export type CollabStatus = "connecting" | "connected" | "reconnecting" | "closed";

export interface ICollabOptions {
  roomId: string;
  /** Display name; the server sanitizes it and stamps it onto every relayed envelope. */
  name?: string;
  /** Override the WS origin, e.g. "ws://localhost:3001". Default: same origin. */
  wsBase?: string;
  /**
   * Called exactly once, on the FIRST init: build the Model from `seed`, create and wire
   * the plugin, render. Later inits (reconnects) reuse it - which is why a reconnect no
   * longer throws the reader back to page one.
   */
  createSurvey: (seed: any) => ICollabPluginLike;
  onStatus?: (status: CollabStatus) => void;
  /**
   * A reconnect into a room whose schema changed: the room was reclaimed while we were
   * away and re-created by someone else. There is nothing sane to patch.
   * Default: location.reload().
   */
  onSeedChanged?: () => void;
  retry?: { minMs?: number; maxMs?: number };
}

export interface ICollabConnection {
  dispose(): void;
}

/**
 * Beyond this many queued bytes the socket is congested and an ephemeral presence frame
 * is skipped rather than queued - the send side of the same rule the relay applies when
 * fanning out. Every cursor packet is a self-contained path segment, so a gap is
 * invisible; a backlog of stale positions would not be.
 */
const CURSOR_DROP_BYTES = 64 * 1024;

export function connectCollab(opts: ICollabOptions): ICollabConnection {
  let plugin: ICollabPluginLike | null = null;
  let seedJson: string | null = null;
  let ws: WebSocket | null = null;
  let disposed = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const base = opts.wsBase ?? `${proto}//${location.host}`;
  const name = opts.name ?? getDisplayName();

  const setStatus = (status: CollabStatus) => opts.onStatus?.(status);

  const onOutgoing = (_sender: unknown, options: { message: any }) => {
    const message = options.message;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // The only decision this module makes about a message is transport-level.
    if (message.type === "presence" && message.retain === false && ws.bufferedAmount > CURSOR_DROP_BYTES) return;
    ws.send(JSON.stringify(message));
  };

  const onMessage = (event: MessageEvent) => {
    let msg: any;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "init") {
      const incoming = JSON.stringify(msg.seed ?? {});
      if (!plugin) {
        seedJson = incoming;
        plugin = opts.createSurvey(msg.seed ?? {});
        plugin.onEvent.add(onOutgoing);
      } else if (incoming !== seedJson) {
        (opts.onSeedChanged ?? (() => location.reload()))();
        return;
      }
      attempt = 0;
      setStatus("connected");
    }
    // Everything, init included, is forwarded verbatim: the plugin reads the fields it
    // owns and ignores the rest.
    plugin?.apply(msg);
  };

  const onClose = () => {
    if (ws) {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws = null;
    }
    // Clears the roster too, so no peer cursor stays frozen on screen.
    plugin?.apply({ type: "status", status: "closed" });
    if (disposed) {
      setStatus("closed");
      return;
    }
    setStatus("reconnecting");
    // socket.io gave reconnection for free; raw ws does not.
    const min = opts.retry?.minMs ?? 250;
    const max = opts.retry?.maxMs ?? 8000;
    const delay = Math.min(max, min * Math.pow(2, attempt)) * (0.7 + Math.random() * 0.6);
    attempt += 1;
    retryTimer = setTimeout(open, delay);
  };

  function open(): void {
    if (disposed) return;
    setStatus(attempt === 0 ? "connecting" : "reconnecting");
    plugin?.apply({ type: "status", status: "connecting" });
    ws = new WebSocket(`${base}/ws/rooms/${encodeURIComponent(opts.roomId)}?name=${encodeURIComponent(name)}`);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  }

  // A browser coming back online should not sit out the remaining backoff.
  const onOnline = () => {
    if (disposed || !!ws) return;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    attempt = 0;
    open();
  };
  addEventListener("online", onOnline);

  open();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      removeEventListener("online", onOnline);
      plugin?.onEvent.remove(onOutgoing);
      plugin?.dispose();
      plugin = null;
      if (!!ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
      setStatus("closed");
    },
  };
}

/** Room/name from the URL the lobby navigated to: /<fw>/?room=<id>&name=<n>. */
export function getRoomFromUrl(): { roomId: string; name: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    roomId: (params.get("room") ?? "").trim(),
    name: (params.get("name") ?? "").trim() || "Anonymous",
  };
}

/** Shareable lobby URL that pre-fills the join form with this room. */
export function lobbyJoinUrl(roomId: string): string {
  const url = new URL("../", window.location.href);
  url.searchParams.set("room", roomId);
  return url.toString();
}

/** Counts code points, so a trim never leaves a lone surrogate behind. */
function truncateName(s: string): string {
  return Array.from(s).slice(0, 32).join("");
}

export function getDisplayName(): string {
  const fromUrl = truncateName((new URLSearchParams(location.search).get("name") ?? "").trim());
  return fromUrl || "Anonymous";
}
