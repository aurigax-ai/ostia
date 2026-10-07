export const PHONE_BASE_CAPS = ['read', 'notify'] as const

export const PHONE_GRANTABLE_CAPS = ['respond', 'command', 'input', 'destructive'] as const

export type PhoneGrantableCap = (typeof PHONE_GRANTABLE_CAPS)[number]

export type PhoneCap = (typeof PHONE_BASE_CAPS)[number] | PhoneGrantableCap
