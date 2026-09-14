import { describe, expect, it } from 'vitest'
import { parseSsListeningPidsForPort } from '../../e2e-electron/ss-listener-parser.js'

describe('parseSsListeningPidsForPort', () => {
  it('accepts the app-bound fixture default wildcard listener and supported loopback forms', () => {
    const output = `State  Recv-Q Send-Q Local Address:Port Peer Address:PortProcess
LISTEN 0      4096   0.0.0.0:43000      0.0.0.0:*    users:(("freshell-server",pid=101,fd=3))
LISTEN 0      4096   *:43000            *:*          users:(("freshell-server",pid=102,fd=3))
LISTEN 0      4096   127.0.0.1:43000    0.0.0.0:*    users:(("freshell-server",pid=103,fd=3))
LISTEN 0      4096   [::]:43000         [::]:*       users:(("freshell-server",pid=104,fd=3))
LISTEN 0      4096   :::43000           :::*         users:(("freshell-server",pid=105,fd=3))
LISTEN 0      4096   [::1]:43000        [::]:*       users:(("freshell-server",pid=106,fd=3))`

    expect(parseSsListeningPidsForPort(output, 43000)).toEqual([101, 102, 103, 104, 105, 106])
  })

  it('matches only the exact local listener port, never a suffix port or peer address', () => {
    const output = `State  Recv-Q Send-Q Local Address:Port Peer Address:PortProcess
LISTEN 0      4096   0.0.0.0:143000     0.0.0.0:*    users:(("other",pid=201,fd=3))
LISTEN 0      4096   127.0.0.1:43001    127.0.0.1:43000 users:(("other",pid=202,fd=3))
ESTAB  0      0      127.0.0.1:43000    127.0.0.1:55555 users:(("other",pid=203,fd=3))
LISTEN 0      4096   127.0.0.1:43000    0.0.0.0:*    users:(("freshell-server",pid=204,fd=3))`

    expect(parseSsListeningPidsForPort(output, 43000)).toEqual([204])
  })
})
