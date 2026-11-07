/**
 * The dispatcher's leader gate.
 *
 * One DSH process must not reap/claim a project another process owns. The
 * durable lease lives in lease-registry.mjs; this gate is the small adapter the
 * dispatcher uses:
 *   - no lease configured -> leader (backwards compatible; direct users/tests);
 *   - a registry/factory -> claim before a tick, skip when refused;
 *   - release on dispose; a crash leaves the TTL to expire.
 *
 * It deliberately does not retry: a refused claim means another live host owns
 * the project; the next tick will try again.
 */
export function createLeaseGate(options) {
  const opts = options === undefined || options === null ? {} : options
  const leases = opts.leases === undefined ? null : opts.leases
  const owner = typeof opts.owner === 'string' && opts.owner !== '' ? opts.owner : 'host'
  const cache = new Map()
  const claimed = new Set()

  function registryFor(project) {
    if (leases === null) return null
    if (typeof leases !== 'function') return leases
    let registry = cache.get(project)
    if (registry === undefined) {
      registry = leases(project)
      cache.set(project, registry)
    }
    return registry
  }

  async function claim(project) {
    const registry = registryFor(project)
    if (registry === null || typeof registry.claim !== 'function') return { ok: true, leader: true, lease: null }
    const result = await registry.claim(project, owner)
    const leader = result !== null && result !== undefined && result.ok === true
    if (leader) claimed.add(project)
    return Object.assign({}, result, { leader: leader })
  }

  async function release(project) {
    const registry = registryFor(project)
    if (registry === null || typeof registry.release !== 'function') return { ok: true, action: 'none' }
    const result = await registry.release(project, owner)
    if (result !== null && result !== undefined && result.ok === true) claimed.delete(project)
    return result
  }

  function status(project) {
    const registry = project === null || project === undefined ? null : registryFor(project)
    if (registry === null || typeof registry.holder !== 'function') return null
    try {
      const result = registry.holder(project)
      if (result === null || result === undefined || result.ok !== true) return { error: result === null || result === undefined ? 'holder returned no result' : String(result.message || 'holder failed') }
      return { lease: result.lease, expired: result.expired === true, isOwner: result.lease !== null && result.lease.owner === owner }
    } catch (error) {
      return { error: String((error && error.message) || error) }
    }
  }

  async function releaseAll() {
    const projects = Array.from(claimed)
    claimed.clear()
    for (const project of projects) {
      try {
        await release(project)
      } catch (error) {}
    }
  }

  return { claim: claim, release: release, releaseAll: releaseAll, status: status, owner: owner }
}
