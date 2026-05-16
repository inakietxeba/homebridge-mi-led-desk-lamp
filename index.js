'use strict'

const miio = require('miio')
let Service, Characteristic

module.exports = function (homebridge) {
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic

  homebridge.registerAccessory(
    'homebridge-mi-led-desk-lamp',
    'mi-led-desk-lamp',
    MiLedDesklamp
  )
}

class MiLedDesklamp {
  constructor(log, config) {
    this.log = log
    this.name = config['name'] || 'Mi desk lamp'

    if (!config['ip']) {
      this.log('No IP address defined for', this.name)
      return
    }

    if (!config['token']) {
      this.log('No token defined for', this.name)
      return
    }

    this.ip = config['ip']
    this.token = String(config['token']).trim()

    // Ajustes anti-spam
    const debounceMs = Number(config['debounceMs'])
    const commandTimeoutMs = Number(config['commandTimeoutMs'])
    const refreshOnGetCooldownMs = Number(config['refreshOnGetCooldownMs'])

    this.debounceMs = Number.isFinite(debounceMs)
      ? Math.max(0, Math.round(debounceMs))
      : 400

    this.commandTimeoutMs = Number.isFinite(commandTimeoutMs)
      ? Math.max(1000, Math.round(commandTimeoutMs))
      : 8000

    this.refreshOnGetCooldownMs = Number.isFinite(refreshOnGetCooldownMs)
      ? Math.max(0, Math.round(refreshOnGetCooldownMs))
      : 2000

    // Caché local
    this.cache = {
      power: false,
      brightness: 100,
      mired: 370
    }

    this.lampDevice = undefined
    this.connecting = null
    this.boundDevice = null

    this.pending = {
      brightness: null,
      mired: null
    }

    this.flushTimer = null
    this.flushRetries = 0
    this.maxFlushRetries = 5
    this.refreshInFlight = false
    this.lastRefreshRequestAt = 0

    this.lamp = new Service.Lightbulb(this.name)

    this.lamp
      .getCharacteristic(Characteristic.On)
      .onGet(this.getState.bind(this))
      .onSet(this.setState.bind(this))

    this.lamp
      .getCharacteristic(Characteristic.Brightness)
      .onGet(this.getBrightness.bind(this))
      .onSet(this.setBrightness.bind(this))

    this.lamp
      .getCharacteristic(Characteristic.ColorTemperature)
      .onGet(this.getColorTemperature.bind(this))
      .onSet(this.setColorTemperature.bind(this))

    this.getLamp().catch(() => {})
  }

