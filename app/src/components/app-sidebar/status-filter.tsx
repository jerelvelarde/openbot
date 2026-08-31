import { Button } from "@/components/ui/button";
import type { RosterStatus } from "@/lib/roster/queries";

const STATUSES: { value: RosterStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];

/**
 * Which conversations the roster is showing.
 *
 * ALWAYS VISIBLE, ALWAYS LABELLED. A checkbox somebody left ticked is a hidden mode: the roster is
 * quietly missing their live conversations and nothing on screen says which state it is in. Three
 * labelled buttons cannot be in a state a person cannot see.
 */
export function StatusFilter({
  value,
  onChange,
}: {
  value: RosterStatus;
  onChange: (next: RosterStatus) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> forces a visible <legend>, duplicating aria-label, for three toggle buttons that aren't form fields.
    <div
      aria-label="Show conversations"
      className="flex flex-row gap-1"
      role="group"
    >
      {STATUSES.map((status) => (
        <Button
          aria-pressed={status.value === value}
          key={status.value}
          onClick={() => onChange(status.value)}
          size="sm"
          variant={status.value === value ? "secondary" : "ghost"}
        >
          {status.label}
        </Button>
      ))}
    </div>
  );
}
