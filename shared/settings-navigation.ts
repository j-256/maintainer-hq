import type { SyncView } from "./workspace-sync";
import { normalizeAppPathname } from "./app-pathname";

export const SETTINGS_SECTIONS = [
  {
    id: "members",
    label: "Members",
    title: "Members",
    description: "Review membership, roles, and invitations.",
    group: "Workspace access",
    guide: "access",
    view: "workspace",
  },
  {
    id: "automation",
    label: "Automation",
    title: "Automation",
    description: "Manage credentials for agents and scripts.",
    group: "Workspace access",
    guide: "automation",
    view: "workspace",
  },
  {
    id: "github",
    label: "GitHub",
    title: "GitHub",
    description:
      "Review repository coverage, collection progress and connections.",
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
    title: "Import metadata",
    description: "Review a starting inventory for an empty workspace.",
    group: "Workspace data",
    guide: "import",
    view: "settings-import",
  },
  {
    id: "preferences",
    label: "Date and time",
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
