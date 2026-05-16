'use strict'

// ── Mock helpers ──

function createMockDevice(overrides = {}) {
  const listeners = {}
  return {
    power: jest.fn().mockResolvedValue(true),
    brightness: jest.fn().mockResolvedValue(75),
    color: jest.fn().mockResolvedValue({ values: [4000] }),
    call: jest.fn().mockResolvedValue(null),
    destroy: jest.fn(),
    on: jest.fn((event, handler) => {
      listeners[event] = handler
    }),
    emit(event, ...args) {
      if (listeners[event]) listeners[event](...args)
    },
    ...overrides
  }
}

let mockDevice
jest.mock('miio', () => ({
  device: jest.fn(() => Promise.resolve(mockDevice))
}))

function createMockCharacteristic() {
  return {
    onGet: jest.fn().mockReturnThis(),
    onSet: jest.fn().mockReturnThis(),
    updateValue: jest.fn().mockReturnThis()
  }
}

function createMockHomebridge() {
  const chars = {
    On: createMockCharacteristic(),
    Brightness: createMockCharacteristic(),
    ColorTemperature: createMockCharacteristic()
  }

  const Service = jest.fn().mockImplementation(() => ({
    getCharacteristic: jest.fn(type => chars[type._name])
  }))

  Service.Lightbulb = Service

  const Characteristic = {
    On: { _name: 'On' },
    Brightness: { _name: 'Brightness' },
    ColorTemperature: { _name: 'ColorTemperature' }
  }

  return {
    hap: { Service, Characteristic },
    registerAccessory: jest.fn(),
    _chars: chars
  }
}

// ── Setup ──

const miio = require('miio')
const plugin = require('./index')

let homebridge, lamp, log, chars

