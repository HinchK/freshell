// Controlled SDK implementation for the FRESHELL_CLAUDE_SDK_QUERY_MODULE seam,
// pinning the unified attention gate's INTERRUPT ARM condition through the
// REAL sidecar process (task-004 review F-I1). Two behaviors matter:
//  - `interrupt()` ALWAYS RESOLVES. The SDK contract documents RESOLUTION —
//    not rejection — for interrupting with nothing in flight
//    (sdk.d.ts:2384-2394: "Interrupt the current query execution ... Older
//    CLIs resolve to `undefined`"), so an idle-session interrupt settles
//    ok:true with no result to consume and must arm NO mark.
//  - `__hold__` parks that turn's `result` until an interrupt() call (the
//    park is released on a macrotask so the settle receipt — a microtask —
//    lands BEFORE the result: the sdk.d.ts:3765 ordering the gate depends
//    on). Robust to the send and the interrupt crossing in the same stdin
//    chunk (the park not yet established when interrupt() runs): the
//    interrupt REQUEST is latched, and a park established after the request
//    releases itself.
let interruptRequested = false
let heldResolve = null

export function query({ prompt, options }) {
  const queue = []
  let waiting
  const push = (message) => { queue.push(message); waiting?.(); waiting = undefined }
  push({
    type: 'system',
    subtype: 'init',
    session_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    model: options.model,
    cwd: options.cwd,
    tools: [],
  })
  void (async () => {
    for await (const message of prompt) {
      const text = message.message.content[0]?.text
      if (text === '__hold__') {
        await new Promise((resolve) => {
          heldResolve = resolve
          if (interruptRequested) {
            setTimeout(resolve, 0)
          }
        })
        heldResolve = null
        push({ type: 'result', subtype: 'error_during_execution', errors: ['Interrupted by user'] })
      } else {
        push({ type: 'result', subtype: 'success' })
      }
    }
  })()
  const iterator = (async function* () {
    for (;;) {
      if (queue.length) yield queue.shift()
      else await new Promise((resolve) => { waiting = resolve })
    }
  })()
  return Object.assign(iterator, {
    interrupt: async () => {
      interruptRequested = true
      if (heldResolve) {
        const resolve = heldResolve
        heldResolve = null
        setTimeout(() => resolve(), 0)
      }
    },
    close: () => {},
  })
}
