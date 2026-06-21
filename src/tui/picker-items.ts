export interface PickerOption {
  id: string
  name: string
}

export interface PickerEntry {
  id: string
  label: string
  detail: string
  isCurrent?: boolean
}

export type ChoicePickerMode = "models" | "profiles" | "skills" | "tools"

export function pickerModeForCommand(commandId: string): ChoicePickerMode | null {
  if (commandId === "model") return "models"
  if (commandId === "profile") return "profiles"
  if (commandId === "skills") return "skills"
  if (commandId === "tool list") return "tools"
  return null
}

export function buildPickerItems(
  options: PickerOption[],
  currentId: string,
  query = "",
): PickerEntry[] {
  const q = query.toLowerCase()
  const filtered = q
    ? options.filter((o) => o.id.toLowerCase().includes(q) || o.name.toLowerCase().includes(q))
    : options

  return filtered
    .map((o) => ({
      id: o.id,
      label: o.name,
      detail: "",
      isCurrent: o.id === currentId,
    }))
    .sort((a, b) => (a.isCurrent ? -1 : b.isCurrent ? 1 : 0))
}
