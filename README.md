[![npm version](https://badge.fury.io/js/homebridge-mi-led-desk-lamp.svg)](https://badge.fury.io/js/homebridge-mi-led-desk-lamp)
# homebridge-mi-led-desk-lamp

Homebridge plugin for the Xiaomi Mi LED Desk Lamp (MJTD01YL). Fork of the original [moifort/homebridge-mi-led-desk-lamp](https://github.com/moifort/homebridge-mi-led-desk-lamp) with improved stability and Homebridge v2 support.

![mi](https://ae01.alicdn.com/kf/HTB1_8Uya7fb_uJkSne1q6zE4XXan/Original-Xiaomi-Mijia-LED-Desk-Lamp-Smart-Table-Lamps-Desklight-Support-Mobile-Phone-App-Control-4.jpg_640x640.jpg)

## Features

* Cache-first reads — HomeKit stays responsive without hammering the lamp
* Debounced slider commands — brightness/color temperature changes are batched
* Single-connection handshake — prevents UDP storms and handshake timeouts
* Automatic reconnection with exponential backoff
* Compatible with Homebridge v1.6+ and v2

## Get your token and IP

Good luck!!! (Because it's the hard part), some links to help you:

* https://github.com/jghaanstra/com.xiaomi-miio/blob/master/docs/obtain_token.md
* https://github.com/mediter/miio/blob/master/docs/ios-token-without-reset.md

## Installation

```
npm install -g homebridge-mi-led-desk-lamp
```

## Example Configuration

```json
{
  "bridge": {
    "name": "Homebridge",
    "username": "CC:22:3D:E3:CE:30",
    "port": 51826,
    "pin": "031-45-154"
  },
  "accessories": [
    {
      "accessory": "mi-led-desk-lamp",
      "name": "My desk lamp",
      "ip": "192.168.0.132",
      "token": "6591d0ad2003ddd2da75815f5d7def26"
    }
  ],
  "platforms": []
}
```

### Optional tuning

| Parameter | Default | Description |
|-----------|---------|-------------|
| `debounceMs` | 400 | Delay (ms) before sending brightness/color changes to avoid command spam while moving sliders |
| `commandTimeoutMs` | 8000 | Maximum wait (ms) for a device command before treating it as failed |
| `refreshOnGetCooldownMs` | 2000 | Minimum interval (ms) between background refreshes triggered by HomeKit get calls |
| `pollInterval` | 0 | Periodic state sync interval in seconds (0 = disabled, minimum 10). Useful to detect physical button or Mi Home app changes |

## Credits

Original plugin by [moifort](https://github.com/moifort).
