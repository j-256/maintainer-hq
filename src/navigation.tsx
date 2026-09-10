import { useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  FolderGit2,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  Menu,
  Monitor,
  Moon,
  PackageCheck,
  Settings2,
  Sun,
  Webhook,
} from "lucide-react";
import type { Workspace } from "../shared/domain";
import { DOCUMENTATION_ORIGIN } from "../shared/documentation";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { workspaceDestination } from "./lib/navigation";
import { SignOut } from "./sign-out";

const NAVIGATION = [
  { path: "/overview", label: "Overview", Icon: LayoutDashboard },
  { path: "/activity", label: "Activity", Icon: Activity },
  { path: "/projects", label: "Projects", Icon: FolderKanban },
  { path: "/repositories", label: "Repositories", Icon: FolderGit2 },
  { path: "/dependencies", label: "Dependencies", Icon: PackageCheck },
  { path: "/hooks", label: "Hooks", Icon: Webhook },
  { path: "/monitoring", label: "Monitoring", Icon: Monitor },
  { path: "/secrets", label: "Secrets", Icon: KeyRound },
  { path: "/settings", label: "Settings", Icon: Settings2 },
];

type NavigationProps = {
  workspaceId: string | undefined;
  workspaces: Workspace[];
  loading: boolean;
  displayName: string;
  role: string;
  dark: boolean;
  toggleTheme: () => void;
  canSignOut: boolean;
};

function Brand({ suffix }: { suffix: string }) {
  return (
    <NavLink to={"/overview" + suffix} className="brand">
      <span className="brand-symbol" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>
        maintainer<span className="brand-hq">hq</span>
      </span>
    </NavLink>
  );
}

function NavigationLinks({
  suffix,
  onNavigate,
}: {
  suffix: string;
  onNavigate?: () => void;
}) {
  return (
    <nav className="workspace-navigation" aria-label="Main navigation">
      {NAVIGATION.map(({ path, label, Icon }) => (
        <NavLink key={path} to={path + suffix} onClick={onNavigate}>
          <Icon size={17} aria-hidden="true" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function WorkspacePicker({
  workspaceId,
  workspaces,
  loading,
  onChange,
}: Pick<NavigationProps, "workspaceId" | "workspaces" | "loading"> & {
  onChange: (id: string) => void;
}) {
  return (
    <div className="workspace-picker">
      <div className="workspace-avatar" aria-hidden="true">
        {
          (workspaces.find((workspace) => workspace.id === workspaceId)?.name ??
            "W")[0]
        }
      </div>
      <Select
        value={workspaceId ?? ""}
        onValueChange={onChange}
        disabled={loading || !workspaces.length}
      >
        <SelectTrigger aria-label="Workspace">
          <SelectValue
            placeholder={loading ? "Loading workspace..." : "Choose workspace"}
          />
        </SelectTrigger>
        <SelectContent>
          {workspaces.map((workspace) => (
            <SelectItem key={workspace.id} value={workspace.id}>
              {workspace.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ThemeToggle({
  dark,
  toggleTheme,
}: Pick<NavigationProps, "dark" | "toggleTheme">) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </Button>
  );
}

function Account({
  displayName,
  role,
  dark,
  toggleTheme,
  canSignOut,
}: Pick<
  NavigationProps,
  "displayName" | "role" | "dark" | "toggleTheme" | "canSignOut"
>) {
  return (
    <div className="account-controls">
      <div className="profile">
        <div className="profile-avatar" aria-hidden="true">
          {displayName[0]}
        </div>
        <div>
          <strong>{displayName}</strong>
          <span>{role}</span>
        </div>
        <ThemeToggle dark={dark} toggleTheme={toggleTheme} />
      </div>
      {canSignOut ? <SignOut displayName={displayName} /> : null}
    </div>
  );
}

function DocumentationLink() {
  return (
    <a
      className="build-label"
      href={DOCUMENTATION_ORIGIN + "/"}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Documentation (opens in a new tab)"
    >
      <BookOpen size={15} />
      <span>Documentation</span>
      <ArrowUpRight size={14} />
    </a>
  );
}

export function WorkspaceNavigation(props: NavigationProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const navigating = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const suffix = props.workspaceId
    ? "?workspace=" + encodeURIComponent(props.workspaceId)
    : "";
  function changeWorkspace(id: string) {
    if (id === props.workspaceId) return;
    navigating.current = open;
    setOpen(false);
    void navigate(workspaceDestination(location.pathname, id));
  }
  return (
    <>
      <aside className="sidebar" aria-label="Workspace navigation and account">
        <Brand suffix={suffix} />
        <WorkspacePicker {...props} onChange={changeWorkspace} />
        <div className="nav-caption">WORKSPACE</div>
        <NavigationLinks suffix={suffix} />
        <div className="sidebar-bottom">
          <DocumentationLink />
          <p>A workspace for the work behind your projects.</p>
          <Account {...props} />
        </div>
      </aside>
      <aside
        className="mobile-navigation"
        aria-label="Mobile workspace navigation"
      >
        <Brand suffix={suffix} />
        <div className="mobile-navigation-actions">
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button ref={trigger} variant="outline">
                <Menu size={18} />
                Menu
              </Button>
            </DialogTrigger>
            <DialogContent
              className="navigation-dialog"
              onCloseAutoFocus={(event) => {
                if (
                  navigating.current ||
                  !trigger.current?.getClientRects().length
                ) {
                  event.preventDefault();
                  document.getElementById("main-content")?.focus();
                }
                navigating.current = false;
              }}
            >
              <DialogHeader>
                <DialogTitle>Workspace menu</DialogTitle>
                <DialogDescription>
                  Switch workspace or open an app section.
                </DialogDescription>
              </DialogHeader>
              <WorkspacePicker {...props} onChange={changeWorkspace} />
              <NavigationLinks
                suffix={suffix}
                onNavigate={() => {
                  navigating.current = true;
                  setOpen(false);
                }}
              />
              <DocumentationLink />
              <Account {...props} />
            </DialogContent>
          </Dialog>
        </div>
      </aside>
    </>
  );
}
