import type { Model } from "survey-core";
import type {
  CursorBroadcastPayload,
  CursorPayload,
  FocusBroadcastPayload,
  FocusPayload,
  Participant,
} from "../../shared/events";
import "./presenceSync.css";

/** Mouse updates are throttled to this interval (trailing edge). */
export const MOUSE_THROTTLE_MS = 50;
/** How long after a focusout before the focus is reported as cleared. */
export const BLUR_DEBOUNCE_MS = 300;
/** Safety repaint interval for DOM changes no observer caught. */
export const FALLBACK_TICK_MS = 500;
/** Remote cursors fade out after this much time without movement. */
export const CURSOR_IDLE_MS = 30_000;
/** Gap between the focus ring (2px box-shadow) and the name badge above it. */
const BADGE_GAP_PX = 6;

/**
 * Minimal transport surface presence needs. The real socket.io-client `Socket`
 * satisfies this; tests pass a mock (which may omit `volatile`).
 */
export interface PresenceSocket {
  emit(event: "focus-question", payload: FocusPayload): void;
  emit(event: "cursor-moved", payload: CursorPayload): void;
  on(event: "focus-question", handler: (payload: FocusBroadcastPayload) => void): void;
  on(event: "cursor-moved", handler: (payload: CursorBroadcastPayload) => void): void;
  on(event: "participant-left", handler: (payload: { id: string }) => void): void;
  off(event: "focus-question", handler: (payload: FocusBroadcastPayload) => void): void;
  off(event: "cursor-moved", handler: (payload: CursorBroadcastPayload) => void): void;
  off(event: "participant-left", handler: (payload: { id: string }) => void): void;
  /** socket.io volatile modifier — cursor packets may be dropped, never queued */
  volatile?: { emit(event: "cursor-moved", payload: CursorPayload): void };
}

export interface AttachPresenceOptions {
  survey: Model;
  socket: PresenceSocket;
  roomId: string;
  /** own participant id — used to skip self when seeding from the roster */
  selfId: string;
  /** roster snapshot from `room-state`; seeds remote focus for late joiners */
  initialParticipants: Participant[];
  /** live roster lookup for peer name/color (kept in React state) */
  getParticipant: (id: string) => Participant | undefined;
}

interface PeerState {
  focus: string | null;
  cursor: { name: string; x: number; y: number } | null;
  /** timestamp of the last cursor update, for the idle fade */
  cursorAt: number;
}

interface PeerArtifacts {
  cursor: HTMLElement;
  cursorName: HTMLElement;
  badge: HTMLElement;
}

const CURSOR_SVG =
  '<svg width="16" height="18" viewBox="0 0 16 18" style="display:block">' +
  '<path d="M1 1 L1 14 L4.5 10.8 L7 16.5 L9.3 15.5 L6.8 9.9 L11.5 9.6 Z" ' +
  'stroke="#fff" stroke-width="1"/></svg>';

const round3 = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;

/**
 * Broadcasts this participant's presence (focused question + mouse cursor) and
 * renders the presence of remote participants:
 *
 * - Focus: `survey.onFocusInQuestion` -> `focus-question` emit; cleared via a
 *   debounced document `focusout` (survey-core has no blur event). Remote focus
 *   is drawn natively — a `data-collab-focus` attribute plus a peer-color CSS
 *   variable on the question root — so it scrolls and clips for free.
 * - Cursor: throttled document `mousemove` anchored to the outermost
 *   `[data-name]` question root as 0..1 fractions of its rect, so positions
 *   converge across differently sized windows. Rendered as an SVG arrow + name
 *   pill in a fixed pointer-transparent layer.
 *
 * MVP limitations (accepted): the cursor hides when not over a question (no
 * page-level anchor); two peers focusing one question show a single ring
 * (first wins); late joiners see peers' cursors only after their next move.
 *
 * Returns a detach function that removes all listeners and DOM artifacts.
 */
