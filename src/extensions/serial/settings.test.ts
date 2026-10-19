import { describe, expect, it } from 'vitest'
import {
  deviceGlobs,
  frameText,
  isSerialDevice,
  listDevices,
  parseFrame,
  parseSpeed,
  sttyArgs,
} from './settings'

const DEV = [
  'cu.Bluetooth-Incoming-Port',
  'cu.usbserial-A10K2',
  'cu.usbmodem1101',
  'tty.usbserial-A10K2',
  'ttyUSB10',
  'ttyUSB2',
  'ttyACM0',
  'ttyS0',
  'disk0',
  'null',
]

describe('serial device list', () => {
  it('lists /dev/cu.* on macOS, USB adapters first', () => {
    expect(listDevices('darwin', () => DEV)).toEqual([
      '/dev/cu.usbmodem1101',
      '/dev/cu.usbserial-A10K2',
      '/dev/cu.Bluetooth-Incoming-Port',
    ])
  })

  it('lists /dev/ttyUSB* and /dev/ttyACM* on Linux in numeric order', () => {
    expect(listDevices('linux', () => DEV)).toEqual([
      '/dev/ttyACM0',
      '/dev/ttyUSB2',
      '/dev/ttyUSB10',
    ])
  })

  it('lists nothing on other platforms or when /dev cannot be read', () => {
    expect(listDevices('win32', () => DEV)).toEqual([])
    expect(
      listDevices('linux', () => {
        throw new Error('EACCES')
      }),
    ).toEqual([])
    expect(deviceGlobs('win32')).toEqual([])
    expect(deviceGlobs('linux')).toEqual(['/dev/ttyUSB*', '/dev/ttyACM*'])
  })

  it('accepts only serial device paths of the platform', () => {
    expect(isSerialDevice('/dev/cu.usbserial-A10K2', 'darwin')).toBe(true)
    expect(isSerialDevice('/dev/tty.usbserial-A10K2', 'darwin')).toBe(false)
    expect(isSerialDevice('/dev/cu.usbserial-A10K2', 'linux')).toBe(false)
    expect(isSerialDevice('/dev/ttyUSB0', 'linux')).toBe(true)
    expect(isSerialDevice('/dev/ttyACM3', 'linux')).toBe(true)
    expect(isSerialDevice('/dev/ttyS0', 'linux')).toBe(false)
    expect(isSerialDevice('/dev/../dev/ttyUSB0', 'linux')).toBe(false)
    expect(isSerialDevice('/dev/cu.x;reboot', 'darwin')).toBe(false)
    expect(isSerialDevice('/dev/sda', 'linux')).toBe(false)
  })
})

describe('serial line settings', () => {
  it('takes the standard speeds only', () => {
    expect(parseSpeed('115200')).toBe(115200)
    expect(parseSpeed(' 9600 ')).toBe(9600)
    expect(parseSpeed('921600')).toBe(921600)
    for (const bad of ['', '0', '115201', '-9600', '9600.0', '1e5', 'fast', '99999999']) {
      expect(parseSpeed(bad), bad).toBeNull()
    }
  })

  it('parses a frame of data bits, parity and stop bits', () => {
    expect(parseFrame('8N1')).toEqual({ dataBits: 8, parity: 'none', stopBits: 1 })
    expect(parseFrame('7e1')).toEqual({ dataBits: 7, parity: 'even', stopBits: 1 })
    expect(parseFrame(' 5O2 ')).toEqual({ dataBits: 5, parity: 'odd', stopBits: 2 })
    for (const bad of ['', '8N', '9N1', '4N1', '8X1', '8N3', '8N1x', '8-N-1']) {
      expect(parseFrame(bad), bad).toBeNull()
    }
    expect(frameText({ dataBits: 7, parity: 'even', stopBits: 2 })).toBe('7E2')
  })

  it('builds stty arguments that set raw mode first and the frame after it', () => {
    const args = sttyArgs({ speed: 115200, frame: { dataBits: 8, parity: 'none', stopBits: 1 } })
    expect(args[0]).toBe('raw')
    expect(args).toEqual([
      'raw',
      '-echo',
      '-iexten',
      '-ixon',
      '-ixoff',
      '115200',
      'cs8',
      '-parenb',
      '-cstopb',
      'clocal',
      'cread',
      '-crtscts',
      'min',
      '1',
      'time',
      '0',
    ])
    expect(sttyArgs({ speed: 9600, frame: { dataBits: 7, parity: 'even', stopBits: 2 } })).toEqual(
      expect.arrayContaining(['9600', 'cs7', 'parenb', '-parodd', 'cstopb']),
    )
    const odd = sttyArgs({ speed: 9600, frame: { dataBits: 7, parity: 'odd', stopBits: 1 } })
    expect(odd).toEqual(expect.arrayContaining(['parenb', 'parodd', '-cstopb']))
    expect(odd).not.toContain('-parenb')
  })
})
