import { Component, Input } from "@angular/core";
import { IBarChip, ParticipantsBarModel } from "../../../../../shared/participantsBar";

/**
 * The collab participants bar; app chrome rendered by AppComponent above the
 * survey. A plain zone-driven component on purpose: every model mutation
 * originates from a socket event or a click (both zone-patched), so default
 * change detection re-reads the model getters — no survey-core subscription
 * needed. Do NOT extend BaseAngular here: it is built for survey-internal
 * views that detach from the change-detection tree and re-render manually,
 * and stays permanently attached (busy-looping) when declared as app chrome.
 */
@Component({
  selector: "app-participants-bar",
  templateUrl: "./participants-bar.component.html"
})
export class ParticipantsBarComponent {
  @Input() model!: ParticipantsBarModel;
  // Inline styles (no SCSS): the bar ships with the collab tooling and must
  // not depend on the survey theme pipeline. Mirrors shared/participantsBarView.
  public barBg = "#f5f5f5";
  public chipRing(): string {
    return "0 0 0 2px " + this.barBg;
  }
  /**
   * REQUIRED: `model.chips` builds a fresh array of fresh objects on every
   * read, and this component is checked by zone-driven change detection.
   * Without trackBy, ngFor would recreate the chip DOM on every pass; the
   * resize that causes re-triggers the survey's (zone-patched) observers,
   * which schedules another pass — a busy loop that freezes the page as soon
   * as the roster is non-empty.
   */
  public trackChip(index: number, chip: IBarChip): string {
    return chip.id;
  }
}
