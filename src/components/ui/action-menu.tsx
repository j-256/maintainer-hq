import { useRef } from "react";
import { ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Button } from "./button";
import "./action-menu.css";

export type MenuAction = {
  label: string;
  disabled?: boolean;
  onSelect: (trigger: HTMLButtonElement) => void;
};

export function ActionMenu({
  label,
  actions,
}: {
  label: string;
  actions: MenuAction[];
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = useRef<MenuAction | null>(null);
  if (!actions.length) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button ref={trigger} variant="outline" aria-label={`More ${label}`}>
          More <ChevronDown size={16} aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="hq-action-menu"
          align="end"
          sideOffset={6}
          aria-label={label}
          onCloseAutoFocus={(event) => {
            const action = selected.current;
            selected.current = null;
            if (action && trigger.current) {
              event.preventDefault();
              trigger.current.focus();
              action.onSelect(trigger.current);
            }
          }}
        >
          {actions.map((action) => (
            <DropdownMenu.Item
              key={action.label}
              disabled={action.disabled}
              onSelect={() => { selected.current = action; }}
            >
              {action.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