function createLamp(configOverrides = {}) {
  homebridge = createMockHomebridge()
  plugin(homebridge)

  chars = homebridge._chars
  log = jest.fn()
  log.error = jest.fn()

  const Ctor = homebridge.registerAccessory.mock.calls[0][2]

  return new Ctor(log, {
    name: 'Test lamp',
    ip: '192.168.1.100',
    token: 'abcdef1234567890',
    debounceMs: 50,
    commandTimeoutMs: 2000,
    refreshOnGetCooldownMs: 100,
    ...configOverrides
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  mockDevice = createMockDevice()
  lamp = createLamp()
})

afterEach(() => {
  jest.useRealTimers()
  jest.clearAllMocks()
})

// ── Tests ──

describe('constructor', () => {
  test('registers accessory with correct name', () => {
    expect(homebridge.registerAccessory).toHaveBeenCalledWith(
      'homebridge-mi-led-desk-lamp',
      'mi-led-desk-lamp',
      expect.any(Function)
    )
  })

  test('sets default config values', () => {
    expect(lamp.debounceMs).toBe(50)
    expect(lamp.commandTimeoutMs).toBe(2000)
    expect(lamp.refreshOnGetCooldownMs).toBe(100)
  })

  test('handles missing ip gracefully', () => {
    const badLamp = createLamp({ ip: undefined })
    expect(log).toHaveBeenCalledWith('No IP address defined for', 'Test lamp')
    expect(badLamp.lamp).toBeUndefined()
  })

  test('handles missing token gracefully', () => {
    const badLamp = createLamp({ token: undefined })
    expect(log).toHaveBeenCalledWith('No token defined for', 'Test lamp')
    expect(badLamp.lamp).toBeUndefined()
  })

  test('validates config numbers, falls back to defaults on NaN', () => {
    const l = createLamp({ debounceMs: 'notanumber', commandTimeoutMs: undefined })
    expect(l.debounceMs).toBe(400)
    expect(l.commandTimeoutMs).toBe(8000)
  })

  test('enforces minimum commandTimeoutMs of 1000', () => {
    const l = createLamp({ commandTimeoutMs: 100 })
    expect(l.commandTimeoutMs).toBe(1000)
  })
})

describe('getLamp — single connection handshake', () => {
  test('connects to device via miio', async () => {
    const device = await lamp.getLamp()
    expect(miio.device).toHaveBeenCalledWith({
      address: '192.168.1.100',
      token: 'abcdef1234567890'
    })
    expect(device).toBe(mockDevice)
  })

  test('reuses existing device without reconnecting', async () => {
    await lamp.getLamp()
    await lamp.getLamp()
    await lamp.getLamp()
    expect(miio.device).toHaveBeenCalledTimes(1)
  })

  test('serializes concurrent connection attempts', async () => {
    const p1 = lamp.getLamp()
    const p2 = lamp.getLamp()
    const p3 = lamp.getLamp()
    const [d1, d2, d3] = await Promise.all([p1, p2, p3])
    expect(miio.device).toHaveBeenCalledTimes(1)
    expect(d1).toBe(d2)
    expect(d2).toBe(d3)
  })

  test('returns undefined on connection failure', async () => {
    miio.device.mockRejectedValueOnce(new Error('timeout'))
    lamp.lampDevice = undefined
    const device = await lamp.getLamp()
    expect(device).toBeUndefined()
    expect(log.error).toHaveBeenCalledWith('Device not connected', expect.any(Error))
  })

  test('attaches event listeners on new device', async () => {
    await lamp.getLamp()
    expect(mockDevice.on).toHaveBeenCalledWith('powerChanged', expect.any(Function))
    expect(mockDevice.on).toHaveBeenCalledWith('brightnessChanged', expect.any(Function))
    expect(mockDevice.on).toHaveBeenCalledWith('colorChanged', expect.any(Function))
  })
})

describe('event listeners update cache', () => {
  beforeEach(async () => {
    await lamp.getLamp()
  })

  test('powerChanged updates cache and characteristic', () => {
    mockDevice.emit('powerChanged', true)
    expect(lamp.cache.power).toBe(true)
    expect(chars.On.updateValue).toHaveBeenCalledWith(true)
  })

  test('brightnessChanged updates cache and characteristic', () => {
    mockDevice.emit('brightnessChanged', 42)
    expect(lamp.cache.brightness).toBe(42)
    expect(chars.Brightness.updateValue).toHaveBeenCalledWith(42)
  })

  test('colorChanged updates cache and characteristic', () => {
    mockDevice.emit('colorChanged', { values: [5000] })
    expect(lamp.cache.mired).toBe(200)
    expect(chars.ColorTemperature.updateValue).toHaveBeenCalledWith(200)
  })
})

describe('dropDevice + reconnect re-attaches listeners', () => {
  test('destroys device and clears references', async () => {
    await lamp.getLamp()
    lamp.dropDevice()
    expect(mockDevice.destroy).toHaveBeenCalled()
    expect(lamp.lampDevice).toBeUndefined()
    expect(lamp.boundDevice).toBeNull()
  })

  test('re-attaches listeners after reconnect', async () => {
    await lamp.getLamp()
    lamp.dropDevice()

    const newDevice = createMockDevice()
    mockDevice = newDevice
    miio.device.mockResolvedValueOnce(newDevice)

    await lamp.getLamp()
    expect(newDevice.on).toHaveBeenCalledWith('powerChanged', expect.any(Function))
  })
})

describe('cache-first GETs', () => {
  test('getState returns cached power immediately', async () => {
    lamp.cache.power = true
    const result = await lamp.getState()
    expect(result).toBe(true)
  })

  test('getBrightness returns cached brightness', async () => {
    lamp.cache.brightness = 55
    const result = await lamp.getBrightness()
    expect(result).toBe(55)
  })

  test('getColorTemperature returns cached mired', async () => {
    lamp.cache.mired = 250
    const result = await lamp.getColorTemperature()
    expect(result).toBe(250)
  })
})

describe('refreshNow — rate-limited background refresh', () => {
  beforeEach(async () => {
    await lamp.getLamp()
  })

  test('fetches real state and updates cache', async () => {
    jest.advanceTimersByTime(200)
    const result = await lamp.refreshNow()
    expect(result).toBe(true)
    expect(lamp.cache.power).toBe(true)
    expect(lamp.cache.brightness).toBe(75)
    expect(lamp.cache.mired).toBe(250)
  })

  test('skips refresh if already in flight', async () => {
    jest.advanceTimersByTime(200)
    lamp.refreshInFlight = true
    const result = await lamp.refreshNow()
    expect(result).toBe(false)
    expect(mockDevice.power).not.toHaveBeenCalled()
  })

  test('skips refresh if within cooldown period', async () => {
    jest.advanceTimersByTime(200)
    await lamp.refreshNow()
    mockDevice.power.mockClear()

    const result = await lamp.refreshNow()
    expect(result).toBe(false)
    expect(mockDevice.power).not.toHaveBeenCalled()
  })

  test('allows refresh after cooldown expires', async () => {
    jest.advanceTimersByTime(200)
    await lamp.refreshNow()
    mockDevice.power.mockClear()

    jest.advanceTimersByTime(200)
    const result = await lamp.refreshNow()
    expect(result).toBe(true)
    expect(mockDevice.power).toHaveBeenCalled()
  })

  test('drops device on refresh error', async () => {
    jest.advanceTimersByTime(200)
    mockDevice.power.mockRejectedValueOnce(new Error('fail'))
    await lamp.refreshNow()
    expect(lamp.lampDevice).toBeUndefined()
    expect(log.error).toHaveBeenCalledWith('Error refreshing lamp state', expect.any(Error))
  })
})

describe('setState — direct command', () => {
  beforeEach(async () => {
    await lamp.getLamp()
  })

  test('sends power command and updates cache', async () => {
    await lamp.setState(true)
    expect(mockDevice.power).toHaveBeenCalledWith(true)
    expect(lamp.cache.power).toBe(true)
  })

  test('throws on device failure', async () => {
    mockDevice.power.mockRejectedValueOnce(new Error('offline'))
    await expect(lamp.setState(false)).rejects.toThrow('offline')
    expect(lamp.lampDevice).toBeUndefined()
  })

  test('throws when no device available', async () => {
    lamp.dropDevice()
    miio.device.mockRejectedValueOnce(new Error('fail'))
    await expect(lamp.setState(true)).rejects.toThrow('Device not connected')
  })
})

describe('setBrightness — debounced', () => {
  test('updates cache immediately, does not call device', async () => {
    await lamp.setBrightness(60)
    expect(lamp.cache.brightness).toBe(60)
    expect(lamp.pending.brightness).toBe(60)
    expect(mockDevice.brightness).not.toHaveBeenCalledWith('60')
  })

  test('clamps values to 1-100', async () => {
    await lamp.setBrightness(0)
    expect(lamp.cache.brightness).toBe(1)

    await lamp.setBrightness(150)
    expect(lamp.cache.brightness).toBe(100)
  })

  test('rejects NaN', async () => {
    await expect(lamp.setBrightness('abc')).rejects.toThrow('Invalid brightness value')
  })

  test('flushes after debounce delay', async () => {
    await lamp.getLamp()
    await lamp.setBrightness(80)

    jest.advanceTimersByTime(50)
    await Promise.resolve()
    await Promise.resolve()

    expect(mockDevice.brightness).toHaveBeenCalledWith('80')
  })

  test('only sends last value when slider moves rapidly', async () => {
    await lamp.getLamp()
    await lamp.setBrightness(30)
    await lamp.setBrightness(50)
    await lamp.setBrightness(70)

    jest.advanceTimersByTime(50)
    await Promise.resolve()
    await Promise.resolve()

    expect(mockDevice.brightness).toHaveBeenCalledTimes(1)
    expect(mockDevice.brightness).toHaveBeenCalledWith('70')
  })
})

describe('setColorTemperature — debounced', () => {
  test('updates cache immediately', async () => {
    await lamp.setColorTemperature(300)
    expect(lamp.cache.mired).toBe(300)
    expect(lamp.pending.mired).toBe(300)
  })

  test('clamps values to 153-500', async () => {
    await lamp.setColorTemperature(50)
    expect(lamp.cache.mired).toBe(153)

    await lamp.setColorTemperature(999)
    expect(lamp.cache.mired).toBe(500)
  })

  test('rejects NaN', async () => {
    await expect(lamp.setColorTemperature('abc')).rejects.toThrow('Invalid color temperature value')
  })

  test('sends set_ct_abx with kelvin conversion after debounce', async () => {
    await lamp.getLamp()
    await lamp.setColorTemperature(370)

    jest.advanceTimersByTime(50)
    await Promise.resolve()
    await Promise.resolve()

    expect(mockDevice.call).toHaveBeenCalledWith(
      'set_ct_abx',
      [2703, 'smooth', 300]
    )
  })
})

describe('flushPending — retry with backoff', () => {
  test('retries on device unavailable', async () => {
    lamp.dropDevice()
    miio.device.mockRejectedValue(new Error('fail'))

    await lamp.setBrightness(50)
    jest.advanceTimersByTime(50)

    // Let flushPending -> getLamp -> catch chain resolve
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(lamp.flushRetries).toBe(1)
    expect(lamp.pending.brightness).toBe(50)
  })

  test('abandons after max retries', async () => {
    lamp.dropDevice()
    miio.device.mockRejectedValue(new Error('fail'))
    lamp.flushRetries = 5
    lamp.pending.brightness = 50

    lamp.scheduleFlush()

    expect(log.error).toHaveBeenCalledWith(
      'Flush abandoned after', 5, 'retries — pending changes dropped'
    )
    expect(lamp.pending.brightness).toBeNull()
  })

  test('resets retry counter on successful flush', async () => {
    await lamp.getLamp()
    lamp.flushRetries = 3

    await lamp.setBrightness(50)
    jest.advanceTimersByTime(50)
    await Promise.resolve()
    await Promise.resolve()

    expect(lamp.flushRetries).toBe(0)
  })

  test('re-queues pending values on command error', async () => {
    await lamp.getLamp()
    mockDevice.brightness.mockRejectedValueOnce(new Error('fail'))

    await lamp.setBrightness(50)
    jest.advanceTimersByTime(50)

    // Let flushPending -> withTimeout -> catch chain resolve
    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(lamp.pending.brightness).toBe(50)
    expect(lamp.flushRetries).toBe(1)
  })
})

describe('withTimeout', () => {
  test('returns value on success', async () => {
    const result = await lamp.withTimeout(Promise.resolve(42), 'test')
    expect(result).toBe(42)
  })

  test('throws on timeout', async () => {
    const slow = new Promise(() => {})
    const p = lamp.withTimeout(slow, 'test')

    jest.advanceTimersByTime(2000)
    await expect(p).rejects.toThrow('test timeout')
  })
})

describe('getServices', () => {
  test('returns array with lamp service', () => {
    const services = lamp.getServices()
    expect(services).toHaveLength(1)
    expect(services[0]).toBeDefined()
  })
})

describe('pollInterval — optional periodic sync', () => {
  test('does not create poll timer by default (0)', () => {
    expect(lamp.pollIntervalMs).toBe(0)
    expect(lamp.pollTimer).toBeUndefined()
  })

  test('creates poll timer when pollInterval is set', () => {
    const pollingLamp = createLamp({ pollInterval: 60 })
    expect(pollingLamp.pollIntervalMs).toBe(60000)
    expect(pollingLamp.pollTimer).toBeDefined()
    clearInterval(pollingLamp.pollTimer)
  })

  test('enforces minimum of 10 seconds', () => {
    const pollingLamp = createLamp({ pollInterval: 3 })
    expect(pollingLamp.pollIntervalMs).toBe(10000)
    clearInterval(pollingLamp.pollTimer)
  })

  test('ignores invalid values', () => {
    const pollingLamp = createLamp({ pollInterval: 'abc' })
    expect(pollingLamp.pollIntervalMs).toBe(0)
    expect(pollingLamp.pollTimer).toBeUndefined()
  })

  test('triggers refreshNow on interval tick', () => {
    const pollingLamp = createLamp({ pollInterval: 60 })
    const spy = jest.spyOn(pollingLamp, 'refreshNow').mockResolvedValue(true)

    jest.advanceTimersByTime(60000)

    expect(spy).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(60000)

    expect(spy).toHaveBeenCalledTimes(2)

    spy.mockRestore()
    clearInterval(pollingLamp.pollTimer)
  })
})
