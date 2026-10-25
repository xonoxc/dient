/**
 * `$EDITOR`-based text editing for values that are not a table row: a Redis
 * string, a RedisJSON document, or a Redis key name. The file is the actual
 * text, not a `column: value` wrapper, so strings keep their line breaks and
 * JSON keeps the shape the user typed.
 */
import { runEditorSession, type EditorCallbacks, type EditorRenderer } from "@/editor/editor-session"

export interface EditTextOptions {
  readonly renderer: EditorRenderer
  readonly label: string
  readonly filename: string
  readonly extension?: string
  readonly watch?: boolean
  readonly content: string
  readonly callbacks: EditorCallbacks & {
    readonly onSave: (text: string) => void
  }
}

/** Launch `$EDITOR` over `content` and hand the edited text to `callbacks.onSave`. */
export const editTextInEditor = (options: EditTextOptions): void => {
  const { callbacks, extension, watch, ...rest } = options
  runEditorSession({ ...rest, callbacks, onSave: callbacks.onSave, extension, watch })
}

/**
 * Editors conventionally terminate a text file with a newline, but a Redis
 * string has no such convention. Strip exactly one newline the editor added
 * when the original text did not end with one, so editing `hello` does not
 * silently turn it into `hello\n`. A value that really ends in a newline keeps
 * it, and a user who deliberately adds a final newline to a value that had
 * none loses that one byte — the unavoidable ambiguity of editing raw text.
 */
export const stripEditorNewline = (edited: string, original: string): string => {
  if (edited.endsWith("\r\n") && !original.endsWith("\r\n")) return edited.slice(0, -2)
  if (edited.endsWith("\n") && !original.endsWith("\n")) return edited.slice(0, -1)
  return edited
}
