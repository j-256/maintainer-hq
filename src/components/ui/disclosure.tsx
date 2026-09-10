import type { ComponentProps } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import "./disclosure.css";

export function Disclosure({
  title,
  description,
  icon: Icon,
  className,
  children,
  ...props
}: Omit<ComponentProps<"details">, "title"> & {
  title: string;
  description?: string;
  icon: LucideIcon;
}) {
  return (
    <details className={cn("hq-disclosure", className)} {...props}>
      <summary>
        <Icon size={18} aria-hidden="true" />
        <span className="disclosure-label">
          <span>{title}</span>
          {description ? (
            <span className="disclosure-description">{description}</span>
          ) : null}
        </span>
        <ChevronRight
          className="disclosure-chevron"
          size={16}
          aria-hidden="true"
        />
      </summary>
      <div className="disclosure-content">{children}</div>
    </details>
  );
}
