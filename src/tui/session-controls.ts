export type SessionAction = "browse" | "rename"

export function sessionControls(width: number, action: SessionAction): string {
  if (action === "rename") return "Enter save  Esc cancel"
  if (width >= 64) return "↑↓ move  Enter open  Ctrl+K actions  Esc close"
  return "↑↓  Enter open  Ctrl+K  Esc close"
}
