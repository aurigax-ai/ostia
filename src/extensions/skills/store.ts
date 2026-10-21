import { chmodSync, existsSync, readFileSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import {
  parseRulesFile,
  type Rule,
  type RuleDraft,
  type RuleOrigin,
  type RuleState,
  type StoredGroup,
} from './rule'

export interface RuleExtras {
  state?: RuleState
  evidence?: string[]
  conflicts?: string[]
}

export const RULES_FILE = 'rules.json'

export class RulesStore {
  private file: string | null
  private next = 1
  private rules: Rule[] = []
  private kept: string | null = null
  private held: StoredGroup[] = []
  private ignored = new Set<string>()

  constructor(
    dir: string | null,
    private readonly now: () => number,
    private readonly beforeOf: (rule: Rule) => Rule['before'] = () => undefined,
  ) {
    this.file = dir ? join(dir, RULES_FILE) : null
    if (this.file && existsSync(this.file)) {
      const parsed = parseRulesFile(readFileSync(this.file, 'utf8'))
      if (parsed) {
        this.next = parsed.next
        this.rules = parsed.rules
        this.held = parsed.groups
        this.ignored = new Set(parsed.dismissed)
      } else {
        const aside = `${this.file}.corrupt-${this.now()}`
        renameSync(this.file, aside)
        chmodSync(aside, 0o600)
        this.kept = aside
      }
    }
  }

  get unreadable(): string | null {
    return this.kept ? basename(this.kept) : null
  }

  acceptUnreadable(): void {
    this.kept = null
  }

  list(): Rule[] {
    return this.rules.map((r) => ({ ...r }))
  }

  get(id: string): Rule | undefined {
    return this.rules.find((r) => r.id === id)
  }

  groups(): StoredGroup[] {
    return this.held.map((g) => ({ ...g, signals: [...g.signals], words: [...g.words] }))
  }

  dismissedSignals(): ReadonlySet<string> {
    return this.ignored
  }

  replaceGroups(groups: Omit<StoredGroup, 'id'>[]): void {
    this.held = groups.map((g, i) => ({ ...g, id: `g${i + 1}` }))
    this.save()
  }

  dismissGroup(id: string): boolean {
    const group = this.held.find((g) => g.id === id)
    if (!group) return false
    for (const signal of group.signals) this.ignored.add(signal)
    this.held = this.held.filter((g) => g.id !== id)
    this.save()
    return true
  }

  takeGroup(id: string): StoredGroup | undefined {
    const group = this.held.find((g) => g.id === id)
    if (group) this.held = this.held.filter((g) => g.id !== id)
    return group
  }

  add(draft: RuleDraft, origin: RuleOrigin, extras: RuleExtras = {}): Rule {
    const rule: Rule = {
      id: `r${this.next}`,
      rule: draft.rule.trim(),
      why: draft.why.trim(),
      when: draft.when.trim(),
      scope: draft.scope,
      state: extras.state ?? 'active',
      origin,
      createdAt: this.now(),
      ...(extras.evidence?.length ? { evidence: [...extras.evidence] } : {}),
    }
    this.next += 1
    if (rule.state === 'active') this.stamp(rule)
    this.rules.push(rule)
    for (const other of extras.conflicts ?? []) this.link(rule.id, other)
    this.save()
    return { ...(this.get(rule.id) as Rule) }
  }

  addEvidence(id: string, signals: readonly string[]): boolean {
    const rule = this.get(id)
    if (!rule) return false
    rule.evidence = [...new Set([...(rule.evidence ?? []), ...signals])]
    this.save()
    return true
  }

  approve(id: string): boolean {
    const rule = this.get(id)
    if (rule?.state !== 'proposed') return false
    rule.state = 'active'
    this.stamp(rule)
    this.save()
    return true
  }

  resolve(keep: string, retire: string): boolean {
    const kept = this.get(keep)
    const gone = this.get(retire)
    if (!kept || !gone || keep === retire) return false
    gone.state = 'retired'
    this.unlink(keep, retire)
    if (kept.state === 'proposed' && !kept.conflicts?.length) {
      kept.state = 'active'
      this.stamp(kept)
    }
    this.save()
    return true
  }

  private stamp(rule: Rule): void {
    rule.approvedAt = this.now()
    rule.before = this.beforeOf(rule)
  }

  keepBoth(id: string): boolean {
    const rule = this.get(id)
    if (!rule) return false
    for (const other of rule.conflicts ?? []) this.unlink(id, other)
    this.save()
    return true
  }

  private link(a: string, b: string): void {
    const first = this.get(a)
    const second = this.get(b)
    if (!first || !second || a === b) return
    first.conflicts = [...new Set([...(first.conflicts ?? []), b])]
    second.conflicts = [...new Set([...(second.conflicts ?? []), a])]
  }

  private unlink(a: string, b: string): void {
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      const rule = this.get(from)
      if (!rule?.conflicts) continue
      const rest = rule.conflicts.filter((id) => id !== to)
      if (rest.length > 0) rule.conflicts = rest
      else rule.conflicts = undefined
    }
  }

  update(id: string, draft: RuleDraft): boolean {
    const rule = this.get(id)
    if (!rule) return false
    rule.rule = draft.rule.trim()
    rule.why = draft.why.trim()
    rule.when = draft.when.trim()
    rule.scope = draft.scope
    this.save()
    return true
  }

  setState(id: string, state: Rule['state']): boolean {
    const rule = this.get(id)
    if (!rule) return false
    if (state === 'active' && rule.conflicts?.length) return false
    const was = rule.state
    rule.state = state
    if (state === 'active' && was !== 'active') this.stamp(rule)
    this.save()
    return true
  }

  remove(id: string): boolean {
    const before = this.rules.length
    for (const other of this.get(id)?.conflicts ?? []) this.unlink(id, other)
    this.rules = this.rules.filter((r) => r.id !== id)
    if (this.rules.length === before) return false
    this.save()
    return true
  }

  private save(): void {
    if (!this.file) return
    writeFileAtomic(
      this.file,
      JSON.stringify(
        { next: this.next, rules: this.rules, groups: this.held, dismissed: [...this.ignored] },
        null,
        2,
      ),
      {
        mode: 0o600,
        dirMode: 0o700,
      },
    )
    chmodSync(this.file, 0o600)
  }
}
