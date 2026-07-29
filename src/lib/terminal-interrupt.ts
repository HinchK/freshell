import { getWsClient } from '@/lib/ws-client'
import { buildTerminalInputMessage } from '@/components/terminal-view-utils'
import type { TerminalPaneContent } from '@/store/paneTypes'

export type InterruptKey = 'esc' | 'ctrl-c'
const KEY_DATA: Record<InterruptKey, string> = { esc: '\x1b', 'ctrl-c': '\x03' }

export function sendTerminalInterrupt(
  content: TerminalPaneContent | null | undefined,
  terminalId: string,
  key: InterruptKey,
): void {
  getWsClient().send(buildTerminalInputMessage(content, terminalId, KEY_DATA[key]))
}
