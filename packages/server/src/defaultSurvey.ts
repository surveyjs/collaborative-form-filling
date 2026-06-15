/**
 * Default survey schema (SurveyJS JSON) used for every room in the MVP.
 * Spans several pages and exercises a broad spread of question types —
 * including matrixdynamic and the custom components registered on the client
 * (see packages/client/src/customComponents.ts) — to stress real-time sync.
 */
export const defaultSurvey = {
  title: "Team Collaborative Survey",
  description: "Fill it out together — changes are visible to all participants in real time.",
  showQuestionNumbers: "on",
  pages: [
    {
      name: "overview",
      title: "Project Overview",
      elements: [
        {
          type: "text",
          name: "projectName",
          title: "Project name",
        },
        {
          type: "radiogroup",
          name: "stage",
          title: "Current project stage",
          choices: ["Idea", "Prototype", "Development", "Release"],
        },
        {
          type: "checkbox",
          name: "stack",
          title: "Technologies used",
          choices: ["React", "Node.js", "TypeScript", "PostgreSQL", "Docker"],
        },
        {
          type: "rating",
          name: "confidence",
          title: "Confidence in timeline (1–5)",
          rateMin: 1,
          rateMax: 5,
        },
      ],
    },
    {
      name: "team",
      title: "Team",
      elements: [
        {
          type: "contactinfo",
          name: "lead",
          title: "Project lead",
        },
        {
          type: "matrixdynamic",
          name: "members",
          title: "Team members",
          addRowText: "Add member",
          rowCount: 1,
          columns: [
            { name: "member", title: "Member", cellType: "text" },
            {
              name: "role",
              title: "Role",
              cellType: "dropdown",
              choices: ["Developer", "Designer", "QA", "PM", "DevOps"],
            },
            {
              name: "allocation",
              title: "Allocation, %",
              cellType: "dropdown",
              choices: [25, 50, 75, 100],
            },
          ],
        },
      ],
    },
    {
      name: "planning",
      title: "Planning & Risks",
      elements: [
        {
          type: "matrix",
          name: "priorities",
          title: "Priorities by area",
          columns: ["Low", "Medium", "High"],
          rows: ["Quality", "Speed", "Cost"],
        },
        {
          type: "matrixdynamic",
          name: "milestones",
          title: "Key milestones",
          addRowText: "Add milestone",
          rowCount: 1,
          columns: [
            { name: "title", title: "Milestone", cellType: "text" },
            { name: "due", title: "Due date", cellType: "text", inputType: "date" },
            { name: "owner", title: "Owner", cellType: "text" },
          ],
        },
        {
          type: "effortestimate",
          name: "effort",
          title: "Project effort estimate",
        },
        {
          type: "comment",
          name: "notes",
          title: "Additional notes",
        },
      ],
    },
  ],
};
