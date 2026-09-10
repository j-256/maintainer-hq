import type { ProjectPresentation } from "../shared/project-organization";
import { ProjectChoice } from "./project-editor";
import { IMPORTANCE_LABELS, PORTFOLIO_LABELS } from "./project-inventory";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";

export function ProjectPriorities({
  id,
  value,
  onChange,
}: {
  id: string;
  value: ProjectPresentation;
  onChange: (value: ProjectPresentation) => void;
}) {
  const portfolio = value.portfolio;
  return (
    <div className="organization-priorities">
      <ProjectChoice
        id={id + "-importance"}
        label="Importance"
        value={value.importance}
        options={IMPORTANCE_LABELS}
        onChange={(importance) => onChange({ ...value, importance })}
      />
      <div className="form-field">
        <label htmlFor={id + "-importance-note"}>
          Why this importance? (optional)
        </label>
        <Textarea
          id={id + "-importance-note"}
          rows={2}
          maxLength={1000}
          value={value.importanceNote}
          onChange={(event) =>
            onChange({ ...value, importanceNote: event.target.value })
          }
        />
      </div>
      <ProjectChoice
        id={id + "-portfolio"}
        label="Portfolio inclusion"
        value={portfolio.status}
        options={PORTFOLIO_LABELS}
        onChange={(status) =>
          onChange({ ...value, portfolio: { ...portfolio, status } })
        }
      />
      <div className="form-field">
        <label htmlFor={id + "-portfolio-reason"}>
          Portfolio reason{" "}
          {portfolio.status === "excluded" ? "(required)" : "(optional)"}
        </label>
        <Textarea
          id={id + "-portfolio-reason"}
          rows={2}
          maxLength={1000}
          value={portfolio.reason}
          onChange={(event) =>
            onChange({
              ...value,
              portfolio: { ...portfolio, reason: event.target.value },
            })
          }
        />
      </div>
      <div className="form-field">
        <label htmlFor={id + "-url"}>Listing URL (optional)</label>
        <Input
          id={id + "-url"}
          type="url"
          maxLength={500}
          placeholder="https://"
          value={portfolio.url ?? ""}
          onChange={(event) =>
            onChange({
              ...value,
              portfolio: { ...portfolio, url: event.target.value || null },
            })
          }
        />
      </div>
      <div className="form-field">
        <label htmlFor={id + "-date"}>Portfolio review date (optional)</label>
        <Input
          id={id + "-date"}
          type="date"
          value={portfolio.reviewDate ?? ""}
          onChange={(event) =>
            onChange({
              ...value,
              portfolio: {
                ...portfolio,
                reviewDate: event.target.value || null,
              },
            })
          }
        />
      </div>
      <p className="field-help">
        Importance sets priority, not health. Listed records your decision; it
        does not publish a page.
      </p>
    </div>
  );
}
