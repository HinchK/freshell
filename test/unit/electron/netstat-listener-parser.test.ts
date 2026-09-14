import { describe, expect, it } from 'vitest'
import { parseNetstatListeningPidsForPort } from '../../e2e-electron/netstat-listener-parser.js'

describe('parseNetstatListeningPidsForPort', () => {
  it('accepts exact local IPv4 and IPv6 listeners while deduplicating their PID', () => {
    const output = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:43000          0.0.0.0:0              LISTENING       101
  TCP    127.0.0.1:43000        0.0.0.0:0              LISTENING       101
  TCP    [::]:43000             [::]:0                 LISTENING       101
  TCP    [::1]:43000            [::]:0                 LISTENING       101
  TCP    127.0.0.1:43000        127.0.0.1:55123        ESTABLISHED     101
`

    expect(parseNetstatListeningPidsForPort(output, 43000)).toEqual([101])
  })

  it('rejects established, peer-only, suffix-port, and non-TCP rows', () => {
    const output = `
  TCP    0.0.0.0:143000         0.0.0.0:0              LISTENING       201
  TCP    127.0.0.1:43001        127.0.0.1:43000        ESTABLISHED     202
  TCP    127.0.0.1:43000        127.0.0.1:55123        ESTABLISHED     203
  UDP    0.0.0.0:43000          *:*                                    204
`

    expect(parseNetstatListeningPidsForPort(output, 43000)).toEqual([])
  })

  it('preserves multiple exact listener PIDs for the ownership check to reject as ambiguous', () => {
    const output = `
  TCP    0.0.0.0:43000          0.0.0.0:0              LISTENING       301
  TCP    [::]:43000             [::]:0                 LISTENING       302
`

    expect(parseNetstatListeningPidsForPort(output, 43000)).toEqual([301, 302])
  })
})