export function attachPresence({
  survey,
  socket,
  roomId,
  selfId,
  initialParticipants,
  getParticipant,
}: AttachPresenceOptions): () => void {
  const doc = document;
  let disposed = false;

  // ---- remote peer state ----
  const peers = new Map<string, PeerState>();
  const ensurePeer = (id: string): PeerState => {
    let peer = peers.get(id);
    if (!peer) {
      peer = { focus: null, cursor: null, cursorAt: 0 };
      peers.set(id, peer);
    }
    return peer;
  };
  for (const p of initialParticipants) {
    if (p.id !== selfId && p.focus) ensurePeer(p.id).focus = p.focus;
  }

  // ---- overlay layer + per-peer DOM artifacts ----
  const layer = doc.createElement("div");
  layer.className = "collab-presence-layer";
  doc.body.appendChild(layer);

  const artifacts = new Map<string, PeerArtifacts>();
  const ensureArtifacts = (peerId: string): PeerArtifacts => {
    let a = artifacts.get(peerId);
    if (!a) {
      const cursor = doc.createElement("div");
      cursor.className = "collab-cursor";
      cursor.innerHTML = CURSOR_SVG;
      const cursorName = doc.createElement("div");
      cursorName.className = "collab-cursor-name";
      const badge = doc.createElement("div");
      badge.className = "collab-focus-badge";
      layer.append(cursor, cursorName, badge);
      a = { cursor, cursorName, badge };
      artifacts.set(peerId, a);
    }
    return a;
  };
  const removeArtifacts = (peerId: string) => {
    const a = artifacts.get(peerId);
    if (!a) return;
    a.cursor.remove();
    a.cursorName.remove();
    a.badge.remove();
    artifacts.delete(peerId);
  };

  /** question roots currently decorated with a remote-focus ring */
  const decorated = new Set<HTMLElement>();

  // Escape for use inside a double-quoted attribute selector (CSS.escape is
  // not available in all test environments).
  const escapeAttr = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const findQuestionNode = (name: string): HTMLElement | null =>
    doc.querySelector<HTMLElement>(`[data-name="${escapeAttr(name)}"]`);

  const place = (el: HTMLElement, x: number, y: number) => {
    el.style.display = "block";
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };
  const hide = (el: HTMLElement) => {
    el.style.display = "none";
  };

  // ---- render: reconcile decorations + position overlay artifacts ----
  const render = () => {
    if (disposed) return;
    const now = Date.now();

    // First peer to claim a question node wins the ring (MVP limitation).
    const wanted = new Map<HTMLElement, { color: string; label: string }>();
    const badgeTargets = new Map<string, HTMLElement>();
    for (const [peerId, peer] of peers) {
      if (!peer.focus) continue;
      const participant = getParticipant(peerId);
      if (!participant) continue; // roster race — the fallback tick retries
      const node = findQuestionNode(peer.focus);
      if (!node || wanted.has(node)) continue;
      wanted.set(node, { color: participant.color, label: participant.name });
      badgeTargets.set(peerId, node);
    }

    for (const node of decorated) {
      if (!wanted.has(node) || !node.isConnected) {
        node.removeAttribute("data-collab-focus");
        node.style.removeProperty("--collab-peer-color");
        decorated.delete(node);
      }
    }
    wanted.forEach((dec, node) => {
      node.setAttribute("data-collab-focus", "on");
      node.style.setProperty("--collab-peer-color", dec.color);
      decorated.add(node);
    });

    for (const [peerId, peer] of peers) {
      const participant = getParticipant(peerId);
      const a = ensureArtifacts(peerId);

      // Focus badge at the question's top-right corner.
      const badgeNode = badgeTargets.get(peerId);
      if (badgeNode && participant) {
        const rect = badgeNode.getBoundingClientRect();
        a.badge.textContent = participant.name;
        a.badge.style.background = participant.color;
        place(a.badge, rect.right, rect.top - BADGE_GAP_PX);
        a.badge.style.transform = "translate(-100%, -100%)";
      } else {
        hide(a.badge);
      }

      // Cursor arrow + name pill, re-anchored to the question rect.
      const cur = peer.cursor;
      const node = cur && now - peer.cursorAt < CURSOR_IDLE_MS ? findQuestionNode(cur.name) : null;
      const rect = node?.getBoundingClientRect();
      if (cur && rect && rect.width > 0 && rect.height > 0) {
        const color = participant?.color ?? "#888";
        const x = rect.left + cur.x * rect.width;
        const y = rect.top + cur.y * rect.height;
        a.cursor.querySelector("path")?.setAttribute("fill", color);
        place(a.cursor, x, y);
        a.cursorName.textContent = participant?.name ?? "";
        a.cursorName.style.background = color;
        place(a.cursorName, x + 12, y + 16);
      } else {
        hide(a.cursor);
        hide(a.cursorName);
      }
    }
  };

  // rAF-coalesced refresh for scroll/resize/mutation storms. Socket events
  // call render() synchronously instead (keeps unit tests synchronous).
  const raf: (cb: () => void) => number =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16) as unknown as number;
  let refreshScheduled = false;
  const refresh = () => {
    if (refreshScheduled || disposed) return;
    refreshScheduled = true;
    raf(() => {
      refreshScheduled = false;
      render();
    });
  };

  // ---- outgoing: focused question ----
  let lastSentFocus: string | null = null;
  let blurTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelBlur = () => {
    if (blurTimer !== undefined) {
      clearTimeout(blurTimer);
      blurTimer = undefined;
    }
  };
  const sendFocus = (name: string | null) => {
    if (name === lastSentFocus) return;
    lastSentFocus = name;
    socket.emit("focus-question", { roomId, name });
  };

  const onFocusInQuestion = (_sender: Model, options: { question: unknown }) => {
    // Climb to the top-level question: composite/matrix cells render nested
    // [data-name] roots whose names are not globally unique.
    let q = options.question as { name?: unknown; parentQuestion?: unknown } | undefined;
    while (q?.parentQuestion) q = q.parentQuestion as typeof q;
    const name = typeof q?.name === "string" && q.name ? q.name : null;
    if (!name) return;
    cancelBlur();
    sendFocus(name);
  };

  // survey-core has no blur event; debounce a DOM focusout instead. Focus
  // moving to another question re-fires onFocusInQuestion within the window,
  // so peers see no null/name flicker while tabbing between fields.
  const onFocusOut = (ev: FocusEvent) => {
    const target = ev.target as Element | null;
    if (!target?.closest?.("[data-name]")) return;
    cancelBlur();
    blurTimer = setTimeout(() => {
      blurTimer = undefined;
      if (!disposed) sendFocus(null);
    }, BLUR_DEBOUNCE_MS);
  };
  const onFocusIn = (ev: FocusEvent) => {
    const target = ev.target as Element | null;
    if (target?.closest?.("[data-name]")) cancelBlur();
  };

  // ---- outgoing: mouse cursor ----
  const emitCursor = (payload: CursorPayload) =>
    (socket.volatile ?? socket).emit("cursor-moved", payload);

  let lastCurKey = "";
  const sendCursor = (name: string | null, x: number, y: number) => {
    const key = `${name}|${x}|${y}`;
    if (key === lastCurKey) return;
    lastCurKey = key;
    emitCursor({ roomId, name, x, y });
  };

  const captureMouse = (ev: MouseEvent) => {
    // Anchor to the OUTERMOST [data-name] ancestor (see onFocusInQuestion).
    let anchor = (ev.target as Element | null)?.closest?.("[data-name]") ?? null;
    for (
      let outer = anchor?.parentElement?.closest("[data-name]");
      outer;
      outer = outer.parentElement?.closest("[data-name]")
    ) {
      anchor = outer;
    }
    const rect = anchor?.getBoundingClientRect();
    if (!anchor || !rect || rect.width === 0 || rect.height === 0) {
      sendCursor(null, 0, 0);
      return;
    }
    sendCursor(
      anchor.getAttribute("data-name"),
      round3((ev.clientX - rect.left) / rect.width),
      round3((ev.clientY - rect.top) / rect.height),
    );
  };

  let pendingMouse: MouseEvent | null = null;
  let mouseTimer: ReturnType<typeof setTimeout> | undefined;
  const onMouseMove = (ev: MouseEvent) => {
    pendingMouse = ev;
    if (mouseTimer !== undefined) return;
    mouseTimer = setTimeout(() => {
      mouseTimer = undefined;
      if (!disposed && pendingMouse) captureMouse(pendingMouse);
      pendingMouse = null;
    }, MOUSE_THROTTLE_MS);
  };
  const hideCursor = () => sendCursor(null, 0, 0);
  const onMouseLeave = () => hideCursor();
  const onVisibility = () => {
    if (doc.visibilityState === "hidden") hideCursor();
  };

  // ---- incoming ----
  const onRemoteFocus = ({ id, name }: FocusBroadcastPayload) => {
    ensurePeer(id).focus = name;
    render();
  };
  const onRemoteCursor = ({ id, name, x, y }: CursorBroadcastPayload) => {
    const peer = ensurePeer(id);
    peer.cursor = name ? { name, x, y } : null;
    peer.cursorAt = Date.now();
    render();
  };
  const onParticipantLeft = ({ id }: { id: string }) => {
    peers.delete(id);
    removeArtifacts(id);
    render();
  };

  // ---- wiring ----
  survey.onFocusInQuestion.add(onFocusInQuestion);
  doc.addEventListener("focusout", onFocusOut, true);
  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("mousemove", onMouseMove, true);
  doc.addEventListener("scroll", refresh, true);
  doc.addEventListener("visibilitychange", onVisibility);
  doc.documentElement.addEventListener("mouseleave", onMouseLeave);
  window.addEventListener("resize", refresh);

  socket.on("focus-question", onRemoteFocus);
  socket.on("cursor-moved", onRemoteCursor);
  socket.on("participant-left", onParticipantLeft);

  // Question nodes are re-created by React/SurveyJS renders; re-apply
  // decorations whenever the DOM changes, with a safety tick as backstop.
  const observer = new MutationObserver(refresh);
  observer.observe(doc.body, { childList: true, subtree: true });
  const fallbackTick = setInterval(refresh, FALLBACK_TICK_MS);

  render();

  return () => {
    disposed = true;
    survey.onFocusInQuestion.remove(onFocusInQuestion);
    doc.removeEventListener("focusout", onFocusOut, true);
    doc.removeEventListener("focusin", onFocusIn, true);
    doc.removeEventListener("mousemove", onMouseMove, true);
    doc.removeEventListener("scroll", refresh, true);
    doc.removeEventListener("visibilitychange", onVisibility);
    doc.documentElement.removeEventListener("mouseleave", onMouseLeave);
    window.removeEventListener("resize", refresh);

    socket.off("focus-question", onRemoteFocus);
    socket.off("cursor-moved", onRemoteCursor);
    socket.off("participant-left", onParticipantLeft);

    observer.disconnect();
    clearInterval(fallbackTick);
    cancelBlur();
    if (mouseTimer !== undefined) clearTimeout(mouseTimer);

    for (const node of decorated) {
      node.removeAttribute("data-collab-focus");
      node.style.removeProperty("--collab-peer-color");
    }
    decorated.clear();
    layer.remove();
  };
}
