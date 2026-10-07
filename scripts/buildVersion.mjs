export function buildVersion(base, git) {
  if (!git) return base
  if (!git.dirty && git.tags.includes(`v${base}`)) return base
  return `${base}+sha.${git.commit}${git.dirty ? '.dirty' : ''}`
}
