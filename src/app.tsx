/**
 * Root component of the TUI. Everything rendered lives under this box;
 * for now it is an empty flex container just to prove the render pipeline
 * boots. Screens (which require a ConfigStore) are wired to it later.
 */
export default function App() {
  return <box flexGrow={1} />
}