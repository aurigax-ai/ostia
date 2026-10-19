import { chmodSync, existsSync, readFileSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import { type Rule, type RuleDraft, type RuleOrigin, parseRulesFile } from './rule'

export const RULES_FILE = 'rules.json'

export class RulesStore {
  private file: string | null
  private next = 1
  private rules: Rule[] = []
  private kept: string | null = null

  constructor(
    dir: string | null,
    private readonly now: () => number,
  ) {
    this.file = dir ? join(dir, RULES_FILE) : null
    if (this.file && existsSync(this.file)) {
      const parsed = parseRulesFile(readFileSync(this.file, 'utf8'))
      if (parsed) {
        this.next = parsed.next
        this.rules = parsed.rules
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

  add(draft: RuleDraft, origin: RuleOrigin): Rule {
    const rule: Rule = {
      id: `r${this.next}`,
      rule: draft.rule.trim(),
      why: draft.why.trim(),
      when: draft.when.trim(),
      scope: draft.scope,
      state: 'active',
      origin,
      createdAt: this.now(),
    }
    this.next += 1
    this.rules.push(rule)
    this.save()
    return { ...rule }
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
    rule.state = state
    this.save()
    return true
  }

  remove(id: string): boolean {
    const before = this.rules.length
    this.rules = this.rules.filter((r) => r.id !== id)
    if (this.rules.length === before) return false
    this.save()
    return true
  }

  private save(): void {
    if (!this.file) return
    writeFileAtomic(this.file, JSON.stringify({ next: this.next, rules: this.rules }, null, 2), {
      mode: 0o600,
      dirMode: 0o700,
    })
    chmodSync(this.file, 0o600)
  }
}
