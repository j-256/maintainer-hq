import { ExternalLink } from "lucide-react";
import type { GitHubManagementLink } from "../shared/github-settings";
import "./github-gap-actions.css";

function SettingsLink({ link }: { link: GitHubManagementLink }) {
  return (
    <a
      className="quiet-link"
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {link.label}
      <ExternalLink size={14} aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function GitHubGapActions({ links }: { links: GitHubManagementLink[] }) {
  if (!links.length) return null;
  return (
    <div className="github-gap-actions">
      <div className="github-gap-links">
        {links
          .filter((link) => link.scope === "repository")
          .map((link) => (
            <SettingsLink key={link.id} link={link} />
          ))}
      </div>
      <details>
        <summary>Review collector access on GitHub</summary>
        <p>
          Use the settings for the credential used by this connection. Sign in
          as its owner or installation administrator.
        </p>
        <div className="github-gap-links">
          {links
            .filter((link) => link.scope === "credential")
            .map((link) => (
              <SettingsLink key={link.id} link={link} />
            ))}
        </div>
      </details>
      <p>
        GitHub checks your access. After making changes, return to HQ and
        refresh the connection to verify coverage.
      </p>
    </div>
  );
}
