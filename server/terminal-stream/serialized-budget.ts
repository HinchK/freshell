export type JsonPayload = Record<string, unknown>

export function measureSerializedJsonBytes(payload: JsonPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8')
}

export function measureTerminalOutputPayloadBytes(payload: JsonPayload): number {
  return measureSerializedJsonBytes(payload)
}
