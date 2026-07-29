import { createElement } from "react";
import { SurveyElementBase } from "survey-react-ui";
import { createParticipantsBarView } from "../../../shared/participantsBarView";

/**
 * The collab participants-bar component, built from the shared react-family
 * view with this client's React. Rendered by the host above the Survey.
 */
export const SurveyParticipantsBar = createParticipantsBarView({ createElement, SurveyElementBase });
