import { ExternalLink } from "lucide-react";
import type { GitHubManagementLink } from "../shared/github-settings";
import type { GitHubRemediation } from "../shared/github-remediation";
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

export function GitHubGapActions({
  links,
  remediation = [],
}: {
  links: GitHubManagementLink[];
  remediation?: GitHubRemediation[];
}) {
  if (!links.length && !remediation.length) return null;
  return (
    <div className="github-gap-actions">
      {remediation.length ? (
        <section aria-label="Resolve unavailable GitHub checks">
          <strong className="github-gap-heading">
            Resolve unavailable checks
          </strong>
          <ul className="github-remediation-list">
            {remediation.map((item) => (
              <li key={item.key}>
                <strong>{item.label} unavailable</strong>
                <p>{item.guidance}</p>
              </li>
            ))}
          </ul>
          <p>
            GitHub's denial does not distinguish missing permissions from an
            unavailable feature. Check the named feature first, then the
            credential used by this connection.
          </p>
        </section>
      ) : null}
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
          as its owner or installation administrator. Check the selected
          repositories and read permissions. Classic tokens use different scopes
          from fine-grained tokens and GitHub Apps.
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
