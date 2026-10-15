export interface MountEntry {
  mountPoint: string
  fsType: string
  source: string
}

const SYSTEM_FS_TYPES = new Set([
  'adfs',
  'afs',
  'auto',
  'autofs',
  'autofs4',
  'cgroup',
  'cgroup2',
  'configfs',
  'cxfs',
  'debugfs',
  'devfs',
  'devpts',
  'devtmpfs',
  'ecryptfs',
  'efivarfs',
  'fdescfs',
  'fusectl',
  'gfs',
  'gfs2',
  'gpfs',
  'hugetlbfs',
  'kernfs',
  'linprocfs',
  'linsysfs',
  'lustre',
  'lustre_lite',
  'mfs',
  'mqueue',
  'ncpfs',
  'nfsd',
  'nullfs',
  'ocfs2',
  'overlay',
  'proc',
  'procfs',
  'pstore',
  'ptyfs',
  'rootfs',
  'rpc_pipefs',
  'securityfs',
  'selinuxfs',
  'sysfs',
  'tmpfs',
  'usbfs',
])

const SYSTEM_MOUNT_PATHS = new Set([
  '/',
  '/bin',
  '/boot',
  '/compat/linux/proc',
  '/compat/linux/sys',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib64',
  '/libexec',
  '/live/cow',
  '/live/image',
  '/media',
  '/mnt',
  '/opt',
  '/rescue',
  '/root',
  '/sbin',
  '/srv',
  '/tmp',
  '/usr',
  '/usr/X11R6',
  '/usr/local',
  '/usr/obj',
  '/usr/ports',
  '/usr/src',
  '/usr/xobj',
  '/var',
  '/var/crash',
  '/var/local',
  '/var/log',
  '/var/log/audit',
  '/var/mail',
  '/var/run',
  '/var/tmp',
  '/proc',
  '/net',
  '/sys',
  '/run',
])

const SYSTEM_MOUNT_PREFIXES = ['/dev/', '/proc/', '/sys/']

const SYSTEM_DEVICES = ['proc', 'devfs', 'devpts', 'sysfs', '/dev/loop', '/dev/vn']

function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  )
}

export function parseMountInfo(text: string): MountEntry[] {
  return text.split('\n').flatMap((line) => {
    const [mounted, rest] = line.split(' - ')
    if (!mounted || !rest) return []
    const fields = mounted.split(' ')
    const [fsType, source] = rest.split(' ')
    if (fields.length < 5 || !fsType || source === undefined) return []
    return [
      { mountPoint: unescapeMountField(fields[4]), fsType, source: unescapeMountField(source) },
    ]
  })
}

export function isSystemInternal(mount: MountEntry): boolean {
  const path = mount.mountPoint
  return (
    SYSTEM_FS_TYPES.has(mount.fsType) ||
    SYSTEM_MOUNT_PATHS.has(path) ||
    SYSTEM_MOUNT_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    path.endsWith('/.gvfs') ||
    SYSTEM_DEVICES.some((device) => mount.source === device || mount.source.startsWith(device))
  )
}

export function userMountAt(mounts: readonly MountEntry[], path: string): MountEntry | null {
  const mount = mounts.findLast((entry) => entry.mountPoint === path)
  return mount && !isSystemInternal(mount) ? mount : null
}

export function mountAllowsTrash(mountInfo: string, path: string): boolean {
  return userMountAt(parseMountInfo(mountInfo), path) !== null
}
