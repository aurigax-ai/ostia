let desktops: readonly string[] = []

export function currentDesktops(): readonly string[] {
  return desktops
}

export async function loadDesktops(): Promise<void> {
  try {
    desktops = (await window.ostia.info()).desktops
  } catch {
    desktops = []
  }
}
