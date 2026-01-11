# ioBroker Crypto Prices (CoinGecko) + Alerts + VIS Mini Widget

Fetch crypto prices from CoinGecko **without an API key**, write them to `0_userdata.0.*`, send **threshold alerts** via **SynoChat** (through an alias “send” datapoint), and render a compact **VIS mini widget** with colored up/down arrows based on 24h change.

## Features

- **Prices**: BTC / ETH / XRP in EUR or USD
- **States**: written to `0_userdata.0.Finance.Crypto.*`
- **Alerts**: below/above thresholds (edge-triggered)
  - Per-coin **cooldown** (prevents spam)
  - **Hysteresis** (prevents flapping near the threshold)
  - Optional “back to normal” message
- **VIS widget**: HTML output to `0_userdata.0.vis.Dashboards.FinanceCryptohtml`
  - Up/down/flat arrows
  - Different colors for rising/falling

## Requirements

- ioBroker with **JavaScript adapter v9.x**
- Internet access to `api.coingecko.com`
- Optional: SynoChat integration behind a **writeable alias “send” state**

## Installation (ioBroker)

1. Open **Scripts** in ioBroker (JavaScript adapter).
2. Create a new script, paste the content of:
   - `crypto_prices_coingecko_iobroker.js`
3. Adjust the configuration section (`CFG`) at the top:
   - `VS`: `eur` or `usd`
   - `ALERTS.SYNOCHAT_SEND_ID`: your SynoChat alias send datapoint
   - `ALERTS.THRESHOLDS`: your limits for BTC/ETH/XRP
4. Save and start the script.

The script will create all required `0_userdata.0.Finance.Crypto.*` states automatically.

## Configuration

### Quote currency

```js
VS: 'eur', // or 'usd'
```

### SynoChat alias state

Set your SynoChat alias datapoint ID here:

```js
ALERTS: {
  SYNOCHAT_SEND_ID: '0_userdata.0.Notifications.SynoChat.send',
}
```

This script sends messages using `ack=false` (required for many “send/command” states).

### Threshold alerts

Example:

```js
THRESHOLDS: {
  BTC: { low: 35000, high: 60000 },
  ETH: { low: 1800,  high: 3500  },
  XRP: { low: 0.40,  high: 0.90  },
},
```

- `low`: triggers if `price <= low`
- `high`: triggers if `price >= high`
- Use `null` to disable one side (e.g., only `high` alerts).

### Hysteresis and cooldown

```js
HYSTERESIS: { pct: 0.3, minAbs: 0.0 },
COOLDOWN_MIN: 15,
```

- Hysteresis means the price must move back by at least the configured gap before “re-arming”.
- Cooldown prevents multiple notifications in a short time.

## VIS Usage

The mini widget is written to:

- `0_userdata.0.vis.Dashboards.FinanceCryptohtml`

In VIS, use a widget that can render HTML from a string (for example a **basic string** widget configured to **not escape HTML**), and bind it to the state above.

## Data Points

### Prices

- `0_userdata.0.Finance.Crypto.BTC.price`
- `0_userdata.0.Finance.Crypto.BTC.change24hPct`
- (same for `ETH`, `XRP`)

### Alert state per coin

- `...<COIN>.alert.zone` (`below|normal|above|unknown`)
- `...<COIN>.alert.lastSent` (timestamp)
- `...<COIN>.alert.lastMsg`

### Meta

- `...meta.source`
- `...meta.lastUpdate`
- `...meta.lastOk`
- `...meta.lastError`

## Rate limits / reliability

CoinGecko is rate-limited. The script:
- polls every **60s** by default
- uses **exponential backoff** on HTTP `429`

If you experience frequent `429`, increase `INTERVAL_SEC` (e.g., 120s).

## Disclaimer

This project is for informational purposes only. Crypto prices can be delayed or inaccurate. Do not use it as the sole basis for trading decisions.

---

## Files

- `crypto_prices_coingecko_iobroker.js` – main ioBroker JavaScript script
- `README.md` – this documentation
