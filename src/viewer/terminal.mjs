const OSC_BACKGROUND = /\x1b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i
const DEVICE_ATTRIBUTES = /\x1b\[\?[\d;]*c/

export function parseBackground(reply) {
  const match = OSC_BACKGROUND.exec(reply)
  if (!match) return null
  const [r, g, b] = match.slice(1, 4).map((hex) => Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255))
  return { r, g, b }
}

export function queryBackground({ input = process.stdin, output = process.stdout, timeoutMs = 500 } = {}) {
  if (!input.isTTY || !output.isTTY || process.env.TERM === 'dumb') return Promise.resolve(null)

  return new Promise((done) => {
    let reply = ''
    const wasRaw = input.isRaw

    const finish = () => {
      clearTimeout(timer)
      input.off('data', onData)
      input.setRawMode(wasRaw)
      input.pause()
      done(parseBackground(reply))
    }

    const onData = (chunk) => {
      reply += chunk.toString('latin1')
      if (DEVICE_ATTRIBUTES.test(reply)) finish()
    }

    const timer = setTimeout(finish, timeoutMs)
    input.setRawMode(true)
    input.on('data', onData)
    input.resume()
    output.write('\x1b]11;?\x1b\\\x1b[c')
  })
}
