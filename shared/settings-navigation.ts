import type { SyncView } from "./workspace-sync";
import { normalizeAppPathname } from "./app-pathname";

export const SETTINGS_SECTIONS = [
  {
    id: "members",
    label: "Members and invitations",
    title: "Workspace members",
    description: "Review membership, roles, and invitations.",
    group: "Workspace access",
    guide: "access",
    view: "workspace",
  },
  {
    id: "automation",
    label: "Automation access",
    title: "Automation access",
    description: "Manage credentials for agents and scripts.",
    group: "Workspace access",
    guide: "automation",
    view: "workspace",
  },
  {
    id: "github",
    label: "GitHub evidence",
    title: "GitHub evidence",
    description: "Review repository coverage, collection progress and connections.",
    group: "Evidence sources",
    guide: "github",
    view: "settings-sources",
  },
  {
    id: "publishers",
    label: "Local publishers",
    title: "Local publishers",
    description: "Choose which machines may report checkout facts.",
    group: "Evidence sources",
    guide: "publishing",
    view: "settings-sources",
  },
  {
    id: "import",
    label: "Import metadata",
    title: "Bring your project metadata",
    description: "Review a starting inventory for an empty workspace.",
    group: "Workspace data",
    guide: "import",
    view: "settings-import",
  },
  {
    id: "preferences",
    label: "Date and time preferences",
    title: "Date and time",
    description: "Choose your clock, date format, and time zone.",
    group: "Your account",
    guide: "preferences",
    view: "preferences",
  },
] as const satisfies readonly {
  id: string;
  label: string;
  title: string;
  description: string;
  group: string;
  guide: string;
  view: SyncView;
}[];

export function settingsSection(pathname: string) {
  const path = normalizeAppPathname(pathname);
  return SETTINGS_SECTIONS.find(
    (section) => path === "/settings/" + section.id,
  );
}
