import { PanelIcon } from "../icons"

interface TopbarProps {
  title: string
  toggleSidebar: () => void
}

export function Topbar(props: TopbarProps) {
  return (
    <header class="topbar">
      <div class="topbar-brand"><span class="brand-mark" aria-hidden="true">Q</span><span>Quark</span></div>
      <div class="session-title">{props.title}</div>
      <button class="icon-button topbar-toggle" type="button" aria-label="Toggle sessions" onClick={props.toggleSidebar}>
        <PanelIcon />
      </button>
    </header>
  )
}
