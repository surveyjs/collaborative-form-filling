import type { IBarChip, ParticipantsBarModel } from "./participantsBar";

/**
 * One participants-bar view for both react-family clients. survey-js-ui is
 * survey-react-ui compiled against preact, so the same component code works
 * in both — but each client must build it with ITS OWN react implementation.
 * The client injects that (react + survey-react-ui, or the survey-js-ui
 * re-exports) and gets back a component class it renders above its Survey:
 * `<Bar model={bar}/>`. Written with createElement calls (no JSX) so no
 * per-client JSX pragma/config is needed. The deps are typed `any` on
 * purpose: this is the seam between two structurally identical but nominally
 * unrelated react implementations. Extending SurveyElementBase keeps the view
 * subscribed to the model's change notifications.
 */

export interface IParticipantsBarViewDeps {
  createElement: (type: any, props?: any, ...children: Array<any>) => any;
  /** survey-react-ui's SurveyElementBase (or the survey-js-ui re-export). */
  SurveyElementBase: new (props: any) => any;
}

// Inline styles (no SCSS): the bar ships with the collab tooling and must not
// depend on the survey theme pipeline.
const barBg = "#f5f5f5";
const barStyle = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 12px",
  background: barBg,
  borderBottom: "1px solid #d4d4d4",
  // Open Sans matches the survey theme below the bar; as app chrome the bar
  // no longer inherits the theme font from the survey.
  fontFamily: "Open Sans, sans-serif",
  fontSize: 14,
};
// Keeps the full participant name (with the "(you)" marker) in the accessible
// text of a chip while only the initials stay visible.
const visuallyHidden = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};
const inviteStyle = {
  border: "none",
  borderRadius: 8,
  padding: "8px 12px",
  background: "#19b394",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
};

function chipCircleStyle(background: string, zIndex: number) {
  return {
    width: 28,
    height: 28,
    borderRadius: "50%",
    boxSizing: "border-box",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontSize: 12,
    fontWeight: 600,
    background: background,
    // The separator ring is an outset shadow so it doesn't shrink the fill.
    boxShadow: "0 0 0 2px " + barBg,
    marginRight: -3,
    position: "relative",
    zIndex: zIndex,
  };
}

/** Builds the participants-bar component class for the injected react impl. */
export function createParticipantsBarView(deps: IParticipantsBarViewDeps): new (props: { model: ParticipantsBarModel }) => any {
  const h = deps.createElement;

  class SurveyParticipantsBar extends deps.SurveyElementBase {
    protected getStateElement(): ParticipantsBarModel {
      return this.model;
    }
    private get model(): ParticipantsBarModel {
      return this.props.model;
    }
    private renderChip(chip: IBarChip, index: number): any {
      const model = this.model;
      const clickable = model.chipsClickable;
      return h(
        "div",
        {
          role: "listitem",
          key: chip.id,
          title: chip.title,
          style: { display: "inline-flex", cursor: clickable ? "pointer" : "default" },
          tabIndex: clickable ? 0 : undefined,
          onClick: clickable ? () => model.chipClick(chip.id) : undefined,
          onKeyDown: clickable
            ? (ev: KeyboardEvent) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                model.chipClick(chip.id);
              }
            }
            : undefined,
        },
        h("span", { style: chipCircleStyle(chip.color, index + 1) }, chip.initials),
        h("span", { style: visuallyHidden }, chip.title)
      );
    }
    private renderOverflow(): any {
      const model = this.model;
      if (model.overflowCount <= 0) return null;
      return h(
        "div",
        { role: "listitem", key: "overflow", title: model.overflowTitle, style: { display: "inline-flex" } },
        h("span", { style: chipCircleStyle("#909090", model.chips.length + 1) }, "+" + model.overflowCount),
        h("span", { style: visuallyHidden }, model.overflowTitle)
      );
    }
    protected renderElement(): any {
      const model = this.model;
      return h(
        "div",
        { className: "sv-participants-bar", style: barStyle },
        model.roomId
          ? h("div", { style: { color: "#555" } }, "Room: ", h("strong", { "data-testid": "room-id" }, model.roomId))
          : null,
        h("div", { style: { flex: 1 } }),
        h(
          "div",
          {
            "data-testid": "participants",
            role: "list",
            "aria-label": "Participants",
            style: { display: "flex", alignItems: "center", paddingRight: 3 },
          },
          model.chips.map((chip, index) => this.renderChip(chip, index)),
          this.renderOverflow()
        ),
        model.showInvite
          ? h(
            "button",
            {
              type: "button",
              "data-testid": "copy-link",
              "aria-label": "Copy invite link",
              onClick: () => model.copyInviteLink(),
              style: inviteStyle,
            },
            model.inviteCaption
          )
          : null
      );
    }
  }

  return SurveyParticipantsBar;
}
