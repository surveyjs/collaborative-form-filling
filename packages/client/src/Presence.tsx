import type { Participant } from "../../shared/events";

interface PresenceProps {
  participants: Participant[];
  selfId: string | null;
}

export function Presence({ participants, selfId }: PresenceProps) {
  return (
    <aside
      style={{
        minWidth: 200,
        padding: "1rem",
        borderLeft: "1px solid #e0e0e0",
        background: "#fafafa",
      }}
    >
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
