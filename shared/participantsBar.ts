import { Base } from "survey-core";

export interface IBarParticipant {
  id: string;
  name: string;
  color: string;
}

export interface IBarChip {
  id: string;
  initials: string;
  color: string;
  name: string;
  title: string;
}

export interface IParticipantsBarOptions {
  roomId?: string;
  selfId?: string;
  getInviteLink?: () => string;
}

export function presenceInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Model for the collaborative participants bar. The bar is app chrome: each
 * client renders its own view of this model ABOVE its Survey component (it is
 * not a survey layout element). The host owns the transport: it pushes the
 * roster via `setParticipants` and provides room/invite context via options.
 * Optional pieces follow the "no option -> element hidden" convention.
 * Extending survey-core's Base plugs the model into the change notifications
 * every framework view already understands (SurveyElementBase / useBase /
 * BaseAngular).
 */
export class ParticipantsBarModel extends Base {
  public static MAX_AVATARS = 8;
  public static COPIED_REVERT_MS = 1500;
  private lastParticipantsSig?: string;
  private inviteTimer?: ReturnType<typeof setTimeout>;
  constructor(private options: IParticipantsBarOptions = {}) {
    super();
    this.createNewArray("participants");
  }
  public override getType(): string {
    return "participantsbar";
  }
  public get roomId(): string {
    return this.options.roomId || "";
  }
  public get selfId(): string {
    return this.options.selfId || "";
  }
  public get participants(): Array<IBarParticipant> {
    return this.getPropertyValue("participants");
  }
  public setParticipants(list: Array<IBarParticipant>): void {
    // Roster pushes may arrive on every presence tick; skip the update when
    // nothing the bar displays changed (order included: avatars stack).
    const sig = list.map((u) => [u.id, u.name, u.color].join("\u0001")).join("\u0002");
    if (sig === this.lastParticipantsSig) return;
    this.lastParticipantsSig = sig;
    this.setPropertyValue("participants", list.slice());
  }
  /** The roster without ourselves: the bar shows only OTHER participants. */
  private get others(): Array<IBarParticipant> {
    const selfId = this.selfId;
    return this.participants.filter((p) => !selfId || p.id !== selfId);
  }
  public get chips(): Array<IBarChip> {
    return this.others.slice(0, ParticipantsBarModel.MAX_AVATARS).map((p) => {
      return {
        id: p.id,
        initials: presenceInitials(p.name),
        color: p.color,
        name: p.name,
        title: p.name,
      };
    });
  }
  public get overflowCount(): number {
    return Math.max(0, this.others.length - ParticipantsBarModel.MAX_AVATARS);
  }
  public get overflowTitle(): string {
    return this.others
      .slice(ParticipantsBarModel.MAX_AVATARS)
      .map((p) => p.name)
      .join(", ");
  }
  public get showInvite(): boolean {
    return !!this.options.getInviteLink;
  }
  public get inviteCopied(): boolean {
    return this.getPropertyValue("inviteCopied", false);
  }
  public set inviteCopied(val: boolean) {
    this.setPropertyValue("inviteCopied", val);
  }
  public get inviteCaption(): string {
    return this.inviteCopied ? "Copied" : "Invite";
  }
  public copyInviteLink(): void {
    if (!this.options.getInviteLink) return;
    const link = this.options.getInviteLink();
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard || !clipboard.writeText) return;
    // Clipboard access may still fail (insecure context, denied permission);
    // the caption flip is optimistic and harmless in that case.
    clipboard.writeText(link).catch(() => {});
    this.inviteCopied = true;
    if (this.inviteTimer) clearTimeout(this.inviteTimer);
    this.inviteTimer = setTimeout(() => {
      this.inviteTimer = undefined;
      if (!this.isDisposed) {
        this.inviteCopied = false;
      }
    }, ParticipantsBarModel.COPIED_REVERT_MS);
  }
  // Idempotent: the host may dispose the bar again on cleanup/reconnect.
  public override dispose(): void {
    if (this.isDisposed) return;
    if (this.inviteTimer) {
      clearTimeout(this.inviteTimer);
      this.inviteTimer = undefined;
    }
    super.dispose();
  }
}
