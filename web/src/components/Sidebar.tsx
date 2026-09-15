import { For } from "solid-js"
import { PlusIcon, SearchIcon, CloseIcon } from "../icons"
import type { WebApp } from "../state"

interface SidebarProps {
  app: WebApp
  open: boolean
  onClose: () => void
  openSessions: () => void
}

export function Sidebar(props: SidebarProps) {
  const cwd = () => props.app.state.status.cwd.replace(/^\/Users\/[^/]+/, "~")

  const select = (id: string) => {
    void props.app.selectSession(id)
    props.onClose()
  }

  return (
    <>
      <div class="drawer-scrim" classList={{ visible: props.open }} onClick={props.onClose} />
      <aside class="sidebar" classList={{ open: props.open }}>
        <div class="sidebar-head">
          <div class="sidebar-brand"><span class="brand-mark" aria-hidden="true">Q</span><strong>Quark</strong></div>
          <button class="icon-button" type="button" aria-label="New session" onClick={() => { void props.app.newSession(); props.onClose() }}>
            <PlusIcon />
          </button>
          <button class="icon-button sidebar-close" type="button" aria-label="Close sessions" onClick={props.onClose}>
            <CloseIcon />
          </button>
        </div>
        <nav class="sidebar-nav" aria-label="Sessions">
          <button class="sidebar-action" type="button" onClick={props.openSessions}>
            <SearchIcon />
            Search sessions
            <kbd>⌘ K</kbd>
          </button>
          <h2>Chats</h2>
          <div class="session-list">
            <For each={props.app.state.sessions}>
              {(session) => (
                <button
                  type="button"
                  class="session-item"
                  title={session.title}
                  aria-current={session.id === props.app.state.session?.id ? "page" : undefined}
                  onClick={() => select(session.id)}
                >
                  {session.title}
                </button>
              )}
            </For>
          </div>
        </nav>
        <div class="sidebar-footer">
          <span><span classList={{ "footer-dot": true, active: props.app.state.running }} /><span>{props.app.state.running ? "Working" : "Ready"}</span></span>
          <strong>{props.app.state.status.branch ?? "—"}</strong>
          <span title={props.app.state.status.cwd}>{cwd()}</span>
        </div>
      </aside>
    </>
  )
}
