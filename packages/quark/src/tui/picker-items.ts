export interface PickerOption {
  id: string
  name: string
  detail?: string
}

export interface PickerEntry {
  id: string
  label: string
  detail: string
  isCurrent?: boolean
}

export type ChoicePickerMode = "agents"

export function pickerModeForCommand(commandId: string): ChoicePickerMode | null {
  // `/profile` is a compatibility alias for `/agent`.
  if (commandId === "agent" || commandId === "profile") return "agents"
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
      detail: o.detail ?? "",
      isCurrent: o.id === currentId,
    }))
    .sort((a, b) => (a.isCurrent ? -1 : b.isCurrent ? 1 : 0))
}
