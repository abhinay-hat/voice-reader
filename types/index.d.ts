export type Mode = 'off' | 'summary' | 'full'
export type Player = 'idle' | 'preparing' | 'installing' | 'downloading' | 'playing' | 'paused' | 'error'

declare module 'claude-code' {
  interface PluginState {
    'voice-reader': {
      /** off, summary or full: how each new reply is spoken */
      mode: Mode
      /** What this session's audio is doing now */
      player: Player
      /** Section titles of this session's latest reply */
      sections: string[]
      /** Section being spoken now; -1 when idle or speaking the summary */
      active: number
      /** Another session holds the speakers */
      elsewhere: boolean
      /** Last error from the backend, shown in the bar */
      error: string
    }
  }
}
