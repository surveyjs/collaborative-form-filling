import { useEffect, useState } from "react";
import type { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import "survey-core/survey-core.min.css";
import "../../../shared/presenceSync.css";
import "../../../shared/customComponents";
import type { AppSocket } from "../../../shared/socket";
import type { ParticipantsBarModel } from "../../../shared/participantsBar";
import { connectRoom, lobbyJoinUrl } from "../../../shared/room";
import { SurveyParticipantsBar } from "./participantsBar";

interface CollaborativeSurveyProps {
  socket: AppSocket;
  roomId: string;
  name: string;
}

// The survey and the bar are recreated together on every (re)join, so they
// live in one state slot and swap atomically.
interface RoomModels {
  survey: Model;
  bar: ParticipantsBarModel;
}

export function CollaborativeSurvey({ socket, roomId, name }: CollaborativeSurveyProps) {
  const [models, setModels] = useState<RoomModels | null>(null);

  useEffect(() => {
    return connectRoom({
      socket,
      roomId,
      name,
      onSurvey: (survey, bar) => setModels({ survey, bar }),
      getInviteLink: () => lobbyJoinUrl(roomId),
    });
  }, [socket, roomId, name]);

  // Flex column: the bar keeps its own height, the survey gets the rest and
  // scrolls internally (its own scroller fills the wrapper). overflow:hidden
  // on <main> prevents a second page-level scrollbar of the bar's height.
  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {models ? (
        <>
          <SurveyParticipantsBar model={models.bar} />
          <div style={{ flex: "1 1 auto", minHeight: 0 }}>
            <Survey model={models.survey} />
          </div>
        </>
      ) : (
        <p>Connecting to the room…</p>
      )}
    </main>
  );
}
