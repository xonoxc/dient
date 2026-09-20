/** Public surface of the Vim-mode subsystem: types, pure machine, and hook. */
export * from "@/vim/types"
export * from "@/vim/vim"
export { useVimMode } from "@/vim/vim-hook"
export type { UseVimModeResult } from "@/vim/vim-hook"
