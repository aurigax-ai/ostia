const ENGLISH =
  /\b(?:no|not|never|don'?t|do not|doesn'?t|didn'?t|stop|instead|again|always|prefer|rather|avoid|without|shouldn'?t|should not|must not|told you|i said|as i said|last time|every time|each time)\b/i

const CHINESE =
  /不要|別再|別|不用|不必|不能|不是|永遠|總是|一律|每次|已經說過|說過|改用|請勿|避免|不該|又|再次/

export function looksLikeCorrection(text: string): boolean {
  return ENGLISH.test(text) || CHINESE.test(text)
}
