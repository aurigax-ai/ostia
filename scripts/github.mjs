export function githubRequest({ api, repository, token, fetchImpl = fetch, timeoutMs = 15_000 }) {
  if (!api || !repository || !token) {
    throw new Error('GITHUB_API_URL, GITHUB_REPOSITORY and GH_TOKEN must all be set')
  }
  return async (path, init = {}) => {
    const url = `${api.replace(/\/+$/, '')}/repos/${repository}/${path}`
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ostia-ci',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path} returned HTTP ${response.status}`)
    }
    return response.json()
  }
}

export function githubRequestFrom(env) {
  return githubRequest({
    api: env.GITHUB_API_URL,
    repository: env.GITHUB_REPOSITORY,
    token: env.GH_TOKEN,
  })
}
