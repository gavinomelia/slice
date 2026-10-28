const OSC_COLOR = (slot) => new RegExp(`\\x1b\\]${slot};rgba?:([0-9a-f]{1,4})\\/([0-9a-f]{1,4})\\/([0-9a-f]{1,4})`, 'i')
const DEVICE_ATTRIBUTES = /\x1b\[\?[\d;]*c/

function parseColor(reply, slot) {
  const match = OSC_COLOR(slot).exec(reply)
  if (!match) return null
  const [r, g, b] = match.slice(1, 4).map((hex) => Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255))
  return { r, g, b }
}

export const parseColors = (reply) => ({ foreground: parseColor(reply, 10), background: parseColor(reply, 11) })

export function queryColors({ input = process.stdin, output = process.stdout, timeoutMs = 500 } = {}) {
  if (!input.isTTY || !output.isTTY || process.env.TERM === 'dumb') {
    return Promise.resolve({ foreground: null, background: null })
  }

  return new Promise((done) => {
    let reply = ''
    const wasRaw = input.isRaw

    const finish = () => {
      clearTimeout(timer)
      input.off('data', onData)
      input.setRawMode(wasRaw)
      input.pause()
      done(parseColors(reply))
    }

    const onData = (chunk) => {
      reply += chunk.toString('latin1')
      if (DEVICE_ATTRIBUTES.test(reply)) finish()
    }

    const timer = setTimeout(finish, timeoutMs)
    input.setRawMode(true)
    input.on('data', onData)
    input.resume()
    output.write('\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[c')
  })
}