  async withTimeout(promise, label) {
    let timer

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timeout`)),
        this.commandTimeoutMs
      )
    })

    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  dropDevice() {
    try {
      if (this.lampDevice && this.lampDevice.destroy) {
        this.lampDevice.destroy()
      }
    } catch {}

    this.lampDevice = undefined
    this.boundDevice = null
  }

  async getLamp() {
    if (this.lampDevice) return this.lampDevice
    if (this.connecting) return this.connecting

    this.log('Connect to device')

    this.connecting = miio
      .device({
        address: this.ip,
        token: this.token
      })
      .then(device => {
        const isNewDevice = this.lampDevice !== device
        this.lampDevice = device

        if (isNewDevice) {
          this.attachLampStateListeners(device)
        }

        return device
      })
      .catch(error => {
        this.lampDevice = undefined
        this.log.error('Device not connected', error)
        return undefined
      })
      .finally(() => {
        this.connecting = null
      })

    return this.connecting
  }

  attachLampStateListeners(device) {
    if (!device || this.boundDevice === device) return

    this.boundDevice = device

    try {
      device.on('powerChanged', isOn => {
        this.cache.power = !!isOn
        this.lamp
          .getCharacteristic(Characteristic.On)
          .updateValue(!!isOn)
      })

      device.on('brightnessChanged', brightness => {
        this.cache.brightness = brightness
        this.lamp
          .getCharacteristic(Characteristic.Brightness)
          .updateValue(brightness)
      })

      device.on('colorChanged', color => {
        const mired = Math.round(1000000 / color.values[0])
        this.cache.mired = mired
        this.lamp
          .getCharacteristic(Characteristic.ColorTemperature)
          .updateValue(mired)
      })
    } catch (error) {
      this.log.error('Error listening lamp state', error)
    }
  }

  async refreshNow() {
    const now = Date.now()

    if (this.refreshInFlight) return
    if (now - this.lastRefreshRequestAt < this.refreshOnGetCooldownMs) return

    this.lastRefreshRequestAt = now
    this.refreshInFlight = true

    try {
      const device = await this.getLamp()
      if (!device) return

      const power = await this.withTimeout(
        Promise.resolve(device.power()),
        'getPower'
      )

      this.cache.power = !!power
      this.lamp
        .getCharacteristic(Characteristic.On)
        .updateValue(!!power)

      const brightness = await this.withTimeout(
        Promise.resolve(device.brightness()),
        'getBrightness'
      )

      this.cache.brightness = brightness
      this.lamp
        .getCharacteristic(Characteristic.Brightness)
        .updateValue(brightness)

      const color = await this.withTimeout(
        Promise.resolve(device.color()),
        'getColor'
      )

      const mired = Math.round(1000000 / color.values[0])
      this.cache.mired = mired
      this.lamp
        .getCharacteristic(Characteristic.ColorTemperature)
        .updateValue(mired)
    } catch (error) {
      this.log.error('Error refreshing lamp state', error)
      this.dropDevice()
    } finally {
      this.refreshInFlight = false
    }
  }

  scheduleFlush() {
    if (this.flushTimer) return

    if (this.flushRetries >= this.maxFlushRetries) {
      this.log.error('Flush abandoned after', this.flushRetries, 'retries — pending changes dropped')
      this.pending.brightness = null
      this.pending.mired = null
      this.flushRetries = 0
      return
    }

    const delay = this.flushRetries === 0
      ? this.debounceMs
      : Math.min(this.debounceMs * Math.pow(2, this.flushRetries), 30000)

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushPending().catch(error => {
        this.log.error('Error flushing pending changes', error)
      })
    }, delay)
  }

  async flushPending() {
    const brightness = this.pending.brightness
    const mired = this.pending.mired

    if (brightness === null && mired === null) return

    const device = await this.getLamp()
    if (!device) {
      this.flushRetries++
      this.scheduleFlush()
      return
    }

    this.flushRetries = 0

    try {
      if (brightness !== null) {
        const value = Math.max(1, Math.min(100, Math.round(brightness)))

        await this.withTimeout(
          Promise.resolve(device.brightness(String(value))),
          'setBrightness'
        )

        this.cache.brightness = value
        this.lamp
          .getCharacteristic(Characteristic.Brightness)
          .updateValue(value)

        if (this.pending.brightness === brightness) {
          this.pending.brightness = null
        }
      }

      if (mired !== null) {
        let kelvin = Math.round(1000000 / mired)
        kelvin = Math.max(Math.min(kelvin, 6500), 2700)

        await this.withTimeout(
          Promise.resolve(device.call('set_ct_abx', [kelvin, 'smooth', 300])),
          'setColorTemperature'
        )

        const finalMired = Math.round(1000000 / kelvin)
        this.cache.mired = finalMired
        this.lamp
          .getCharacteristic(Characteristic.ColorTemperature)
          .updateValue(finalMired)

        if (this.pending.mired === mired) {
          this.pending.mired = null
        }
      }
    } catch (error) {
      this.log.error('Error applying pending changes', error)

      if (brightness !== null && this.pending.brightness === null) {
        this.pending.brightness = brightness
      }

      if (mired !== null && this.pending.mired === null) {
        this.pending.mired = mired
      }

      this.flushRetries++
      this.dropDevice()
      this.scheduleFlush()
    }
  }

  async getState() {
    this.refreshNow().catch(() => {})
    return !!this.cache.power
  }

  async getBrightness() {
    this.refreshNow().catch(() => {})
    return this.cache.brightness
  }

  async getColorTemperature() {
    this.refreshNow().catch(() => {})
    return this.cache.mired
  }

  async setState(state) {
    const device = await this.getLamp()
    if (!device) throw new Error('Device not connected')

    try {
      await this.withTimeout(
        Promise.resolve(device.power(!!state)),
        'setPower'
      )

      this.cache.power = !!state
    } catch (error) {
      this.log.error('Error setting state', error)
      this.dropDevice()
      throw error
    }
  }

  async setBrightness(state) {
    const numericState = Number(state)

    if (!Number.isFinite(numericState)) {
      throw new Error('Invalid brightness value')
    }

    const value = Math.max(1, Math.min(100, Math.round(numericState)))

    this.cache.brightness = value
    this.pending.brightness = value
    this.flushRetries = 0
    this.scheduleFlush()
  }

  async setColorTemperature(miredValue) {
    const numericValue = Number(miredValue)

    if (!Number.isFinite(numericValue)) {
      throw new Error('Invalid color temperature value')
    }

    const value = Math.max(153, Math.min(500, Math.round(numericValue)))

    this.cache.mired = value
    this.pending.mired = value
    this.flushRetries = 0
    this.scheduleFlush()
  }

  getServices() {
    return [this.lamp]
  }
}