import { useState } from "react";
import type { Participant } from "../../shared/events";

interface PresenceProps {
  roomId: string;
  participants: Participant[];
  selfId: string | null;
}

/** Builds the shareable URL that pre-fills the join form with this room. */
function joinUrl(roomId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  return url.toString();
}

export function Presence({ roomId, participants, selfId }: PresenceProps) {
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl(roomId));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (e.g. insecure context); ignore.
    }
  };

  return (
    <aside
      style={{
        minWidth: 200,
        padding: "1rem",
        borderLeft: "1px solid #e0e0e0",
        background: "#fafafa",
        height: "100%",
        overflowY: "auto",
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <div style={{ color: "#555", marginBottom: 8 }}>
          Room: <strong data-testid="room-id">{roomId}</strong>
        </div>
        <button
          type="button"
          onClick={copyLink}
          data-testid="copy-link"
          style={{
            width: "100%",
            padding: "6px 10px",
            border: "1px solid #ccc",
            borderRadius: 4,
            background: "#fff",
            cursor: "pointer",
          }}
        >
          {copied ? "Copied!" : "Copy join link"}
        </button>
      </div>
      <h3 style={{ marginTop: 0 }}>Participants ({participants.length})</h3>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }} data-testid="participants">
        {participants.map((p) => (
          <li
            key={p.id}
            style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: p.color,
                flexShrink: 0,
              }}
            />
            <span>
              {p.name}
              {p.id === selfId ? " (you)" : ""}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
