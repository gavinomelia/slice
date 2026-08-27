const REPO = `{
  "review": {
  }
}
`

const USER = `{
  "theme": {
    "preset": "dark"
  }
}
`

export const configTemplate = (scope) => (scope === 'user' ? USER : REPO)
