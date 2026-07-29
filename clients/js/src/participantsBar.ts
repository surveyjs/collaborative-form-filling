import { createElement, SurveyElementBase } from "survey-js-ui";
import { createParticipantsBarView } from "../../../shared/participantsBarView";

/**
 * The collab participants-bar component, built from the shared react-family
 * view with survey-js-ui's re-exports (the survey-react-ui API compiled
 * against its bundled preact). Rendered by the host above the survey.
 */
export const SurveyParticipantsBar = createParticipantsBarView({ createElement, SurveyElementBase });
